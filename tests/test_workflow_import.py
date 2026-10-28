import json
import sqlite3

from agent_provenance.workflow_import import _CacheIndex, import_record, import_run

FIELDS = ("electrophile", "nucleophile", "base", "ligand", "solvent")


def make_run(path, agents=3, rounds=2, choices=None):
    steps, deliveries = [], []
    values = [[40 + r * 10 + a for a in range(agents)] for r in range(rounds)]
    for r in range(rounds):
        for a in range(agents):
            theta = [a, 0, 1, 2, a]
            rationale = "chosen rationale" if (choices or {}).get((r, a)) == "reasoning_llm_proposed" else ""
            steps.append({"round": r, "agent": a, "theta_int": theta, "theta_phys": [str(x) for x in theta],
                          "y_internal": values[r][a], "y_raw": values[r][a], "best_so_far_raw": max(values[x][a] for x in range(r+1)),
                          "chose_by": (choices or {}).get((r, a), "random_unobserved_subset"), "llm_rationale": rationale,
                          "llm_intent": "near_success_variant" if rationale else "", "n_llm_candidates": 1,
                          "n_tokens_in_memory": r * (agents - 1), "gamma_flipped_selection": 0, "gamma_selection_shift": 0})
            for to in range(agents):
                if to == a:
                    continue
                deliveries.append({"round": r, "from": a, "to": to, "s": 1, "c": .5, "eta": .8,
                                   "theta": theta.copy(), "l_text": json.dumps({"insight": f"insight from {a} round {r}"})})
    config = {"n_agents": agents, "n_rounds": rounds, "warmup_rounds": 1, "n_opts_per_dim": [agents, 3, 7, 11, agents]}
    data = {"heterogeneity": "het", "seed": 11, "config": config, "steps": steps, "token_log": deliveries,
            "final_system_best": max(values[-1]), "system_best": [max(values[r]) for r in range(rounds)]}
    path.write_text(json.dumps(data))
    return data


def create_cache(path, prompts):
    db = sqlite3.connect(path)
    db.execute("create table llm_cache(key text primary key,prompt text,response text,kind text,ts real,model text,fingerprint text)")
    db.executemany("insert into llm_cache values(?,?,?,'propose',0,'test','')", [(str(i), p, r) for i, (p, r) in enumerate(prompts)])
    db.commit(); db.close()


def response_for(theta, rationale):
    candidate = {f"{name}_idx": value for name, value in zip(FIELDS, theta)}
    candidate.update(intent="near_success_variant", hypothesis_id="H1", rationale=rationale)
    return json.dumps({"hypotheses": [{"id": "H1", "claim": "example"}], "candidates": [candidate]})


def local_context(data, agent, target_round, start_round=0):
    lines = []
    for step in data["steps"]:
        if step["agent"] != agent or step["round"] < start_round or step["round"] >= target_round:
            continue
        theta = ",".join(map(str, step["theta_int"]))
        status = "SUCCESS" if step["y_raw"] >= 50 else "FAILURE"
        lines.append(f"[source=local_observation, r= {step['round']:2d}, tuple=({theta}), {status}, c=0.5] yield={step['y_raw']:.1f}%")
    return "\n".join(lines)


