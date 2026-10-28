import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent_provenance_backend"))
import app
import inference
import semantics
from abstraction import build_views
from provenance import build_recorded_graph, call_flow, normalize_calls
from models import ModelResponseError


def trace(identifier, include_rank=False):
    suffix = identifier.upper()
    calls = [
        {"id": f"register-{suffix}", "name": "register", "args": {"table": "/private/source.csv"},
         "response": {"id": f"registration-{identifier}", "rows": [{"name": "PRIVATE_TABLE_CONTENT"}]}},
        {"id": f"pick-a-{suffix}", "name": "pick", "args": {"input": f"registration-{identifier}", "query": "VERY_SECRET_QUERY"},
         "response": {"id": f"candidate-a-{identifier}"}},
        {"id": f"pick-b-{suffix}", "name": "pick", "args": {"input": f"registration-{identifier}", "query": "VERY_SECRET_QUERY"},
         "response": {"id": f"candidate-b-{identifier}"}},
        {"id": f"intersect-{suffix}", "name": "intersect",
         "args": {"inputs": [f"candidate-a-{identifier}", f"candidate-b-{identifier}"]},
         "response": {"id": f"intersection-{identifier}"}},
        {"id": f"filter-{suffix}", "name": "filter", "args": {"input": f"intersection-{identifier}", "value": 17},
         "response": {"id": f"filtered-artifact-{identifier}"}},
        {"id": f"preview-{suffix}", "name": "preview", "args": {"input": f"filtered-artifact-{identifier}"},
         "response": {"ok": True}},
        {"id": f"validate-{suffix}", "name": "validate", "args": {"input": f"filtered-artifact-{identifier}"},
         "status": "error", "response": {"error": "validation failed"}},
    ]
    if include_rank:
        calls.append({"id": f"rank-{suffix}", "name": "rank", "args": {"method": "weighted", "input": "rank-input"},
                      "response": {"url": "https://private.invalid/resource"}})
    return {"traceId": identifier, "taskId": "task", "taskDescription": "Find candidates",
            "score": 987654321, "scoreMetric": "private_metric", "targetCallIds": [f"filter-{suffix}"],
            "finalOutput": f"See filtered-artifact-{identifier}", "toolCalls": calls}


def fake_plan(prompt):
    payload = json.loads(prompt.rsplit("\n", 1)[-1])
    aliases = {item["id"]: item["tool"] for item in payload["types"]}
    result = {"stages": [], "absorb": [], "omit": []}
    grouped = []
    for alias, tool in aliases.items():
        if tool in {"register", "preview", "validate"}:
            result["omit"].append(alias)
        elif tool == "filter":
            result["absorb"].append({"types": [alias], "toward": "inputs", "label": "Refine candidate set"})
        elif tool == "rank":
            result["stages"].append({"key": "ranking", "label": "Rank candidates", "attention": "key", "types": [alias]})
        else:
            grouped.append(alias)
    if grouped:
        result["stages"].append({"key": "candidate_selection", "label": "Select candidate set",
                                 "attention": "key", "types": grouped})
    return result


@pytest.fixture
def offline(monkeypatch, tmp_path):
    monkeypatch.setattr(app, "CACHE_DIR", tmp_path / "app-cache")
    monkeypatch.setattr(semantics, "CACHE_DIR", tmp_path / "annotation-cache")
    prompts = []

    async def infer(prompt, tier="semantic"):
        assert tier == "semantic"
        prompts.append(prompt)
        return fake_plan(prompt)

    monkeypatch.setattr(semantics, "infer_json", infer)
    return prompts


def test_selection_uses_one_batch_across_traces_and_reuses_cached_annotation(offline):
    entries = [trace("a", include_rank=False), trace("b", include_rank=True)]
    analyses, cached = asyncio.run(app.analyze_selection(entries))
    assert not cached
    graph, annotation_cached = asyncio.run(app.comparison_view(analyses, [], {}, detail="overview"))
    assert not annotation_cached
    assert len(offline) == 1
    assert graph["alignment"]["mode"] == "tool-signature"
    again, cached = asyncio.run(app.analyze_selection(entries))
    assert cached
    _, annotation_cached = asyncio.run(app.comparison_view(again, [], {}, detail="overview"))
    assert annotation_cached and len(offline) == 1


