import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent_provenance_backend"))
from copilot import CopilotStore, parse_json_args, provenance_agent_response, tool_definitions, user_prompt


def catalog():
    return {
        "nodes": [
            {"id": "n0", "label": "browser search", "tools": ["browser.search"],
             "intent": "find high scoring evidence", "subjects": ["papers"], "role": "key",
             "result": "supports outcome", "failed": False, "support": 4},
            {"id": "n1", "label": "calculator", "tools": ["calculator"],
             "intent": "compute summary", "subjects": ["values"], "role": "supporting",
             "result": "", "failed": False, "support": 2},
        ],
        "edges": [{"id": "e0", "source": "n0", "target": "n1", "kind": "recorded",
                   "resultPath": True, "support": 2}],
    }


def joined_graph(global_tools, contributions=()):
    return {"nodes": [{"id": "family-1", "label": "Search", "methods": ["browser.search"],
                       "scoreSummary": {"average": 0.8},
                       "importance": {"outcome": {"globalTools": global_tools, "contributions": contributions}}}],
            "edges": [{"id": "edge-1", "source": "family-1", "target": "family-1"}]}


def store(global_tools=None, scope="selection-a"):
    return CopilotStore({
        "question": "tools crucial for high scores",
        "selectedTraces": [{"id": "private-trace-id", "score": 0.93,
                            "toolCalls": [{"name": "browser.search", "response": "private raw output"}]}],
        "joinedGraph": joined_graph(global_tools or []),
        "graphCatalog": catalog(),
        "graphIds": {"nodes": {"family-1": "n0"}, "edges": {"edge-1": "e0"}},
        "graphState": {"scope": scope, "filters": {"role": "key"}, "axis": "outcome",
                       "expandedNodeIds": ["family-1"], "highlightedNodeIds": [], "highlightedEdgeIds": []},
    })


def test_initial_model_context_is_bounded_and_does_not_include_raw_trace_data():
    rendered = user_prompt(store())
    assert "private-trace-id" not in rendered
    assert "private raw output" not in rendered
    assert "0.93" not in rendered
    assert "graphCatalog" in rendered
    assert "scope'" not in rendered
    assert "n0" in rendered


def test_graph_view_accepts_input_and_local_context_without_changing_scope():
    for context in ('parents', 'inputs', 'neighbors'):
        current = store()
        result = current.set_graph_view({'context': context, 'filters': {
            'context': context, 'role': 'unknown', 'evidence': 'supported', 'view': 'isolate'}})
        assert result.get('error') is None
        assert result['action']['scope'] == 'selection-a'
        assert result['action']['filters']['context'] == context
        assert result['action']['filters']['evidence'] == 'supported'


def test_input_patterns_expose_source_steps_and_actionable_canvas_ids_without_raw_data():
    from skill_patterns import mine_input_patterns
    current = store()
    current.traces[0]['toolCalls'] = [{'id': 'a', 'name': 'read'}, {'id': 'b', 'name': 'use'}]
    current.joined_graph['nodes'][0]['instances'] = [
        {'run': 'private-trace-id', 'calls': [{'id': 'a'}, {'id': 'b'}]}]
    current.joined_graph['inputPatterns'] = mine_input_patterns([{
        'traceId': 'private-trace-id', 'calls': [{'id': 'a', 'tool': 'read', 'response': 'private raw output'},
                                              {'id': 'b', 'tool': 'use'}],
        'flow': [{'source': 'a', 'target': 'b'}]}])
    result = current.call_tool('get_input_patterns', {})
    witness = result['patterns'][0]['witnesses'][0]
    assert witness['traceAlias'] == 'r0' and witness['steps'] == [1, 2]
    assert witness['nodeIds'] == ['n0']
    assert witness['consumerSteps'] == [2]
    assert witness['inputCoverage'][0]['unknownRoleCount'] == 0
    assert witness['links'][0]['inferred'] is False
    assert 'private-trace-id' not in str(result) and 'private raw output' not in str(result)
    assert current.get_input_patterns({'minSupport': 2})['patterns'] == []


