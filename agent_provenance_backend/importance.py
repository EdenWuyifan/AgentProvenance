"""Inspectable display decisions and cohort-conditioned observational statistics."""

import math
from collections import defaultdict
from statistics import mean, median


def numeric_score(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def score_summary(entries: list) -> dict:
    # A global average across unrelated tasks or metric scales is misleading.
    groups = {(e.get("taskId"), e.get("scoreMetric")) for e in entries if numeric_score(e.get("score"))}
    scores = [e["score"] for e in entries if numeric_score(e.get("score"))]
    if len(groups) != 1 or next(iter(groups), (None, None))[0] is None:
        return {"average": None, "maximum": None}
    return {"average": round(mean(scores), 4) if scores else None,
            "maximum": max(scores) if scores else None}


def outcome_statistics(family_id: str, reference: list) -> list:
    cohorts = defaultdict(list)
    for analysis in reference:
        if analysis.get("taskId") is not None and numeric_score(analysis.get("score")):
            cohorts[(str(analysis["taskId"]), analysis.get("scoreMetric", "score"))].append(analysis)
    results = []
    for (task, metric), entries in sorted(cohorts.items()):
        present, absent = [], []
        for entry in entries:
            occurs = any(i["familyId"] == family_id for i in entry["instances"])
            (present if occurs else absent).append(entry["score"])
        cut = median(e["score"] for e in entries)
        high = [e for e in entries if e["score"] > cut]
        low = [e for e in entries if e["score"] < cut]
        # Median ties do not get arbitrarily assigned to high or low.
        def rate(group):
            return sum(any(i["familyId"] == family_id for i in e["instances"]) for e in group) / len(group)
        lift = rate(high) - rate(low) if len(high) >= 2 and len(low) >= 2 else None
        results.append({
            "taskId": task, "scoreMetric": metric, "sampleCount": len(entries),
            "presentCount": len(present), "absentCount": len(absent),
            "meanPresent": mean(present) if present else None,
            "meanAbsent": mean(absent) if absent else None,
            "meanDifference": mean(present) - mean(absent) if present and absent else None,
            "scoreLift": lift, "higherScoreCount": len(high), "lowerScoreCount": len(low),
            "medianTieCount": len(entries) - len(high) - len(low),
            "interpretation": "observational association; higher score is not assumed to mean better",
        })
    return results


def assess_importance(family_id: str, members: list, reference: list, focus: str = "",
                      score_models: dict | None = None, tool_names=()) -> dict:
    """Explain semantic and result attention, with predictive attribution when supported."""
    reasons, facets = [], []
    supported = sorted({f"{item.get('traceId', member.get('traceId'))}:{item['claimId']}"
                        for member in members for item in member.get("resultEvidence", [])
                        if item.get("relation") == "supports"})
    contradicted = sorted({f"{item.get('traceId', member.get('traceId'))}:{item['claimId']}"
                           for member in members for item in member.get("resultEvidence", [])
                           if item.get("relation") == "contradicts"})
    targets = any(member.get("resultTargets") for member in members)
    backbone = any(member.get("resultBackbone") for member in members)
    key_stage = any(member.get('attention') == 'key' for member in members)
    failures = [d for member in members for d in member.get("diagnostics", [])
                if d.get("recorded") is True or d.get("status") == "error"]
    outcome = outcome_statistics(family_id, reference)
    from score_attribution import fit_score_models
    score_models = score_models or fit_score_models(reference)
    models = score_models["cohorts"]
    trace_ids = {str(member["traceId"]) for member in members}
    selected_cohorts = {(str(e['taskId']), e.get('scoreMetric') or 'score') for e in reference
                        if str(e.get('traceId')) in trace_ids and e.get('taskId') is not None}
    attribution = []
    statuses = []
    attributed_statuses = []
    local_cohorts = []
    predictive_focus = False
    for model in models:
        if str(family_id) not in model["familyIds"] or (model['taskId'], model['scoreMetric']) not in selected_cohorts:
            continue
        local_cohorts.append({'taskId': model['taskId'], 'sampleCount': model['sampleCount'], 'status': model['status']})
        family = model.get("families", {}).get(str(family_id))
        if family:
            statuses.append(model['status'])
            for trace, value in family["perTrace"].items():
                if trace not in trace_ids:
                    continue
                attribution.append({"traceId": trace, "taskId": model["taskId"],
                                    "scoreMetric": model["scoreMetric"], "value": value,
                                    "sampleCount": model['sampleCount'], 'stability': family['stability']})
                attributed_statuses.append(model['status'])
                strongest = max(abs(pattern["perTrace"][trace])
                                for pattern in model["families"].values())
                predictive_focus |= model['status'] == 'available' and bool(value) and abs(value) >= strongest
        else:
            if model["status"] == "available":
                statuses.append("insufficient" if family_id in model["droppedFamilyIds"] else "not_identifiable")
            else:
                statuses.append(model["status"])
    outcome_status = ('available' if all(s == 'available' for s in attributed_statuses) else 'exploratory') if attribution else (statuses[0] if statuses else 'unavailable')
    global_tools = []
    for model in score_models['toolModels']:
        for tool in tool_names:
            record = model['tools'].get(tool)
            if record:
                global_tools.append({k: v for k, v in record.items() if k != 'perTrace'} | {
                    'tool': tool, 'scoreMetric': model['scoreMetric'], 'sampleCount': model['sampleCount'],
                    'taskCount': model['taskCount'], 'cvGain': model['cvGain'],
                    'contributions': [{'traceId': trace, 'value': value} for trace, value in record['perTrace'].items()
                                      if trace in trace_ids]})
    recorded_result_statuses = {m.get("resultStatus") for m in members if m.get("resultStatus")}
    result_status = ("contradicted" if contradicted else "supported" if supported else
                     "referenced" if targets else "missing-final" if "missing-final" in recorded_result_statuses else
                     "no-candidates" if "no-candidates" in recorded_result_statuses else "none")
    decision, tier = "collapse", "context"
    if key_stage:
        decision, tier = "expand", "key"
        reasons.append("This stage is marked as a key analysis or decision.")
        facets.append({"id": "key-stage", "label": "Key stage"})
    if any(member.get('source') for member in members):
        reasons.append('This stage introduces a distinct external input consumed by downstream operations.')
        facets.append({'id': 'input', 'label': 'Independent input'})
    if supported or contradicted or targets:
        decision, tier = "expand", "result"
        reasons.append("This operation has direct evidence linked to a result claim.")
        facets.append({"id": "result", "label": "Result evidence"})
    elif backbone:
        reasons.append("This operation lies on a recorded dependency path to a selected result or interpreted output.")
        facets.append({"id": "result-path", "label": "Result path"})
    if failures:
        decision, tier = "expand", "failure"
        reasons.append("A tool call recorded a failure.")
        facets.append({"id": "failure", "label": "Recorded failure"})
    if attribution:
        reasons.append("This pattern has a predictive contribution within a task and metric cohort" +
                       ("; the estimate is exploratory." if outcome_status == 'exploratory' else "."))
        facets.append({"id": "outcome", "label": "Predictive score contribution"})
    if global_tools:
        reasons.append('Cross-task tool importance is included as outcome context, using within-task score standardization.')
    if predictive_focus:
        reasons.append("This pattern has the largest nonzero predictive contribution for a selected run.")
        facets.append({"id": "predictive-focus", "label": "Predictive focus"})
        if tier == "context":
            decision, tier = "expand", "key"
    if not reasons:
        reasons.append("Grouped by shared tool pattern; inspect its recorded inputs and outputs.")
    counts = {m["traceId"] for m in members}
    return {"decision": decision, "reasons": reasons, "support": len(counts),
            "outcomeStatistics": outcome or None, "tier": tier, "facets": facets,
            "semantic": {"level": "key" if key_stage else "supporting"},
            "result": {"status": result_status, "supportedClaims": supported,
                       "contradictedClaims": contradicted, "onRecordedPath": bool(backbone)},
            "outcome": {"status": outcome_status, "contributions": attribution or None,
                        'cohorts': local_cohorts, 'globalTools': global_tools}}
