import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent_provenance_backend"))
from abstraction import _entity_ports, _operation_groups
from provenance import build_recorded_graph, call_flow, normalize_calls, project_dependencies


def test_inferred_context_is_not_presented_as_a_recorded_entity_input():
    calls = normalize_calls([
        {'id': 'original', 'tool': 'load', 'args': {}, 'response': {'id': 'primary'}},
        {'id': 'filtered', 'tool': 'transform', 'args': {'input_id': 'primary'},
         'response': {'id': 'secondary'}},
        {'id': 'consumer', 'tool': 'project', 'args': {'input_id': 'primary'},
         'response': {'id': 'selected'}},
    ], 'prov-ports')
    graph = build_recorded_graph(calls)
    flow = call_flow(graph) + [{'source': 'filtered', 'target': 'consumer',
        'inferred': True, 'relation': 'semantic_context'}]
    analysis = {'traceId': 'prov-ports', 'calls': calls, 'graph': graph, 'flow': flow}
    inputs, outputs = _entity_ports(analysis)
    assert set(inputs['consumer']) == set(outputs['original'])
    assert not set(inputs['consumer']) & set(outputs['filtered'])
    projected = project_dependencies(analysis)
    assert any(edge.get('inferred') and edge.get('eventRelation') == 'semantic_context'
               for edge in projected['edges'])
    assert analysis['flow'] == flow


def _analysis(trace, threshold, alias, columns, how):
    raw = [
        {"id": "ms", "tool": "csv_record", "args": {"name": alias, "csv_url": f"https://data.invalid/MS.csv?run={trace}"},
         "response": {"id": f"ms-{trace}", "path": f"/data/MS.csv", "name": "MS.csv"}},
        {"id": "rib", "tool": "csv_record", "args": {"name": "Ribo", "csv_url": f"https://data.invalid/Ribo.csv?run={trace}"},
         "response": {"id": f"rib-{trace}", "path": f"/data/Ribo.csv", "name": "Ribo.csv"}},
        {"id": "ms-filter", "tool": "csv_filter", "args": {
            "csv_id": f"ms-{trace}", "name": alias,
            "conditions": [{"column": "log2FC", "operator": "<", "value": -threshold},
                           {"column": "padj", "operator": "<", "value": 0.05}],
            "keep_columns": columns}, "response": {"id": f"ms-out-{trace}", "path": f"/data/out-{trace}.csv", "name": alias}},
        {"id": "rib-filter", "tool": "csv_filter", "args": {
            "csv_id": f"rib-{trace}", "name": "Ribo output",
            "conditions": [{"column": "padj", "operator": "<", "value": 0.05},
                           {"column": "log2FC", "operator": "<", "value": -threshold}],
            "keep_columns": columns}, "response": {"id": f"rib-out-{trace}", "path": f"/data/ribo-out-{trace}.csv", "name": "Ribo output"}},
        {"id": "join", "tool": "csv_join", "args": {"left_csv_id": f"ms-out-{trace}",
            "right_csv_id": f"rib-out-{trace}", **({"how": how} if how is not None else {})},
         "response": {"id": f"joined-{trace}", "path": f"/data/joined-{trace}.csv"}},
    ]
    calls = normalize_calls(raw, trace)
    graph = build_recorded_graph(calls)
    source_instances = [
        {"callIds": ["ms"], "source": {"identity": "source:ms"}},
        {"callIds": ["rib"], "source": {"identity": "source:ribo"}},
    ]
    return {"traceId": trace, "calls": calls, "graph": graph, "flow": call_flow(graph),
            "instances": source_instances}


