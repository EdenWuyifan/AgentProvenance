from agent_provenance_backend.provenance import build_recorded_graph, call_flow, normalize_calls


def test_normalization_preserves_false_null_and_duplicate_call_occurrences():
    calls = normalize_calls([
        {"id": "same", "name": "write", "args": {"enabled": False}, "response": None, "status": False},
        {"id": "same", "name": "rewrite", "args": None, "response": {"id": "r"}},
        {"name": "read", "response": {"ok": True}},
    ], "trace/one")
    assert calls[0]["args"] == {"enabled": False} and calls[0]["response"] is None
    assert calls[0]["status"] is False
    assert len({call["id"] for call in calls}) == 3
    assert [call["timeIndex"] for call in calls] == [0, 1, 2]
    graph = build_recorded_graph(calls)
    assert len({node["id"] for node in graph["nodes"]}) == 6
    activities = [node for node in graph["nodes"] if node["kind"] == "Activity"]
    assert [node["args"] for node in activities] == [{"enabled": False}, None, None]


def test_recorded_parent_and_exact_resource_reference_keep_source_evidence():
    calls = normalize_calls([
        {"id": "make", "name": "write", "response": {"artifact": {"file_id": "file-101"}}},
        {"id": "consume", "name": "read", "args": {"input": "file-101"}, "parentCallId": "make"},
        {"id": "unrelated", "name": "search", "args": {"query": "prefix file-101 suffix"}},
    ], "run")
    graph = build_recorded_graph(calls)
    flows = call_flow(graph)
    assert [(edge["source"], edge["target"]) for edge in flows] == [
        ("make", "consume"), ("make", "consume")]
    used = [edge for edge in graph["edges"] if edge["relation"] == "usedBy"]
    assert [edge["evidence"][0]["kind"] for edge in used] == ["recorded", "reference"]
    assert used[1]["evidence"][0]["sourcePath"] == "/artifact/file_id"


def test_latest_occurrence_supplies_rewritten_resource_and_future_parent_is_ignored():
    calls = normalize_calls([
        {"id": "first", "name": "write", "response": {"path": "result.csv"}},
        {"id": "second", "name": "rewrite", "response": {"path": "result.csv"}},
        {"id": "reader", "name": "read", "args": {"path": "result.csv"}},
        {"id": "early", "name": "early", "parentCallId": "later"},
        {"id": "later", "name": "late"},
    ], "run")
    graph = build_recorded_graph(calls)
    generated = {edge["source"]: edge["target"] for edge in graph["edges"] if edge["relation"] == "generatedBy"}
    reader = next(node for node in graph["nodes"] if node.get("toolCallId") == "reader")
    reference = next(edge for edge in graph["edges"] if edge.get("target") == reader["id"]
                     and edge.get("relation") == "usedBy")
    assert reference["source"] == generated[next(node["id"] for node in graph["nodes"]
                                                   if node.get("toolCallId") == "second")]
    assert not any(edge.get("target") == next(node["id"] for node in graph["nodes"]
                                                if node.get("toolCallId") == "early")
                   and edge.get("relation") == "usedBy" for edge in graph["edges"])