def test_generic_multi_agent_trace_and_score(tmp_path):
    source = tmp_path / "run.json"
    data = make_run(source, agents=5, rounds=3)
    trace = import_run(source)
    assert trace["eventSchemaVersion"] == "workflow-events-v1"
    assert len(trace["participants"]) == 5
    assert all(isinstance(pid, str) for event in trace["events"] for pid in event["participantIds"])
    selections = [e for e in trace["events"] if e["eventType"] == "experiment"]
    assert selections[0]["args"]["selected_conditions"] == dict(zip(FIELDS, [0, 0, 1, 2, 0]))
    assert selections[0]["args"]["physical_conditions"] == dict(zip(FIELDS, ["0", "0", "1", "2", "0"]))
    assert all(pattern.startswith(("selection:", "intent:")) for e in selections for pattern in e["patterns"])
    assert not any("yield" in p or "outcome" in p for e in selections for p in e["patterns"])
    assert trace["importMetadata"]["featureWindowEnd"] == 1
    assert trace["importMetadata"]["scoreWindowEnd"] == 2
    assert trace["score"] == sum(data["system_best"]) / 3
    assert trace["scoreMetric"] == "best_yield_auc_20"
    assert trace["final_yield"] == data["final_system_best"]
    assert {e["eventType"] for e in trace["events"]} <= {"experiment", "information_publication", "information_reception"}
    assert sum(e["eventType"] == "experiment" for e in trace["events"]) == 3 * 5
    assert sum(e["eventType"] == "information_reception" for e in trace["events"]) == 3 * 5 * 4
    assert all("jsonPointer" in e["source"] for e in trace["events"] if e["source"].get("file") == source.name)
    assert len([e for e in trace["events"] if e["eventType"] == "information_reception"]) == 3 * 5 * 4
    assert trace["importMetadata"]["cacheCountsAreNotRequestCounts"] is True
    assert any(o["name"] == "New system best" and o["round"] == 1 for o in trace["outcomes"])


def test_mutated_delivery_is_diagnostic_and_source_theta_preserved(tmp_path):
    source = tmp_path / "run.json"
    make_run(source, agents=2, rounds=1)
    data = json.loads(source.read_text())
    data["token_log"][0]["theta"][0] = 1
    source.write_text(json.dumps(data))
    trace = import_run(source)
    delivery = next(e for e in trace["events"] if e["eventType"] == "information_reception" and e.get("diagnostics"))
    assert delivery["status"] == "completed"
    assert delivery["args"]["sourcePayload"]["theta"] != delivery["args"]["payload"]["theta"]
    assert delivery["diagnostics"][0]["kind"] == "payload_altered"
    publication = next(e for e in trace["events"] if e["eventType"] == "information_publication")
    assert publication["args"]["communicatedPayload"]["theta"] == data["token_log"][0]["theta"]
    assert publication["response"] == json.loads(data["token_log"][0]["l_text"])["insight"]
    assert any(l["relation"] == "publishes" for l in trace["eventLinks"])
    assert any(l["relation"] == "delivered_to" for l in trace["eventLinks"])


def test_unique_cache_join_uses_historical_peer_and_target_round_exposure(tmp_path):
    source, cache = tmp_path / "run.json", tmp_path / "cache.sqlite"
    data = make_run(source, agents=2, rounds=4, choices={(3, 0): "reasoning_llm_proposed"})
    prior = next(t for t in data["token_log"] if t["round"] == 0 and t["to"] == 0)
    theta = data["steps"][6]["theta_int"]
    insight = json.loads(prior["l_text"])["insight"]
    prompt = f"Agent 0 (solvent fixed to MeCN)\nobservations=2\n{local_context(data, 0, 3, start_round=1)}\n[source=peer_token, from lab 1, r=0, tuple=({','.join(map(str, prior['theta']))}), eta=0.8]\n insight: \"{insight}\""
    create_cache(cache, [(prompt, response_for(theta, "chosen rationale"))])
    index = _CacheIndex(cache)
    try:
        trace = import_record(data, source.name, index)
    finally:
        index.close()
    experiment = next(e for e in trace["events"] if e["id"].endswith("r3:a0:experiment"))
    assert experiment["source"]["matchStatus"] == "contextual_unique"
    assert experiment["args"]["proposalEvidence"]["candidates"][0]["electrophile_idx"] == theta[0]
    assert experiment["args"]["proposalEvidence"]["selectedCandidateIndex"] == 0
    prompt = experiment["args"]["promptEvidence"]
    assert prompt["promptObservationCount"] == 2
    assert len(prompt["localObservations"]) == 2 and len(prompt["peerMessages"]) == 1
    assert prompt["peerMessages"][0]["receptionId"].endswith("r0:a0:reception-from-1")
    assert trace["importMetadata"]["cacheObservationCounterOffsets"] == {"1": 1}
    assert sum(l["relation"] in ("used_local_evidence", "used_shared_evidence") and l["target"] == experiment["id"] for l in trace["eventLinks"]) == 3
    assert trace["importMetadata"]["encodeEnrichment"] == "attempted"