def test_agent_workflow_insights_use_source_steps_and_keep_skills_provisional():
    current = store()
    current.traces[0]['toolCalls'][0]['id'] = 'private-event-id'
    current.traces[0]['toolCalls'][0]['round'] = 0
    current.joined_graph['workflowInsights'] = {
        'scope': {'runCount': 1},
        'timing': {'aggregate': {'publicationCount': 3}, 'runs': [{'traceId': 'private-trace-id', 'roundCount': 5}]},
        'outcomes': {'runs': [{'traceId': 'private-trace-id', 'score': 0.93,
                              'metrics': [{'metric': 'yield', 'best': {'eventId': 'private-event-id', 'value': 9, 'round': 0}}]}]},
        'keySteps': {'runs': [{'traceId': 'private-trace-id', 'metrics': [
            {'witness': [{'eventId': 'private-event-id', 'agentId': 'solver', 'round': 2}]}]}]},
        'skills': [{'label': 'Share then investigate', 'runSupport': 2,
                    'sourceExamples': [{'traceId': 'private-trace-id', 'eventIds': ['private-event-id']}]}],
    }
    outcomes = current.call_tool('get_workflow_insights', {'section': 'outcomes', 'traceAlias': 'r0'})
    assert outcomes['outcomes']['runs'][0]['metrics'][0]['best']['step'] == 1
    assert outcomes['outcomes']['runs'][0]['metrics'][0]['best']['round'] == 1
    assert outcomes['roundIndexing'] == 'one-based'
    assert current.get_tool_call_io({'traceAlias': 'r0', 'step': 1})['eventContext']['round'] == 1
    assert current.list_tool_calls({'roundStart': 1, 'roundEnd': 1})['traces'][0]['toolCalls'][0]['step'] == 1
    assert 'private-event-id' not in str(outcomes) and 'private-trace-id' not in str(outcomes)
    assert '0.93' not in str(outcomes)
    skills = current.get_workflow_insights({'section': 'skills'})
    assert skills['skills'][0]['sourceExamples'][0]['steps'] == [1]
    assert 'requiring transfer validation' in skills['interpretation']
    assert 'error' in current.get_workflow_insights({'section': 'unknown'})


def test_graph_source_readers_do_not_return_raw_score_summaries():
    current = store()
    assert "scoreSummary" not in current.get_joined_node({"nodeId": "n0"})
    assert "0.8" not in str(current.get_joined_graph({}))