def test_plan_keeps_key_decisions_separate_hides_routine_and_preserves_failure(offline):
    analysis, _ = asyncio.run(app.analyze_trace(trace("a")))
    graph, _ = asyncio.run(app.comparison_view([analysis], [], {}, detail="overview"))
    instances = [instance for node in graph["nodes"] for instance in node["instances"]]
    calls_by_stage = {instance["id"]: {call["id"] for call in instance["calls"]} for instance in instances}
    for cid in ('pick-a-A', 'pick-b-A', 'intersect-A', 'filter-A'):
        assert {cid} in calls_by_stage.values()
    key_nodes = [node for node in graph['nodes'] if node['importance']['semantic']['level'] == 'key']
    assert all(node['importance']['decision'] == 'expand' for node in key_nodes)
    failure = next(calls for calls in calls_by_stage.values() if "validate-A" in calls)
    assert failure == {"validate-A"}
    source = next(node for node in graph['nodes'] if node.get('source'))
    assert source['source']['label'] == 'source.csv'
    assert any('register-A' in calls for calls in calls_by_stage.values())
    assert not any(item['id'] == 'register-A' for item in graph['omittedCalls'])
    assert any(item["id"] == "preview-A" for item in graph["omittedCalls"])
    target = next(node for node in graph["nodes"] if any("filter-A" in {c["id"] for c in i["calls"]}
                                                         for i in node["instances"]))
    variant = target["variants"][0]
    assert {item["kind"] for item in variant["targetEvidence"]} == {"explicit", "final_reference"}
    assert target["resultBackbone"] is True


def test_model_context_is_compact_and_excludes_results_urls_tables_and_scores(offline):
    entries = [trace("private-run", include_rank=True)]
    analyses, _ = asyncio.run(app.analyze_selection(entries))
    asyncio.run(app.comparison_view(analyses, [], {}, detail="overview", focus="candidate"))
    prompt = offline[0]
    for secret in ["PRIVATE_TABLE_CONTENT", "VERY_SECRET_QUERY", "987654321", "private_metric",
                   "private.invalid", "registration-private-run", "candidate-a-private-run"]:
        assert secret not in prompt
    payload = json.loads(prompt.rsplit("\n", 1)[-1])
    assert len(payload["types"]) < len(entries[0]["toolCalls"])
    assert all(set(item) <= {"id", "tool", "argumentShape", "criteria", "inputsFrom", "outputsTo"}
               for item in payload["types"])


def test_invalid_model_assignment_fails_without_caching(offline, monkeypatch, tmp_path):
    monkeypatch.setattr(semantics, "CACHE_DIR", tmp_path / "bad-cache")
    async def incomplete(prompt, tier="semantic"):
        payload = json.loads(prompt.rsplit("\n", 1)[-1])
        first = payload["types"][0]["id"]
        return {"stages": [{"key": "only_one", "label": "One stage", "attention": "key", "types": [first]}],
                "absorb": [], "omit": []}
    monkeypatch.setattr(semantics, "infer_json", incomplete)
    analysis, _ = asyncio.run(app.analyze_trace(trace("invalid")))
    with pytest.raises(ModelResponseError, match="omitted operation types"):
        asyncio.run(semantics.annotate_types([analysis]))
    assert not list((tmp_path / "bad-cache" / "annotations").glob("*.json"))


def test_api_keeps_model_failures_separate_from_invalid_user_targets(offline, monkeypatch):
    from fastapi.testclient import TestClient
    client = TestClient(app.app)
    entry = trace('api')
    assert client.post('/api/prov-graph', json=entry).status_code == 200
    assert not offline  # Source graph generation never needs semantic inference.
    entry['targetCallIds'] = ['unknown-call']
    response = client.post('/api/joined-provenance-graph', json={'graphs': [entry]})
    assert response.status_code == 422 and not offline
    entry['targetCallIds'] = []

    async def invalid(prompt):
        return {'stages': [], 'absorb': [], 'omit': []}
    monkeypatch.setattr(semantics, 'infer_json', invalid)
    response = client.post('/api/joined-provenance-graph', json={'graphs': [entry]})
    assert response.status_code == 502
    assert 'omitted operation types' in response.text


