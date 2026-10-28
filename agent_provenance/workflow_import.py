"""Read-only import of cooperative Suzuki workflow JSON into workflow-events-v1 traces."""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

from agent_provenance.workflow_window import prune_after_result

SCHEMA = "workflow-events-v1"
DIMENSIONS = ("electrophile", "nucleophile", "base", "ligand", "solvent")
CANDIDATE_FIELDS = tuple(f"{name}_idx" for name in DIMENSIONS)
SOLVENTS = {0: "MeCN", 1: "THF", 2: "DMF", 3: "MeOH"}
LOCAL_HEADER = re.compile(r"^[ \t]*\[source=local_observation,\s*r=\s*(\d+),\s*tuple=\(([^)]*)\),\s*(?:SUCCESS|FAILURE),\s*c=[^\]]+\]\s*yield=([0-9.]+)%", re.MULTILINE)


def _id(run, round_, agent, kind):
    return f"{run}:r{round_}:a{agent}:{kind}"


def _theta(candidate):
    if isinstance(candidate, dict):
        return tuple(candidate[field] for field in CANDIDATE_FIELDS)
    return tuple(candidate)


def _decode_config(config):
    return {**config, "chemistry_dimensions": list(DIMENSIONS),
            "eta_semantics": "unverified raw field", "gamma_semantics": "unverified raw field",
            "outcome_source": "offline dataset replay"}


def _insight(token):
    value = token.get("l_text", "")
    try:
        parsed = json.loads(value)
        return parsed.get("insight", value) if isinstance(parsed, dict) else value
    except (json.JSONDecodeError, TypeError):
        return value


def _candidate_list(response):
    try:
        value = json.loads(response)
    except (json.JSONDecodeError, TypeError):
        return []
    return value.get("candidates", []) if isinstance(value, dict) else []