def test_source_tools_use_run_aliases_and_redact_unbounded_inputs_and_outputs():
    current = store()
    calls = current.traces[0]["toolCalls"]
    calls[0].update({"id": "private-call-id", "args": {"query": "private-trace-id", "rows": [[1, 2]]},
                     "response": "https://example.org private-trace-id " + "x" * 500})
    listed = current.list_tool_calls({})
    assert listed["traces"][0]["traceAlias"] == "r0"
    assert "private-trace-id" not in str(listed)
    result = current.get_tool_call_io({"traceAlias": "r0", "step": 1})
    assert result["traceAlias"] == "r0"
    assert "private-trace-id" not in str(result)
    assert "https://" not in str(result)
    assert len(result["outputSummary"]) <= 420
    assert "rows" not in str(result["argsSummary"])
    assert current.search_tool_calls({"query": "browser", "traceAliases": ["r0"]})["matches"][0]["traceAlias"] == "r0"
    assert current.search_tool_calls({"query": "browser", "traceAliases": ["private-trace-id"]})["matches"] == []

    node = current.joined_graph["nodes"][0]
    node["variants"] = [{"evidence": [{"callId": "private-call-id", "field": "response", "path": "final.url",
                                        "kind": "output", "value": "ignored"}],
                         "diagnostics": [{"label": "Failure https://example.org", "recorded": True,
                                          "evidence": [{"callId": "private-call-id", "field": "error",
                                                       "path": "response.error", "value": "private-trace-id " + "e" * 500}]}]}]
    node["instances"] = [{"run": "private-trace-id", "calls": [{"id": "private-call-id", "tool": "browser.search", "step": 1}],
                          "resultEvidence": [{"relation": "supports", "claimText": "Found https://example.org " + "f" * 700 + " private-trace-id",
                                              "evidence": [{"path": "finalOutput.url", "quote": "https://example.org/ " + "q" * 500 + " private-trace-id"}]}]}]
    detail = current.get_joined_node({"nodeId": "n0"})
    assert detail["instances"][0]["run"] == "r0"
    assert len(detail["instances"][0]["resultEvidence"][0]["claim"]) <= 600
    assert len(detail["instances"][0]["resultEvidence"][0]["evidence"][0]["quote"]) <= 420
    assert "private-trace-id" not in str(detail)
    assert "https://" not in str(detail)
    assert detail["variants"][0]["evidence"] == [{"field": "response", "path": "final.url", "kind": "output"}]
    assert "private-call-id" not in str(detail)
    assert len(detail["variants"][0]["diagnostics"][0]["evidence"][0]["value"]) <= 420
    edge = current.joined_graph["edges"][0]
    edge.update({"supportTraces": ["private-trace-id"], "scoreSummary": {"average": 0.8},
                 "witnesses": [{"run": "private-trace-id", "sourceInstance": "private-instance",
                               "targetInstance": "private-instance-2", "reason": "used https://example.org"}]})
    edge_detail = current.get_joined_edge({"edgeId": "e0"})
    assert edge_detail["edgeId"] == "e0"
    assert edge_detail["witnesses"][0]["run"] == "r0"
    assert "private-trace-id" not in str(edge_detail)
    assert "private-instance" not in str(edge_detail)
    assert "https://" not in str(edge_detail)
    assert "scoreSummary" not in edge_detail


def test_search_graph_uses_bounded_catalog_and_maps_highlights_to_graph_ids():
    result = store().search_graph({"query": "browser search"})
    assert result["matches"]["nodes"] == [{"id": "n0", "reason": "Matches: browser, search"}]
    assert result["action"]["action"] == {
        "type": "highlight_graph", "nodeIds": ["family-1"], "edgeIds": [], "scope": "selection-a"
    }


def test_graph_actions_reject_unknown_ids_and_carry_current_scope():
    current = store()
    action = current.filter_graph({"nodeIds": ["n0"], "edgeIds": ["e0"], "context": "workflow"})
    assert action["action"]["scope"] == "selection-a"
    assert action["action"]["nodeIds"] == ["family-1"]
    assert current.highlight_graph({"nodeIds": ["n9"], "edgeIds": []})["error"]
    assert current.set_graph_view({"expandNodeIds": ["n9"]})["error"]
    assert store(scope="selection-b").highlight_graph({"nodeIds": ["n0"], "edgeIds": []})["action"]["scope"] == "selection-b"


def test_score_association_is_unavailable_without_estimates():
    result = store().rank_score_associations({})
    assert result["status"] == "unavailable"


def test_score_association_ranks_positive_high_score_links_and_hides_run_rows():
    result = store([
        {"tool": "neutral", "status": "available", "scoreMetric": "score", "importance": 0.8,
         "meanWhenPresent": -0.1, "sampleCount": 40, "taskCount": 2, "perTrace": {"run-1": 1}},
        {"tool": "planner", "status": "available", "scoreMetric": "score", "importance": 0.3,
         "meanWhenPresent": 0.2, "sampleCount": 20, "taskCount": 2, "contributions": [{"traceId": "run-1"}]},
    ]).rank_score_associations({})
    assert [item["tool"] for item in result["associations"]] == ["planner", "neutral"]
    assert all(item["nodeIds"] == ["n0"] for item in result["associations"])
    assert "perTrace" not in str(result)
    assert "run-1" not in str(result)
    assert "taskId" not in str(result)