def test_large_type_catalogue_is_bounded_and_new_selections_send_only_novel_types(offline):
    entry = {'traceId': 'many-types', 'toolCalls': [
        {'name': f'operation_{index}', 'args': {'value': 1}, 'response': None}
        for index in range(70)]}
    analysis, _ = asyncio.run(app.analyze_trace(entry))
    asyncio.run(semantics.annotate_types([analysis]))
    sizes = [len(json.loads(prompt.rsplit('\n', 1)[-1])['types']) for prompt in offline]
    assert sizes == [64, 6]
    asyncio.run(semantics.annotate_types([analysis]))
    assert len(offline) == 2
    extra, _ = asyncio.run(app.analyze_trace({'traceId': 'extra', 'toolCalls': [
        {'name': 'new_operation', 'args': {}, 'response': None}]}))
    asyncio.run(semantics.annotate_types([analysis, extra]))
    assert len(offline) == 3
    assert len(json.loads(offline[-1].rsplit('\n', 1)[-1])['types']) == 1


def test_independent_same_stage_occurrences_do_not_merge_across_a_refinement(offline):
    # Filter B refines the second analysis; it must not make analyses A and B
    # one occurrence merely because both use the same reusable stage rule.
    entry = {'traceId': 'separate', 'toolCalls': [
        {'id': 'a', 'name': 'rank', 'args': {'method': 'weighted'}, 'response': {'id': 'ranked-A'}},
        {'id': 'filter', 'name': 'filter', 'args': {'input': 'source-B'}, 'response': {'id': 'filtered-B'}},
        {'id': 'b', 'name': 'rank', 'args': {'method': 'weighted', 'input': 'filtered-B'}, 'response': None}]}
    analysis, _ = asyncio.run(app.analyze_trace(entry))
    types, assignments = semantics.operation_types(analysis)
    rules = {kind: {'action': 'group', 'stage': 'rank', 'label': 'Rank candidates', 'attention': 'key'} for kind in types}
    rules[assignments['filter']] = {'action': 'absorb', 'toward': 'outputs', 'label': 'Prepare ranking', 'attention': 'supporting'}
    result = semantics.instantiate(analysis, {'rules': rules, 'version': 'test'})
    assert {frozenset(instance['callIds']) for instance in result['instances']} == {
        frozenset({'a'}), frozenset({'filter'}), frozenset({'b'})}


def test_selected_result_cannot_be_hidden_by_an_omit_rule(offline):
    entry = trace('target')
    entry['targetCallIds'] = ['preview-TARGET']
    entry['finalOutput'] = ''
    analysis, _ = asyncio.run(app.analyze_trace(entry))
    graph, _ = asyncio.run(app.comparison_view([analysis], [], {}, detail='overview'))
    result = next(node for node in graph['nodes'] if any(
        call['id'] == 'preview-TARGET' for instance in node['instances'] for call in instance['calls']))
    assert result['importance']['tier'] == 'result'
    assert not any(call['id'] == 'preview-TARGET' for call in graph['omittedCalls'])