class _CacheIndex:
    """One-pass compact candidate index; full prompts load only for shortlisted rows."""
    def __init__(self, path):
        self.db = sqlite3.connect(f"file:{Path(path).resolve()}?mode=ro", uri=True)
        self.record_counts = dict(self.db.execute("select kind,count(*) from llm_cache group by kind"))
        self.proposals_by_context = defaultdict(list)
        self.prompt_observation_counts = Counter()
        self.proposal_rows = 0
        self.encodes = defaultdict(list)
        for key, prompt, response, kind in self.db.execute("select key,prompt,response,kind from llm_cache"):
            if kind == "encode":
                try:
                    insight = json.loads(response).get("insight")
                except (json.JSONDecodeError, TypeError, AttributeError):
                    insight = None
                if insight:
                    self.encodes[insight].append(key)
                continue
            if kind != "propose" or not prompt:
                continue
            agent = re.search(r"Agent\s+(\d+)\s*\(solvent fixed to", prompt)
            observations = re.search(r"observations=(\d+)", prompt)
            if not agent or not observations:
                continue
            agent_id, obs = int(agent.group(1)), int(observations.group(1))
            local_rows = LOCAL_HEADER.findall(prompt)
            if local_rows:
                last_round, last_theta, last_yield = max(local_rows, key=lambda row: int(row[0]))
                last_local = (int(last_round), tuple(int(x.strip()) for x in last_theta.split(",")), f"{float(last_yield):.1f}")
            else:
                last_local = None
            self.prompt_observation_counts[obs] += 1
            for candidate in _candidate_list(response):
                try:
                    theta = _theta(candidate)
                except (KeyError, TypeError):
                    continue
                rationale = candidate.get("rationale", "")
                self.proposals_by_context[agent_id, obs, theta, rationale, last_local].append(key)
                self.proposal_rows += 1

    def match(self, step, prior_deliveries):
        agent, round_, theta = step["agent"], step["round"], tuple(step["theta_int"])
        rationale = step.get("llm_rationale", "")
        last_step = max((s for s in prior_deliveries[1]), key=lambda s: s["round"], default=None)
        last_local = (last_step["round"], tuple(last_step["theta_int"]), f"{last_step['y_raw']:.1f}") if last_step else None
        keys = [key for obs in self.prompt_observation_counts for key in self.proposals_by_context.get((agent, obs, theta, rationale, last_local), ())]
        matched = []
        for key in keys:
            row = self.db.execute("select prompt,response from llm_cache where key=?", (key,)).fetchone()
            context = self._prompt_matches(row[0], agent, round_, prior_deliveries[0], prior_deliveries[1]) if row else None
            if context is not None:
                matched.append((key, row[0], row[1], context))
        if len(matched) != 1:
            return {"matchStatus": "ambiguous" if matched else "unmatched"}
        key, prompt, response, context = matched[0]
        return {"matchStatus": "contextual_unique", "cacheKey": key, "prompt": prompt, "response": response, **context}

    @staticmethod
    def _prompt_matches(prompt, agent, target_round, deliveries, local_steps):
        if not re.search(rf"Agent\s+{agent}\s*\(solvent fixed to", prompt):
            return None
        observation_count = re.search(r"observations=(\d+)", prompt)
        if not observation_count:
            return None
        local_index = {(s["round"], tuple(s["theta_int"]), f"{s['y_raw']:.1f}"): s for s in local_steps}
        local_matches = []
        for round_, tuple_text, yield_text in LOCAL_HEADER.findall(prompt):
            theta = tuple(int(x.strip()) for x in tuple_text.split(","))
            local = local_index.get((int(round_), theta, f"{float(yield_text):.1f}"))
            if local is None:
                return None
            local_matches.append({"round": int(round_), "theta": list(theta), "yield": float(yield_text)})
        if len(local_matches) != int(observation_count.group(1)):
            return None
        if not local_matches or max(item["round"] for item in local_matches) != target_round - 1:
            return None
        historical = {(t["from"], t["round"], tuple(t["theta"]), _insight(t)): t for t in deliveries}
        peers = []
        header = re.compile(r"^[ \t]*\[source=peer_token,\s*from lab\s+(\d+),\s*r=(\d+),\s*tuple=\(([^)]*)\)[^\]]*\]", re.MULTILINE)
        blocks = list(header.finditer(prompt))
        for i, block in enumerate(blocks):
            sender, round_, tuple_text = block.groups()
            block_end = blocks[i + 1].start() if i + 1 < len(blocks) else len(prompt)
            insight_match = re.search(r"^[ \t]*insight:\s*\"([^\"]*)\"", prompt[block.end():block_end], re.MULTILINE)
            if not insight_match:
                return None
            insight = insight_match.group(1)
            theta = tuple(int(x.strip()) for x in tuple_text.split(","))
            token = historical.get((int(sender), int(round_), theta, insight))
            if token is None:
                return None
            peers.append({"from": int(sender), "round": int(round_), "theta": list(theta), "insight": insight})
        if local_matches == [] and peers == []:
            return None
        return {"peers": peers, "localObservations": local_matches, "promptObservationCount": int(observation_count.group(1)),
                "roundCounterOffset": target_round - int(observation_count.group(1))}

    def match_encode(self, insight, agent, round_, theta_phys, yield_value):
        keys = self.encodes.get(insight, ())
        matched = []
        for key in keys:
            row = self.db.execute("select prompt from llm_cache where key=?", (key,)).fetchone()
            if not row:
                continue
            prompt = row[0]
            section = prompt.split("## New observation just collected", 1)
            if len(section) != 2:
                continue
            observation = section[1]
            if f"Agent {agent}" not in prompt:
                continue
            if all(str(value) in observation for value in theta_phys) and re.search(rf"yield\s*:\s*{re.escape(str(yield_value))}%", observation):
                matched.append(key)
        return {"matchStatus": "contextual_unique", "cacheKey": matched[0]} if len(matched) == 1 else {
            "matchStatus": "ambiguous" if matched else "unmatched"}

    def close(self):
        self.db.close()