def test_ambiguous_cache_is_not_enriched(tmp_path):
    source, cache = tmp_path / "run.json", tmp_path / "cache.sqlite"
    data = make_run(source, agents=2, rounds=4, choices={(3, 0): "reasoning_llm_proposed"})
    prior = next(t for t in data["token_log"] if t["round"] == 0 and t["to"] == 0)
    theta = data["steps"][6]["theta_int"]
    insight = json.loads(prior["l_text"])["insight"]
    prompt = f"Agent 0 (solvent fixed to MeCN)\nobservations=2\n{local_context(data, 0, 3, start_round=1)}\n[source=peer_token, from lab 1, r=0, tuple=({','.join(map(str, prior['theta']))}), eta=0.8]\n insight: \"{insight}\""
    response = response_for(theta, "chosen rationale")
    create_cache(cache, [(prompt, response), (prompt, response)])
    trace = import_run(source, cache)
    experiment = next(e for e in trace["events"] if e["id"].endswith("r3:a0:experiment"))
    assert experiment["source"]["matchStatus"] == "ambiguous"
    assert "proposalEvidence" not in experiment["args"] and "promptEvidence" not in experiment["args"]


def test_encode_cache_join_uses_insight_and_observation_context(tmp_path):
    source, cache = tmp_path / "run.json", tmp_path / "cache.sqlite"
    data = make_run(source, agents=2, rounds=1)
    step = data["steps"][0]
    token = next(t for t in data["token_log"] if t["round"] == 0 and t["from"] == 0)
    insight = json.loads(token["l_text"])["insight"]
    observation = "\n".join([*step["theta_phys"], f"yield        : {step['y_raw']}%"])
    prompt = f"Agent 0\n## New observation just collected\n{observation}"
    db = sqlite3.connect(cache)
    db.execute("create table llm_cache(key text primary key,prompt text,response text,kind text,ts real,model text,fingerprint text)")
    db.execute("insert into llm_cache values('encode-1',?,?, 'encode',0,'test','')", (prompt, json.dumps({"insight": insight})))
    db.commit(); db.close()
    trace = import_run(source, cache)
    publication = next(e for e in trace["events"] if e["eventType"] == "information_publication" and e["agentId"] == "agent-0")
    assert publication["args"]["encodeMatchStatus"] == "contextual_unique"
    assert publication["source"]["experimentPointer"] == "/steps/0"


def test_import_prunes_at_first_maximum_preserving_original_score_and_pointers(tmp_path):
    source = tmp_path / 'plateau.json'
    data = make_run(source, agents=2, rounds=6)
    data['steps'][2]['y_raw'] = data['steps'][2]['y_internal'] = 100
    for step in data['steps']:
        step['best_so_far_raw'] = max(s['y_raw'] for s in data['steps']
                                        if s['agent'] == step['agent'] and s['round'] <= step['round'])
    data['system_best'] = [max(step['best_so_far_raw'] for step in data['steps'] if step['round'] == r) for r in range(6)]
    data['final_system_best'] = 100
    source.write_text(json.dumps(data))
    original = source.read_bytes()
    trace = import_run(source)
    assert source.read_bytes() == original
    assert {event['round'] for event in trace['events']} == {0, 1}
    assert len(trace['events']) == 2 * 2 * (2 + 1)
    ids = {event['id'] for event in trace['events']}
    assert all(link['source'] in ids and link['target'] in ids for link in trace['eventLinks'])
    assert all(outcome['eventId'] in ids for outcome in trace['outcomes'])
    assert trace['score'] == sum(data['system_best']) / 6
    assert trace['score'] != sum(data['system_best'][:2]) / 2
    assert trace['rounds_to_best'] == 2
    assert trace['best_reached_during_warmup'] is False
    assert trace['config']['n_rounds'] == 6
    experiment = next(event for event in trace['events'] if event['id'].endswith('r1:a0:experiment'))
    assert experiment['source']['jsonPointer'] == '/steps/2'
    assert trace['importMetadata']['pruning']['removedEventCount'] == 24