def test_filters_align_by_inputs_and_decision_not_alias_or_projection():
    analyses = [_analysis("run-a", 0.05, "MS_down", ["gene", "log2FC"], "inner"),
                _analysis("run-b", 0.01, "MS_downregulated_significant", ["gene"], "inner")]
    members = [{"traceId": a["traceId"], "callIds": ["ms-filter", "rib-filter"]} for a in analyses]
    groups = _operation_groups("selection", members, {a["traceId"]: a for a in analyses})
    filters = [group for group in groups if group["tool"] == "csv_filter"]

    assert len(filters) == 2  # MS and Ribo input lineages stay distinct.
    assert all(group["supportTraces"] == ["run-a", "run-b"] for group in filters)
    ms_group = next(group for group in filters
                    if group["members"][0]["inputEntityIds"][0].endswith(":0:ms"))
    assert len(ms_group["parameterVariants"]) == 2
    assert {member["run"] for member in ms_group["members"]} == {"run-a", "run-b"}
    rendered = [variant["parameters"] for variant in ms_group["parameterVariants"]]
    assert {tuple(item.get("keep_columns", [])) for item in rendered} == {("gene",), ("gene", "log2FC")}
    assert any("MS_down" in str(value) for value in rendered)
    assert all("data.invalid" not in str(value) for value in rendered)
    assert {condition["value"] for variant in rendered for condition in variant["conditions"]
            if condition["column"] == "log2FC"} == {-0.05, -0.01}


def test_join_how_is_preserved_as_a_meaningful_method_difference():
    analyses = [_analysis("run-a", 0.05, "MS_down", ["gene"], "inner"),
                _analysis("run-b", 0.05, "MS_down", ["gene"], None)]
    members = [{"traceId": a["traceId"], "callIds": ["join"]} for a in analyses]
    groups = _operation_groups("join-stage", members, {a["traceId"]: a for a in analyses})
    joins = [group for group in groups if group["tool"] == "csv_join"]
    assert len(joins) == 2


def test_inner_join_aligns_symmetric_inputs_but_preserves_variant_roles():
    analyses = [_analysis("run-a", 0.05, "MS_down", ["gene"], "inner"),
                _analysis("run-b", 0.05, "MS_down", ["gene"], "inner")]
    for index, analysis in enumerate(analyses):
        join = next(call for call in analysis["calls"] if call["id"] == "join")
        args = join["args"]
        args["left_csv_id"], args["right_csv_id"] = args["right_csv_id"], args["left_csv_id"]
        args["select"] = ({"left": ["gene_name"], "right": ["effect"]} if index == 0
                           else {"left": ["effect"], "right": ["gene_name"]})
    members = [{"traceId": a["traceId"], "callIds": ["join"]} for a in analyses]
    groups = _operation_groups("join-stage", members, {a["traceId"]: a for a in analyses})
    assert len(groups) == 1
    assert groups[0]["supportTraces"] == ["run-a", "run-b"]
    assert len(groups[0]["parameterVariants"]) == 2


def test_left_join_preserves_input_roles():
    analyses = [_analysis("run-a", 0.05, "MS_down", ["gene"], "left"),
                _analysis("run-b", 0.05, "MS_down", ["gene"], "left")]
    for index, analysis in enumerate(analyses):
        join = next(call for call in analysis["calls"] if call["id"] == "join")
        if index:
            args = join["args"]
            args["left_csv_id"], args["right_csv_id"] = args["right_csv_id"], args["left_csv_id"]
    members = [{"traceId": a["traceId"], "callIds": ["join"]} for a in analyses]
    groups = _operation_groups("join-stage", members, {a["traceId"]: a for a in analyses})
    assert len(groups) == 2


def test_inner_input_alignment_does_not_require_csv_tool_or_argument_names():
    analyses = [_analysis('run-a', 0.05, 'first', ['gene'], 'inner'),
                _analysis('run-b', 0.05, 'second', ['gene'], 'inner')]
    for index, analysis in enumerate(analyses):
        call = next(call for call in analysis['calls'] if call['id'] == 'join')
        call['tool'] = 'combine_catalogs'
        left, right = call['args'].pop('left_csv_id'), call['args'].pop('right_csv_id')
        call['args'].update(left_input=right if index else left, right_input=left if index else right)
        analysis['graph'] = build_recorded_graph(analysis['calls'])
        analysis['flow'] = call_flow(analysis['graph'])
    members = [{'traceId': analysis['traceId'], 'callIds': ['join']} for analysis in analyses]
    groups = _operation_groups('combination', members, {a['traceId']: a for a in analyses})
    assert len(groups) == 1 and groups[0]['supportTraces'] == ['run-a', 'run-b']


