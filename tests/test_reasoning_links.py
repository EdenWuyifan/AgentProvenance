import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent_provenance_backend"))
import semantics
import reasoning_links
from abstraction import build_views
from models import ModelResponseError, digest


def analysis(trace_id, source_word="TP53", target_word="TP53"):
    return {
        "traceId": trace_id,
        "analysisKey": digest(["analysis", trace_id]),
        "templateVersion": "test-template-v1",
        "score": 912345678,
        "scoreMetric": "private metric label",
        "calls": [
            {"id": f"private-source-call-{trace_id}", "tool": "gene_set_analysis",
             "args": {"input_url": "https://private.example/private-table.csv?token=URLSECRET",
                      "password": "PASSWORDSECRET", "comment": source_word},
             "response": {"report": {"genes": [source_word]},
                          "rows": [{"value": "PRIVATE_TABLE_CONTENT"}]}, "timeIndex": 0},
            {"id": f"private-target-call-{trace_id}", "tool": "prioritize_genes",
             "args": {"gene_list": [target_word], "table_path": "/private/local/table.csv",
                      "api_token": "TOKENSECRET"},
             "response": {"summary": "done"}, "timeIndex": 1},
        ],
        "flow": [],
        "instances": [
            {"id": f"private-source-instance-{trace_id}", "familyId": "analysis-family",
             "label": "Gene set analysis", "display": "show", "callIds": [f"private-source-call-{trace_id}"]},
            {"id": f"private-target-instance-{trace_id}", "familyId": "prioritization-family",
             "label": "Prioritize genes", "display": "show", "callIds": [f"private-target-call-{trace_id}"]},
        ],
    }


@pytest.fixture
def cache(monkeypatch, tmp_path):
    monkeypatch.setattr(semantics, "CACHE_DIR", tmp_path)


def test_candidates_are_temporal_specific_and_cite_source_quote_paths():
    item = analysis("private-trace-identifier")
    candidates = reasoning_links.candidates(item)
    assert len(candidates) == 1
    choice = candidates[0]
    assert choice["source"] == "private-source-call-private-trace-identifier"
    assert choice["target"] == "private-target-call-private-trace-identifier"
    assert choice["evidence"] == [
        {"callId": choice["source"], "field": "response", "path": "/report/genes/0", "quote": "TP53"},
        {"callId": choice["target"], "field": "args", "path": "/gene_list/0", "quote": "TP53"},
    ]

    prompt_cards = choice["card"]
    assert prompt_cards["subjects"] == [{"text": "TP53", "sourceField": "response"}]
    prompt = reasoning_links.PROMPT + json.dumps({"candidates": [{"id": "r0e0", "run": "r0", **prompt_cards}]})
    for secret in ("private-trace-identifier", "private-source-call", "PRIVATE_TABLE_CONTENT",
                   "private-table.csv", "URLSECRET", "PASSWORDSECRET", "TOKENSECRET",
                   "private metric label", "912345678", "/private/local/table.csv"):
        assert secret not in prompt

    # Candidate direction always follows recorded call order. Recorded ancestry and shared
    # stage identity suppress extra semantic links.
    reversed_calls = list(reversed(item["calls"]))
    for index, call in enumerate(reversed_calls):
        call["timeIndex"] = index
    reversed_item = {**item, "calls": reversed_calls}
    reversed_candidates = reasoning_links.candidates(reversed_item)
    call_order = {call["id"]: call["timeIndex"] for call in reversed_calls}
    assert all(call_order[candidate["source"]] < call_order[candidate["target"]]
               for candidate in reversed_candidates)
    recorded = {**item, "flow": [{"source": item["calls"][0]["id"], "target": item["calls"][1]["id"]}]}
    assert reasoning_links.candidates(recorded) == []
    same_stage = {**item, "instances": [dict(instance, familyId="same") for instance in item["instances"]]}
    assert reasoning_links.candidates(same_stage) == []


def test_column_names_alone_do_not_create_candidates():
    item = analysis("columns")
    item["calls"][0]["response"] = {"columns": ["sample_name", "log2FC"]}
    item["calls"][1]["args"] = {"keep_columns": ["sample_name", "log2FC"]}
    assert reasoning_links.candidates(item) == []