def import_record(data, source_name="<memory>", cache_index=None):
    cfg, steps, tokens = data["config"], data["steps"], data["token_log"]
    run = f"suzuki_edbo:{data['heterogeneity']}:{data['seed']}"
    n_agents = cfg["n_agents"]
    participants = [{"id": f"agent-{a}", "label": f"Agent {a}", "role": "laboratory",
                     "environment": {"fixed_solvent_index": a, "fixed_solvent": SOLVENTS.get(a)} if data["heterogeneity"] == "het" else {}}
                    for a in range(n_agents)]
    by_source, by_recipient = defaultdict(list), defaultdict(list)
    token_pointers = {}
    for token_i, token in enumerate(tokens):
        by_source[token["round"], token["from"]].append(token)
        by_recipient[token["round"], token["to"]].append(token)
        token_pointers[token["round"], token["from"], token["to"]] = token_i
    events, links, outcomes = [], [], []
    prompts, prompt_targets, matches, encode_matches, context_offsets = {}, {}, Counter(), Counter(), Counter()
    local_bests = [float("-inf")] * n_agents
    step_by_key = {(s["round"], s["agent"]): s for s in steps}
    local_by_agent = defaultdict(list)
    for step in steps:
        local_by_agent[step["agent"]].append(step)
    step_pointers = {(s["round"], s["agent"]): i for i, s in enumerate(steps)}
    system_best = []

    for step_number, step in enumerate(steps):
        r, a = step["round"], step["agent"]
        base = {"round": r, "role": "laboratory", "agentId": f"agent-{a}", "participantIds": [f"agent-{a}"]}
        src = {"file": source_name, "jsonPointer": f"/steps/{step_number}"}
        experiment_id = _id(run, r, a, "experiment")
        experiment = {**base, "id": experiment_id, "name": "Select and conduct experiment", "eventType": "experiment",
                      "patterns": [f"selection:{step['chose_by']}"] + ([f"intent:{step['llm_intent']}"] if step.get("llm_intent") else []),
                      "phase": "experiment",
                      "args": {"selected_theta": step["theta_int"], "selected_conditions": dict(zip(DIMENSIONS, step["theta_int"])),
                               **({"physical_conditions": dict(zip(DIMENSIONS, step["theta_phys"]))} if step.get("theta_phys") else {}),
                               "selection_method": step["chose_by"], "intent": step.get("llm_intent"),
                               "rationale": step.get("llm_rationale"), "candidate_count": step.get("n_llm_candidates"),
                               "n_tokens_in_memory": step.get("n_tokens_in_memory"), "gamma_flipped_selection": step.get("gamma_flipped_selection"),
                               "gamma_selection_shift": step.get("gamma_selection_shift"),
                               "score_components": {key: step.get(key) for key in ("score_mu", "score_beta_sigma", "score_lam_G", "score_gamma_Lambda", "score_llm", "counterfactual_gamma_Lambda")}},
                      "response": {"y_raw": step["y_raw"], "y_internal": step.get("y_internal"), "source_mode": "offline_dataset_replay"},
                      "status": "completed", "source": src}
        if step["chose_by"] == "reasoning_llm_proposed":
            if cache_index:
                prior_deliveries = [t for (round_, recipient), group in by_recipient.items() if recipient == a and round_ < r for t in group]
                prior_local = [s for s in local_by_agent[a] if s["round"] < r]
                match = cache_index.match(step, (prior_deliveries, prior_local))
            else:
                match = {"matchStatus": "not_attempted"}
            matches[match["matchStatus"]] += 1
            experiment["source"].update({k: match[k] for k in ("matchStatus", "cacheKey") if k in match})
            if match.get("matchStatus") == "contextual_unique":
                prompts[experiment_id] = match
                prompt_targets[experiment_id] = (r, a)
                context_offsets[str(match["roundCounterOffset"])] += 1
                response = json.loads(match["response"])
                chosen_index = next((i for i, candidate in enumerate(response.get("candidates", [])) if _theta(candidate) == tuple(step["theta_int"])), None)
                experiment["args"]["proposalEvidence"] = {"hypotheses": response.get("hypotheses", []),
                    "candidates": response.get("candidates", []), "selectedCandidateIndex": chosen_index,
                    "matchStatus": "contextual_unique", "cacheKey": match["cacheKey"]}
                experiment["args"]["promptEvidence"] = {
                    "promptObservationCount": match["promptObservationCount"],
                    "localObservations": [{**observation, "localExperimentId": _id(run, observation["round"], a, "experiment")}
                                           for observation in match["localObservations"]],
                    "peerMessages": [{**peer, "receptionId": _id(run, peer["round"], a, f"reception-from-{peer['from']}")}
                                     for peer in match["peers"]]}
            else:
                experiment["diagnostics"] = [{"kind": "cache_match", "severity": "info", "description": f"Proposal cache join {match['matchStatus']}; proposal evidence unavailable."}]
        else:
            experiment["source"]["proposalJoinStatus"] = "unknown_not_joined"
        events.append(experiment)
        if step["y_raw"] > local_bests[a]:
            local_bests[a] = step["y_raw"]
            outcomes.append({"id": _id(run, r, a, "local-best"), "name": "New agent best", "metric": "agent_best_yield",
                             "value": local_bests[a], "eventId": experiment_id, "round": r, "direction": "higher",
                             "scope": "participant", "kind": "improvement"})

    for r in range(cfg["n_rounds"]):
        system_best.append(max(step_by_key[r, a]["best_so_far_raw"] for a in range(n_agents)))
        for a in range(n_agents):
            step = step_by_key[r, a]
            source_tokens = by_source[r, a]
            insight = _insight(source_tokens[0]) if source_tokens else ""
            encode_match = cache_index.match_encode(insight, a, r, step.get("theta_phys", []), step["y_raw"]) if cache_index and insight else {"matchStatus": "not_attempted"}
            if insight:
                encode_matches[encode_match["matchStatus"]] += 1
            emitted = source_tokens[0] if source_tokens else None
            publication_id = _id(run, r, a, "publication")
            communicated_payload = {"theta": emitted["theta"] if emitted else step["theta_int"],
                                    "yield": step["y_raw"], "label": emitted["s"] if emitted else None,
                                    "confidence": emitted["c"] if emitted else None, "eta": emitted["eta"] if emitted else None,
                                    "insight": insight}
            events.append({"id": publication_id, "name": "Publish experiment information", "eventType": "information_publication",
                           "agentId": f"agent-{a}", "participantIds": [f"agent-{a}"], "role": "laboratory", "round": r,
                           "phase": "communication", "args": {"sourceExperimentId": _id(run, r, a, "experiment"),
                           "sourceRound": r,
                           "sourcePayload": {"theta": step["theta_int"], "yield": step["y_raw"]},
                           "communicatedPayload": communicated_payload, "source_theta": step["theta_int"],
                           "communicated_theta": emitted["theta"] if emitted else step["theta_int"], "source_yield": step["y_raw"],
                           "label": emitted["s"] if emitted else None, "confidence": emitted["c"] if emitted else None,
                           "eta": emitted["eta"] if emitted else None,
                           "encodeMatchStatus": encode_match["matchStatus"]}, "response": insight, "status": "completed",
                           "source": {"file": source_name, "jsonPointer": f"/token_log/{token_pointers[r, a, emitted['to']]}" if emitted else f"/steps/{step_pointers[r, a]}",
                                      "experimentPointer": f"/steps/{step_pointers[r, a]}"}})
            experiment_id = _id(run, r, a, "experiment")
            links.append({"source": experiment_id, "target": publication_id, "relation": "publishes", "evidenceLevel": "direct"})
            for token in source_tokens:
                recipient = token["to"]
                reception_id = _id(run, r, recipient, f"reception-from-{a}")
                altered = token["theta"] != step["theta_int"]
                received_payload = {"theta": token["theta"], "yield": step["y_raw"], "label": token["s"],
                                    "confidence": token["c"], "eta": token["eta"], "insight": _insight(token)}
                reception = {"id": reception_id, "name": "Receive experiment information", "eventType": "information_reception",
                            "agentId": f"agent-{recipient}", "participantIds": [f"agent-{a}", f"agent-{recipient}"],
                            "role": "laboratory", "round": r, "phase": "communication",
                            "args": {"sender": f"agent-{a}", "sourceExperimentId": _id(run, r, a, "experiment"),
                                     "sourcePublicationId": publication_id, "sourceRound": r, "receivedRound": r,
                                     "sourcePayload": {"theta": step["theta_int"], "yield": step["y_raw"]},
                                     "communicatedPayload": communicated_payload,
                                     "payload": received_payload, "source_theta": step["theta_int"], "received_theta": token["theta"],
                                     "source_yield": step["y_raw"], "label": token["s"], "confidence": token["c"], "eta": token["eta"],
                                     "insight": _insight(token)}, "response": _insight(token), "status": "completed",
                            "source": {"file": source_name, "jsonPointer": f"/token_log/{token_pointers[r, a, recipient]}",
                                       "sourceExperimentPointer": f"/steps/{step_pointers[r, a]}"}}
                if altered:
                    reception["diagnostics"] = [{"kind": "payload_altered", "severity": "info", "description": "Received theta differs from source experiment theta."}]
                events.append(reception)
                links.append({"source": publication_id, "target": reception_id, "relation": "delivered_to", "evidenceLevel": "direct"})

    for experiment_id, matched_prompt in prompts.items():
        target_round, recipient = prompt_targets[experiment_id]
        for peer in matched_prompt["peers"]:
            sender, source_round = peer["from"], peer["round"]
            links.append({"source": _id(run, source_round, recipient, f"reception-from-{sender}"), "target": experiment_id,
                          "relation": "used_shared_evidence", "evidenceLevel": "contextual_unique",
                          "evidence": ["matched cache prompt contains the exact round, sender, received tuple, and insight"]})
        for observation in matched_prompt["localObservations"]:
            source_round = observation["round"]
            links.append({"source": _id(run, source_round, recipient, "experiment"), "target": experiment_id,
                          "relation": "used_local_evidence", "evidenceLevel": "contextual_unique",
                          "evidence": ["matched cache prompt contains the exact local round, tuple, and yield"]})

    for r, value in enumerate(system_best):
        if value > max(system_best[:r], default=float("-inf")):
            agent = next(a for a in range(n_agents) if step_by_key[r, a]["y_raw"] == value)
            outcomes.append({"id": _id(run, r, "system", "global-best"), "name": "New system best", "metric": "system_best_yield",
                             "value": value, "eventId": _id(run, r, agent, "experiment"), "round": r, "direction": "higher",
                             "scope": "system", "kind": "improvement"})
    for threshold in (95, 99, 100):
        hit = next((r for r, value in enumerate(system_best) if value >= threshold), None)
        if hit is not None:
            agent = next(a for a in range(n_agents) if step_by_key[hit, a]["y_raw"] >= threshold)
            outcomes.append({"id": _id(run, hit, "system", f"threshold-{threshold}"), "name": f"First system yield ≥{threshold}",
                             "metric": "system_yield_threshold", "value": threshold,
                             "eventId": _id(run, hit, agent, "experiment"), "round": hit, "direction": "higher",
                             "scope": "system", "kind": "threshold"})
    if system_best:
        final_value = max(system_best)
        best_round = next(r for r, value in enumerate(system_best) if value == final_value)
        best_agent = next(a for a in range(n_agents) if step_by_key[best_round, a]["y_raw"] == final_value)
        outcomes.append({"id": _id(run, best_round, "system", "final-best"), "name": "Final system best yield",
                         "metric": "system_best_yield", "value": final_value,
                         "eventId": _id(run, best_round, best_agent, "experiment"), "round": best_round,
                         "observedThroughRound": len(system_best) - 1, "direction": "higher",
                         "scope": "system", "kind": "final", "terminal": True})
    score_end = min(19, len(system_best) - 1)
    score = sum(system_best[:score_end + 1]) / (score_end + 1)
    warnings = ["All yields are offline dataset replay outcomes.", "Cache row counts do not identify executed model request counts.",
                "Proposal joins represent only verified selected LLM contexts; other selection methods have unknown proposal context.",
                "Cache observation counts describe local prompt context and may differ from workflow round; joins use verified local and peer evidence."]
    trace = {"id": run, "eventSchemaVersion": SCHEMA, "participants": participants, "events": events, "eventLinks": links,
            "outcomes": outcomes, "score": score, "scoreMetric": "best_yield_auc_20", "task_id": f"suzuki_edbo:{data['heterogeneity']}",
            "config": _decode_config(cfg), "final_yield": data["final_system_best"],
            "rounds_to_100": next((r + 1 for r, value in enumerate(system_best) if value >= 100), None), "seed": data["seed"],
            "rounds_to_best": best_round + 1,
            "best_reached_during_warmup": best_round < cfg["warmup_rounds"],
            "importMetadata": {"sourceFile": source_name, "experimentCount": len(steps), "deliveryCount": len(tokens),
                               "scoreWindowEnd": score_end, "featureWindowEnd": min(9, score_end - 1), "cacheMatchCounts": dict(matches),
                               "cacheRecordCounts": cache_index.record_counts if cache_index else {},
                               "cachePromptObservationCounts": dict(cache_index.prompt_observation_counts) if cache_index else {},
                               "indexedProposalCandidateRows": cache_index.proposal_rows if cache_index else 0,
                               "cacheCountsAreNotRequestCounts": True,
                               "encodeMatchCounts": dict(encode_matches) if cache_index else {},
                               "cacheObservationCounterOffsets": dict(context_offsets),
                               "cacheJoinIdentity": "contextual evidence; cache has no run foreign key",
                               "encodeEnrichment": "attempted" if cache_index else "not_attempted", "warnings": warnings}}
    return prune_after_result(trace, _id(run, best_round, best_agent, "experiment"))