def test_same_run_repeated_operations_keep_distinct_occurrences():
    analysis = _analysis("run-a", 0.05, "MS_down", ["gene"], "inner")
    repeated = dict(analysis["calls"][2])
    repeated.update(id="ms-filter-again", timeIndex=5)
    analysis["calls"].append(repeated)
    # The second identical call is intentionally a separate occurrence.
    member = {"traceId": "run-a", "callIds": ["ms-filter", "ms-filter-again"]}
    groups = _operation_groups("selection", [member], {"run-a": analysis})
    assert len([group for group in groups if group["tool"] == "csv_filter"]) == 2


def test_failure_and_success_are_not_aligned_as_one_operation():
    analysis = _analysis("run-a", 0.05, "MS_down", ["gene"], "inner")
    failed = dict(analysis["calls"][2], id="failed-filter", status="error")
    analysis["calls"].append(failed)
    member = {"traceId": "run-a", "callIds": ["ms-filter", "failed-filter"]}
    groups = _operation_groups("selection", [member], {"run-a": analysis})
    filters = [group for group in groups if group["tool"] == "csv_filter"]
    assert len(filters) == 2
    assert {group["failure"] for group in filters} == {False, True}


def test_response_error_without_status_is_exposed_as_operation_failure():
    analysis = _analysis("run-a", 0.05, "MS_down", ["gene"], "inner")
    failed = dict(analysis["calls"][2], id="failed-filter", status=None,
                  response={"error": "filter failed"})
    analysis["calls"].append(failed)
    member = {"traceId": "run-a", "callIds": ["failed-filter"]}
    groups = _operation_groups("selection", [member], {"run-a": analysis})
    assert len(groups) == 1
    assert groups[0]["failure"] is True


def test_non_threshold_numeric_arguments_remain_part_of_the_match_key():
    analyses = [_analysis("run-a", 0.05, "MS_down", ["gene"], "inner"),
                _analysis("run-b", 0.05, "MS_down", ["gene"], "inner")]
    for analysis, permutations in zip(analyses, [100, 1000]):
        call = next(call for call in analysis["calls"] if call["id"] == "ms-filter")
        call["args"]["permutations"] = permutations
    members = [{"traceId": a["traceId"], "callIds": ["ms-filter"]} for a in analyses]
    groups = _operation_groups("selection", members, {a["traceId"]: a for a in analyses})
    assert len([group for group in groups if group["tool"] == "csv_filter"]) == 2


def test_numeric_identity_conditions_are_not_treated_as_threshold_variants():
    analyses = [_analysis('run-a', 0.05, 'first', ['gene'], 'inner'),
                _analysis('run-b', 0.05, 'second', ['gene'], 'inner')]
    for analysis, identifier in zip(analyses, [101, 202]):
        call = next(call for call in analysis['calls'] if call['id'] == 'ms-filter')
        call['args']['conditions'] = [{'column': 'record_id', 'op': '==', 'value': identifier}]
    members = [{'traceId': analysis['traceId'], 'callIds': ['ms-filter']} for analysis in analyses]
    groups = _operation_groups('selection', members, {a['traceId']: a for a in analyses})
    assert len(groups) == 2


def test_scientific_name_echo_is_not_treated_as_a_generated_alias():
    analyses = []
    for trace, gene in [("run-a", "HIF1A"), ("run-b", "AR")]:
        calls = normalize_calls([{"id": "lookup", "tool": "gene_lookup", "args": {"name": gene},
                                  "response": {"id": f"gene-{trace}", "name": gene,
                                               "description": "protein record"}}], trace)
        analyses.append({"traceId": trace, "calls": calls, "instances": []})
    members = [{"traceId": a["traceId"], "callIds": ["lookup"]} for a in analyses]
    groups = _operation_groups("lookup", members, {a["traceId"]: a for a in analyses})
    assert len(groups) == 2


def test_structured_filter_names_align_even_when_output_has_no_resource_record():
    analyses = [_analysis("run-a", 0.05, "MS_down", ["gene"], "inner"),
                _analysis("run-b", 0.05, "MS_downregulated_significant", ["gene"], "inner")]
    for analysis in analyses:
        for call in analysis["calls"]:
            if call["id"] in {"ms-filter", "rib-filter"}:
                call["response"] = {"rows": []}
    members = [{"traceId": a["traceId"], "callIds": ["ms-filter"]} for a in analyses]
    groups = _operation_groups("selection", members, {a["traceId"]: a for a in analyses})
    assert len(groups) == 1
    assert groups[0]["supportTraces"] == ["run-a", "run-b"]