def test_reviewed_dependencies_reach_abstraction_before_instance_alignment(offline, monkeypatch):
    analysis, _ = asyncio.run(app.analyze_trace(trace('review-order')))
    source, target = 'pick-a-REVIEW-ORDER', 'rank-REVIEW-ORDER'
    # Use an existing consumer with an additional, separately cited semantic source.
    target = 'filter-REVIEW-ORDER'
    link = {'sourceCallId': source, 'targetCallId': target, 'inferred': True,
            'relevance': 'relevant',
            'relation': 'semantic_context', 'reason': 'The earlier candidate motivates this selection.',
            'evidence': [{'callId': source, 'field': 'response', 'path': ''},
                         {'callId': target, 'field': 'args', 'path': ''}]}

    async def reviewed(analyses, focus=''):
        return {'version': 'test-review', 'cached': True, 'runs': [{
            'traceId': analysis['traceId'], 'events': {}, 'links': [link], 'jointGroups': [],
            'resultEvidence': {'run': analysis['traceId'], 'claims': [], 'status': 'missing-final'},
            'reviewedActivities': 0, 'suppliedActivities': 0, 'totalActivities': len(analysis['calls'])}]}

    real_instantiate = app.instantiate
    seen = []

    def instantiate_with_review(entry, policy):
        seen.extend(edge for edge in entry['flow'] if edge.get('inferred'))
        return real_instantiate(entry, policy)

    monkeypatch.setattr(app, 'review_traces', reviewed)
    monkeypatch.setattr(app, 'instantiate', instantiate_with_review)
    graph, _ = asyncio.run(app.comparison_view([analysis], [], {}, detail='overview'))
    assert [(edge['source'], edge['target']) for edge in seen] == [(source, target)]
    assert any(w['inferred'] and w['callPath'] == [source, target]
               for edge in graph['edges'] for w in edge['witnesses'])


def test_final_output_resource_references_require_token_boundaries():
    analysis = {"calls": [{"id": "partial", "response": {"id": "result-101"}},
                           {"id": "exact", "response": {"path": "file-202"}}],
               "finalOutput": "The note mentions result-1010, while the saved file-202."}
    resolved = semantics.resolve_targets(analysis)
    assert resolved["targets"] == ["exact"]
    assert resolved["targetEvidence"] == [{"callId": "exact",
                                             "reason": "Final output explicitly references this artifact",
                                             "kind": "final_reference", "sourceField": "response",
                                             "sourcePath": "/path"}]


def test_failed_occurrence_cannot_contaminate_successful_same_type_family():
    calls = normalize_calls([
        {"id": "healthy", "name": "same_tool", "args": {"limit": 4}, "response": {"ok": True}},
        {"id": "failed", "name": "same_tool", "args": {"limit": 7}, "status": "error",
         "response": {"error": "recorded failure"}},
    ], "failure-isolation")
    kinds, _ = semantics.operation_types({"calls": calls, "flow": []})
    kind = next(iter(kinds))
    policy = {"version": "test-policy", "rules": {
        kind: {"action": "group", "stage": "same_stage", "label": "Same operation", "attention": "supporting"}}}
    instances = semantics.instantiate({"traceId": "failure-isolation", "calls": calls,
                                        "flow": [], "targets": []}, policy)["instances"]
    assert len(instances) == 2
    healthy = next(instance for instance in instances if instance["callIds"] == ["healthy"])
    failed = next(instance for instance in instances if instance["callIds"] == ["failed"])
    assert healthy["familyId"] != failed["familyId"]
    assert healthy["diagnostics"] == []
    assert failed["diagnostics"][0]["recorded"] is True


def test_code_and_query_sketch_distinguishes_operations_but_masks_payloads():
    commands = [
        "SELECT score FROM patients_a GROUP BY score -- secret comment\nWHERE score > 7",
        "select value from patients_b group by value where value > 99",
        "UPDATE patients_c SET score = 'private literal'",
    ]
    calls = [{"id": str(index), "tool": "execute_sql", "args": {"query": command}, "response": None,
              "status": "ok", "timeIndex": index} for index, command in enumerate(commands)]
    sql = semantics.operation_types({"calls": calls, "flow": []})[0]
    assert len(sql) == 2
    select_type = next(item for item in sql.values() if "select" in item["argumentShape"]["query"]["operationSketch"])
    sketch = select_type["argumentShape"]["query"]["operationSketch"]
    assert sketch == ["select", "from", "group", "by", "where"]
    assert select_type["criteria"]["query"]["operationSketch"] == sketch
    serialized = json.dumps(sql)
    for secret in ("patients_a", "patients_b", "patients_c", "private literal", "secret comment", "score > 7"):
        assert secret not in serialized