def test_infer_links_batches_selected_ids_and_reuses_per_trace_cache(cache, monkeypatch):
    prompts = []

    async def infer(prompt):
        prompts.append(prompt)
        payload = json.loads(prompt.rsplit("\n", 1)[-1])
        return {"links": [{"candidate": candidate["id"], "reason": "The later step follows the named finding."}
                           for candidate in payload["candidates"]]}

    monkeypatch.setattr(reasoning_links, "infer_json", infer)
    entries = [analysis("a"), analysis("b", "EGFR", "EGFR")]
    links, metrics = asyncio.run(reasoning_links.infer_links(entries))
    assert len(prompts) == 1
    prompt = prompts[0]
    assert "private-source-call" not in prompt and "private-target-call" not in prompt
    payload = json.loads(prompt.rsplit("\n", 1)[-1])
    assert [item["run"] for item in payload["candidates"]] == ["r0", "r1"]
    assert {item["id"] for item in payload["candidates"]} == {"r0e0", "r1e0"}
    assert metrics["candidateCount"] == 2 and metrics["inferredLinks"] == 2
    assert all(link["inferred"] and link["relation"] == "semantic_followup" for group in links.values() for link in group)
    assert all(link["evidence"][0]["field"] == "response" for group in links.values() for link in group)

    repeated, cached_metrics = asyncio.run(reasoning_links.infer_links(entries))
    assert len(prompts) == 1
    assert repeated == links
    assert cached_metrics["newTraces"] == 0 and cached_metrics["cachedTraces"] == 2


def test_cold_incremental_adds_only_the_new_trace(cache, monkeypatch):
    prompts = []

    async def infer(prompt):
        prompts.append(prompt)
        payload = json.loads(prompt.rsplit("\n", 1)[-1])
        return {"links": [{"candidate": item["id"], "reason": "Related follow-up."}
                           for item in payload["candidates"]]}

    monkeypatch.setattr(reasoning_links, "infer_json", infer)
    a, b, c = analysis("a"), analysis("b", "EGFR", "EGFR"), analysis("c", "KRAS", "KRAS")
    asyncio.run(reasoning_links.infer_links([a]))
    asyncio.run(reasoning_links.infer_links([a, b]))
    asyncio.run(reasoning_links.infer_links([a, b, c]))
    assert len(prompts) == 3
    payloads = [json.loads(prompt.rsplit("\n", 1)[-1]) for prompt in prompts]
    assert [[card["run"] for card in payload["candidates"]] for payload in payloads] == [["r0"], ["r1"], ["r2"]]
    assert all("private-source-call" not in prompt for prompt in prompts)


@pytest.mark.parametrize("bad_links", [
    [{"candidate": "invented", "reason": "No such candidate."}],
    [{"candidate": "r0e0", "reason": "A rationale."}, {"candidate": "r0e0", "reason": "Duplicate."}],
])
def test_unknown_or_duplicate_candidate_fails_without_writing_cache(cache, monkeypatch, bad_links):
    async def infer(prompt):
        return {"links": bad_links}

    monkeypatch.setattr(reasoning_links, "infer_json", infer)
    with pytest.raises(ModelResponseError, match="unique supplied candidates"):
        asyncio.run(reasoning_links.infer_links([analysis("invalid")]))
    assert not list((semantics.CACHE_DIR / "reasoning-links").glob("*.json"))


def test_inferred_witness_keeps_rationale_without_becoming_recorded_result_ancestry():
    source, target = analysis("projection")["calls"]
    instances = [
        {"id": "source-instance", "familyId": "source-family", "label": "Analyze gene set",
         "templateId": "analysis", "traceId": "projection", "callIds": [source["id"]],
         "display": "show", "parameters": {}, "diagnostics": []},
        {"id": "target-instance", "familyId": "target-family", "label": "Prioritize genes",
         "templateId": "prioritize", "traceId": "projection", "callIds": [target["id"]],
         "display": "show", "parameters": {}, "diagnostics": []},
    ]
    evidence = [{"callId": source["id"], "field": "response", "path": "/report/genes/0", "quote": "TP53"},
                {"callId": target["id"], "field": "args", "path": "/gene_list/0", "quote": "TP53"}]
    item = {"traceId": "projection", "calls": [source, target], "instances": instances,
            "flow": [{"source": source["id"], "target": target["id"], "inferred": True,
                      "reason": "The later prioritization follows the reported gene.", "evidence": evidence}],
            "targets": [target["id"]]}
    graph = build_views([item], [], {}, detail="overview")
    source_node = next(node for node in graph["nodes"] if node["id"] == "source-family")
    target_node = next(node for node in graph["nodes"] if node["id"] == "target-family")
    assert source_node["resultBackbone"] is False
    assert source_node["instances"][0]["resultBackbone"] is False
    assert target_node["resultBackbone"] is True
    edge = graph["edges"][0]
    witness = edge["witnesses"][0]
    assert edge["inferred"] and edge["relation"] == "semantic_followup"
    assert witness["inferred"] and not witness["highlighted"]
    assert witness["reason"] == "The later prioritization follows the reported gene."
    assert witness["evidence"] == evidence