def import_run(path, cache=None, _cache_index=None):
    path = Path(path)
    data = json.loads(path.read_text())
    owns_index = _cache_index is None and cache is not None
    index = _cache_index or (_CacheIndex(cache) if cache else None)
    try:
        return import_record(data, path.name, index)
    finally:
        if owns_index:
            index.close()


def iter_batch(source, cache=None):
    index = _CacheIndex(cache) if cache else None
    try:
        for path in sorted(Path(source).glob("HET-ADKO_seed*.json")):
            yield import_run(path, _cache_index=index)
    finally:
        if index:
            index.close()


def import_batch(source, cache=None):
    return list(iter_batch(source, cache))


def main():
    parser = argparse.ArgumentParser(description="Convert cooperative chemistry runs to workflow-events-v1 JSONL.")
    parser.add_argument("source", type=Path, help="Folder containing HET-ADKO_seed*.json")
    parser.add_argument("output", type=Path, help="Destination JSONL file")
    parser.add_argument("--cache", type=Path, help="Optional read-only SQLite cache")
    args = parser.parse_args()
    raw_paths = {path.resolve() for path in args.source.glob("HET-ADKO_seed*.json")}
    if args.output.resolve() in raw_paths or (args.cache and args.output.resolve() == args.cache.resolve()):
        parser.error("Output path must be separate from the raw run files and cache.")
    with args.output.open("w") as output:
        for trace in iter_batch(args.source, args.cache):
            output.write(json.dumps(trace, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