def test_global_tool_ranking_returns_all_matching_opaque_node_ids():
    current = store([{"tool": "planner", "status": "available", "scoreMetric": "score",
                      "importance": 0.3, "meanWhenPresent": 0.2, "sampleCount": 20, "taskCount": 2}])
    current.graph_id_map["nodes"]["family-2"] = "n1"
    current.joined_graph["nodes"].append({"id": "family-2", "label": "Planner", "methods": ["planner"],
                                           "importance": {"outcome": {"globalTools": [
                                               {"tool": "planner", "status": "available", "scoreMetric": "score",
                                                "importance": 0.3, "meanWhenPresent": 0.2, "sampleCount": 20, "taskCount": 2}]}}})
    result = current.rank_score_associations({})
    assert result["associations"][0]["nodeIds"] == ["n0", "n1"]


def test_local_pattern_attribution_uses_opaque_node_ids_without_task_ids():
    current = store()
    current.joined_graph = joined_graph([], [{"taskId": "private-task", "scoreMetric": "score",
                                               "traceId": "private-trace", "value": 0.4, "stability": 0.9}])
    result = current.rank_score_associations({})
    pattern = result["localPatternAttributions"][0]
    assert pattern["nodeId"] == "n0"
    assert pattern["meanContribution"] == 0.4
    assert "private-task" not in str(result)
    assert "private-trace" not in str(result)


def test_set_graph_view_accepts_typed_filters_and_rejects_bad_values():
    filters = {"text": "search", "role": "key", "evidence": "path", "minSupport": 2,
               "minOutcome": 0.4, "view": "isolate", "context": "workflow", "links": "recorded"}
    result = store().set_graph_view({"filters": filters, "axis": "outcome"})
    assert result["action"]["filters"] == filters
    assert result["action"]["scope"] == "selection-a"
    assert store().set_graph_view({"filters": {"minSupport": True}})["error"]
    assert store().set_graph_view({"filters": {"minSupport": 2.5}})["error"]
    assert store().set_graph_view({"filters": {"minOutcome": float("nan")}})["error"]
    assert store().set_graph_view({"filters": {"role": "invented-role"}})["error"]
    assert store().set_graph_view({"filters": {"extra": 1}})["error"]


def test_graph_actions_update_view_state_for_later_tools():
    current = store()
    current.highlight_graph({"nodeIds": ["n0"], "edgeIds": ["e0"]})
    state = current.get_view_state({})["graphState"]
    assert state["highlightedNodeIds"] == ["n0"]
    assert state["highlightedEdgeIds"] == ["e0"]
    action = current.set_graph_view({"axis": "evidence", "filters": {"role": "key"}, "expandNodeIds": ["n0"]})
    assert action["action"]["scope"] == "selection-a"
    state = current.get_view_state({})["graphState"]
    assert state["axis"] == "evidence"
    assert state["filters"]["role"] == "key"
    assert state["expandedNodeIds"] == ["n0"]
    current.set_graph_view({"reset": True})
    state = current.get_view_state({})["graphState"]
    assert state["highlightedNodeIds"] == [] and state["highlightedEdgeIds"] == []


def test_tool_definitions_include_graph_actions_and_readers():
    names = {item["function"]["name"] for item in tool_definitions()}
    assert {"get_view_state", "search_graph", "rank_score_associations", "highlight_graph", "filter_graph", "set_graph_view"} <= names


def test_invalid_json_args_return_error_without_emitting_noop_graph_action():
    current = store()
    parsed = parse_json_args('{"nodeIds":["n0"]}{"frame":true}')
    result = current.call_tool("highlight_graph", parsed)
    assert result == {"error": "Tool arguments were not valid JSON."}
    assert current.get_view_state({})["graphState"]["highlightedNodeIds"] == []