def test_code_calls_shell_programs_and_natural_queries_are_bounded_cues():
    calls = [
        {"id": "read", "tool": "run_code", "args": {"code": "df = read_csv('/private/secret.csv'); df.merge(other).plot()"},
         "response": None, "status": "ok", "timeIndex": 0},
        {"id": "other-read", "tool": "run_code", "args": {"code": "df = read_csv('/other/path.csv'); df.merge(other).plot()"},
         "response": None, "status": "ok", "timeIndex": 1},
        {"id": "shell-cat", "tool": "run", "args": {"command": "cat /private/secret.txt"},
         "response": None, "status": "ok", "timeIndex": 2},
        {"id": "shell-test", "tool": "run", "args": {"command": "pytest tests/test_hidden.py"},
         "response": None, "status": "ok", "timeIndex": 3},
        {"id": "query", "tool": "search", "args": {"query": "Please summarize the relevant records for me"},
         "response": None, "status": "ok", "timeIndex": 4},
    ]
    types = semantics.operation_types({"calls": calls, "flow": []})[0]
    code_sketch = next(item for item in types.values() if item["tool"] == "run_code")["criteria"]["code"]["operationSketch"]
    assert code_sketch == ["read_csv", "merge", "plot"]
    assert {item["criteria"]["command"]["operationSketch"][0] for item in types.values()
            if item["tool"] == "run"} == {"program:cat", "program:pytest"}
    query_type = next(item for item in types.values() if item["tool"] == "search")
    assert query_type["criteria"]["query"] == "<text>"
    assert "/private/secret" not in json.dumps(types)


def test_external_source_roots_keep_distinct_visible_families_and_absorb_reads():
    def source_analysis(trace_id, names=("MS.csv", "Ribo.csv")):
        calls = normalize_calls([
            {"id": "ms", "name": "load", "args": {"name": names[0], "source_url": "https://private.invalid/data/MS.csv?signature=secret"},
             "response": {"id": f"ms-{trace_id}"}},
            {"id": "ribo", "name": "load", "args": {"name": names[1], "source_url": "https://private.invalid/data/Ribo.csv?signature=secret"},
             "response": {"id": f"ribo-{trace_id}"}},
            {"id": "read-ms", "name": "read", "args": {"id": f"ms-{trace_id}"}, "response": {"rows": 1}},
            {"id": "read-ribo", "name": "read", "args": {"id": f"ribo-{trace_id}"}, "response": {"rows": 1}},
            {"id": "filter-ms", "name": "filter", "args": {"csv_id": f"ms-{trace_id}"},
             "response": {"storage_entry": {"id": f"filtered-ms-{trace_id}"}}},
            {"id": "filter-ribo", "name": "filter", "args": {"csv_id": f"ribo-{trace_id}"},
             "response": {"storage_entry": {"id": f"filtered-ribo-{trace_id}"}}},
            {"id": "join", "name": "join", "args": {"left": f"filtered-ms-{trace_id}",
                                                          "right": f"filtered-ribo-{trace_id}"},
             "response": {"id": f"joined-{trace_id}"}},
            {"id": "lookup", "name": "gene_info", "args": {"gene_list": ["GENE1"]},
             "response": {"results": []}},
        ], trace_id)
        graph = build_recorded_graph(calls)
        flow = call_flow(graph)
        analysis = {"traceId": trace_id, "calls": calls, "flow": flow, "targets": []}
        types, _ = semantics.operation_types(analysis)
        rules = {}
        for kind, item in types.items():
            if item["tool"] == "load":
                rules[kind] = {"action": "group", "stage": "external_input", "label": "External input"}
            elif item["tool"] == "read":
                rules[kind] = {"action": "omit", "stage": "background", "label": "Background"}
            elif item["tool"] == "gene_info":
                rules[kind] = {"action": "group", "stage": "lookup", "label": "Lookup"}
            else:
                rules[kind] = {"action": "group", "stage": "selection", "label": "Select and combine"}
        for rule in rules.values():
            rule['attention'] = 'supporting'
        return semantics.instantiate(analysis, {"rules": rules, "version": "source-test"})["instances"]

    first = source_analysis("source-a")
    second = source_analysis("source-b", names=("MS dataset", "Ribo dataset"))
    sourced = [instance for instance in first if "source" in instance]
    assert len(sourced) == 2
    assert {instance["source"]["label"] for instance in sourced} == {"MS.csv", "Ribo.csv"}
    assert {tuple(instance["callIds"]) for instance in sourced} == {
        ("ms", "read-ms"), ("ribo", "read-ribo")}
    assert all(instance["display"] == "show" for instance in sourced)
    assert len({instance["familyId"] for instance in sourced}) == 2
    assert [instance["source"]["identity"] for instance in sourced] == [
        instance["source"]["identity"] for instance in second if "source" in instance]
    assert {instance["familyId"] for instance in sourced} == {
        instance["familyId"] for instance in second if "source" in instance}
    assert all("private.invalid" not in json.dumps(instance["source"]) for instance in sourced)
    selection = next(instance for instance in first if "filter-ms" in instance["callIds"])
    assert set(selection["callIds"]) == {"filter-ms", "filter-ribo", "join"}
    assert {call_id for instance in first for call_id in instance["callIds"]} == {
        "ms", "ribo", "read-ms", "read-ribo", "filter-ms", "filter-ribo", "join", "lookup"}
    assert all("source" not in instance for instance in first if "lookup" in instance["callIds"])


