import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent_provenance_backend"))
from copilot import CopilotStore, model_messages, parse_json_args, provenance_agent_response, request_kwargs, stream_model_round, tool_definitions, update_tool_call


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
    messages = model_messages(store())
    rendered = str(messages)
    assert "private-trace-id" not in rendered
    assert "private raw output" not in rendered
    assert "0.93" not in rendered
    assert "graphCatalog" in rendered
    assert "scope'" not in rendered
    assert "n0" in rendered


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
    assert store().set_graph_view({"filters": {"role": "unknown"}})["error"]
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


def test_gemini_request_uses_reasoning_effort_and_modest_budget():
    request = request_kwargs("@vertexai/gemini-3.8-flash", [])
    assert request["model"] == "@vertexai/gemini-3.8-flash"
    assert request["reasoning_effort"] == "low"
    assert request["max_tokens"] == 8192
    assert "thinking" not in request
    names = {item["function"]["name"] for item in tool_definitions()}
    assert {"get_view_state", "search_graph", "rank_score_associations", "highlight_graph", "filter_graph", "set_graph_view"} <= names


def test_streamed_tool_chunks_assemble_by_index_and_keep_gemini_signature():
    calls = {}
    update_tool_call(calls, 0, {"index": 0, "function": {"arguments": '{"nodeIds":'}})
    update_tool_call(calls, 0, {"index": 0, "id": "call-1", "extra_content": {
        "google": {"thought_signature": "sig-1"}}, "function": {"arguments": '["n0"]}'}})
    assert len(calls) == 1
    call = next(iter(calls.values()))
    assert call["id"] == "call-1"
    assert call["function"]["arguments"] == '{"nodeIds":["n0"]}'
    assert call["extra_content"]["google"]["thought_signature"] == "sig-1"


def test_streamed_calls_merge_by_id_and_preserve_distinct_gemini_calls():
    calls = {}
    update_tool_call(calls, 0, {"id": "highlight-1", "index": 0, "function": {
        "name": "highlight_graph", "arguments": '{"nodeIds":["n0"],'}})
    update_tool_call(calls, 0, {"index": 0, "function": {"arguments": '"edgeIds":'}})
    update_tool_call(calls, 1, {"id": "view-1", "function": {
        "name": "set_graph_view", "arguments": '{"context":"workflow","frame":true}'}})
    update_tool_call(calls, 0, {"id": "highlight-1", "index": 0, "function": {
        "arguments": '["e4","e5"],"context":"workflow"}'}})
    assert len(calls) == 2
    by_name = {call["function"]["name"]: call for call in calls.values()}
    assert by_name["highlight_graph"]["id"] == "highlight-1"
    assert json.loads(by_name["highlight_graph"]["function"]["arguments"]) == {
        "nodeIds": ["n0"], "context": "workflow", "edgeIds": ["e4", "e5"]}
    assert json.loads(by_name["set_graph_view"]["function"]["arguments"]) == {
        "context": "workflow", "frame": True}


def test_streamed_calls_merge_idless_fragments_by_index_then_promote_id():
    calls = {}
    update_tool_call(calls, 0, {"index": 0, "function": {"arguments": '{"nodeIds":'}})
    update_tool_call(calls, 1, {"index": 1, "function": {"arguments": '{"axis":'}})
    update_tool_call(calls, 0, {"id": "highlight-1", "index": 0, "function": {
        "name": "highlight_graph", "arguments": '["n0"]}'}})
    update_tool_call(calls, 1, {"id": "view-1", "index": 1, "function": {
        "name": "set_graph_view", "arguments": '"evidence"}'}})
    assert len(calls) == 2
    by_name = {call["function"]["name"]: call for call in calls.values()}
    assert json.loads(by_name["highlight_graph"]["function"]["arguments"]) == {"nodeIds": ["n0"]}
    assert json.loads(by_name["set_graph_view"]["function"]["arguments"]) == {"axis": "evidence"}


def test_invalid_json_args_return_error_without_emitting_noop_graph_action():
    current = store()
    parsed = parse_json_args('{"nodeIds":["n0"]}{"frame":true}')
    result = current.call_tool("highlight_graph", parsed)
    assert result == {"error": "Tool arguments were not valid JSON."}
    assert current.get_view_state({})["graphState"]["highlightedNodeIds"] == []


def test_app_client_factory_selects_gemini_and_streams_final_telemetry(monkeypatch):
    import inference

    class Stream:
        async def __aiter__(self):
            yield {"choices": [{"delta": {"content": "ready"}}]}

    class Client:
        instances = []

        def __init__(self, **_):
            self.max_retries = 1
            self.openai_client = SimpleNamespace(max_retries=1)
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))
            self.request = None
            self.instances.append(self)

        async def create(self, **request):
            self.request = request
            return Stream()

        async def close(self):
            pass

    monkeypatch.setenv("PORTKEY_API_KEY", "test-key")
    monkeypatch.setattr(inference, "AsyncPortkey", Client)
    response = asyncio.run(provenance_agent_response({"question": "hello"}, inference.portkey_client))

    async def collect():
        return [json.loads(line) async for line in response.body_iterator]

    events = asyncio.run(collect())
    assert Client.instances[0].request["model"] == "@vertexai/gemini-3.8-flash"
    assert events[-1]["type"] == "telemetry"
    assert events[-1]["modelRequests"] == 1
    assert events[-1]["toolCalls"] == 0
    assert events[-1]["elapsedSeconds"] >= 0


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