def test_planner_replays_local_tool_and_returns_final_with_telemetry(monkeypatch):
    import copilot
    plans = iter([
        {"text": "I’ll inspect the graph.", "calls": [{"name": "search_graph", "arguments": '{"query":"browser"}'}]},
        {"text": "The matching stage is browser search.", "calls": []},
    ])
    prompts = []
    async def fake_infer(prompt, **kwargs):
        prompts.append((prompt, kwargs))
        return next(plans)
    monkeypatch.setattr(copilot, "infer_json", fake_infer)
    response = asyncio.run(provenance_agent_response({"question": "Where is browser used?", "joinedGraph": joined_graph([]),
                                                       "graphCatalog": catalog(), "graphIds": {"nodes": {"family-1": "n0"}, "edges": {}}}))

    async def collect():
        return [json.loads(line) async for line in response.body_iterator]

    events = asyncio.run(collect())
    assert prompts[0][1]["tier"] == "semantic" and prompts[0][1]["schema"]["type"] == "object"
    assert "Tool result for search_graph" in prompts[1][0]
    assert any(event["type"] == "tool_call" for event in events)
    assert any(event["type"] == "graph_action" for event in events)
    assert events[-2]["type"] == "final" and events[-2]["output"] == "The matching stage is browser search."
    assert events[-1]["type"] == "telemetry"
    assert events[-1]["modelRequests"] == 0  # Stub planner makes no hosted requests.
    assert events[-1]["toolCalls"] == 1
    assert events[-1]["elapsedSeconds"] >= 0


def test_planner_tool_budget_stops_before_dispatching_over_budget_call(monkeypatch):
    import copilot
    async def fake_infer(*_, **__):
        return {"text": "", "calls": [{"name": "get_view_state", "arguments": "{}"},
                                         {"name": "get_view_state", "arguments": "{}"}]}
    monkeypatch.setattr(copilot, "infer_json", fake_infer)
    monkeypatch.setenv("COPILOT_TOOL_CALLS", "1")
    response = asyncio.run(provenance_agent_response({"question": "Inspect view"}))
    async def collect():
        return [json.loads(line) async for line in response.body_iterator]
    events = asyncio.run(collect())
    assert [event["type"] for event in events].count("tool_call") == 1
    assert next(event for event in events if event["type"] == "error")["message"] == "Copilot tool budget reached."


def test_edge_witnesses_keep_instance_continuity_without_leaking_source_ids():
    current = store()
    current.joined_graph["nodes"][0]["instances"] = [
        {"id": "private-instance-a", "run": "private-trace-id", "calls": []},
        {"id": "private-instance-b", "run": "private-trace-id", "calls": []},
    ]
    body = {"question": "explain flow", "selectedTraces": current.traces, "joinedGraph": current.joined_graph,
            "graphCatalog": catalog(), "graphIds": current.graph_id_map, "graphState": current.graph_state}
    selected = CopilotStore(body)
    selected.joined_graph["edges"][0]["witnesses"] = [{"run": "private-trace-id", "sourceInstance": "private-instance-a",
        "targetInstance": "private-instance-b", "inferred": False, "highlighted": True}]
    result = selected.get_joined_edge({"edgeId": "e0"})
    assert result["witnesses"][0] == {"run": "r0", "sourceInstance": "i0", "targetInstance": "i1", "inferred": False, "resultPath": True, "reason": "", "relevance": None, "jointContext": False}
    assert "private-instance" not in str(result)
    assert "private-trace-id" not in str(result)


def test_main_flow_filter_is_an_inspectable_display_action():
    current = store()
    result = current.set_graph_view({'filters': {'context': 'parents', 'evidence': 'main', 'view': 'isolate'}})
    assert result['action']['filters']['evidence'] == 'main'
    assert result['action']['filters']['context'] == 'parents'