def test_semantic_attention_expands_key_stages_but_keeps_supporting_ancestors_collapsed():
    calls = normalize_calls([
        {"id": "prepare", "name": "prepare_input", "args": {}, "response": {"id": "prepared"}},
        {"id": "analysis", "name": "analyze", "args": {"input": "prepared"}, "response": {"id": "result"}},
        {"id": "rank", "name": "rank", "args": {}, "response": {"id": "ranking"}},
    ], "attention")
    types, _ = semantics.operation_types({"calls": calls, "flow": []})
    policy = {"version": "attention-test", "rules": {
        kind: {"action": "group", "stage": item["tool"], "label": item["tool"].title(),
               "attention": "supporting" if item["tool"] == "prepare_input" else "key"}
        for kind, item in types.items()}}
    enriched = semantics.instantiate({"traceId": "attention", "calls": calls,
                                      "flow": [{"source": "prepare", "target": "analysis", "inferred": False}],
                                      "targets": ["analysis"],
                                      "targetEvidence": [{"callId": "analysis", "kind": "explicit"}]}, policy)
    graph = build_views([enriched], [], {}, detail="overview")
    nodes = {node["semanticRole"]: node for node in graph["nodes"]}
    assert nodes["prepare_input"]["attention"] == "supporting"
    assert nodes["prepare_input"]["importance"]["decision"] == "collapse"
    assert nodes["prepare_input"]["importance"]["tier"] == "context"
    assert nodes["prepare_input"]["instances"][0]["resultBackbone"] is True
    assert nodes["rank"]["attention"] == "key"
    assert nodes["rank"]["importance"]["decision"] == "expand"
    assert nodes["rank"]["importance"]["tier"] == "key"
    assert nodes["analyze"]["importance"]["tier"] == "result"


def test_stage_attention_is_required_by_pattern_schema():
    with pytest.raises(ModelResponseError, match="attention set to key or supporting"):
        semantics._validate_plan({"stages": [{"key": "analysis", "label": "Analysis", "types": ["t0"]}],
                                  "absorb": [], "omit": []}, {"t0"}, {})


@pytest.mark.parametrize('args', [{'payload': {'location': 's3://bucket/data.csv?signature=private'}}, '/workspace/data.csv'])
def test_external_input_detection_does_not_depend_on_tool_or_argument_names(args):
    source = semantics._external_source({'tool': 'arbitrary_loader', 'args': args})
    assert source == {'label': 'data.csv', 'canonical': 'data.csv'}
