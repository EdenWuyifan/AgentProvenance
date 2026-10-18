"""Predictive, cohort-local Shapley attribution for recorded family patterns."""

from collections import defaultdict
from hashlib import sha256
import json
import math
import random

from importance import numeric_score

_CACHE = {}
MAX_BOOTSTRAP_FEATURES = 32
VERSION = 'outcome-v2'


def _fit(x, y, ridge=1.0):
    n, p = len(x), len(x[0])
    means = [sum(row[j] for row in x) / n for j in range(p)]
    y_mean = sum(y) / n
    centered = [[row[j] - means[j] for j in range(p)] for row in x]
    residual = [value - y_mean for value in y]
    norms = [sum(row[j] ** 2 for row in centered) + ridge for j in range(p)]
    beta = [0.0] * p
    for _ in range(200):
        largest_change = 0.0
        for j in range(p):
            old = beta[j]
            numerator = sum(row[j] * (error + row[j] * old)
                            for row, error in zip(centered, residual))
            beta[j] = numerator / norms[j]
            change = beta[j] - old
            if change:
                residual = [error - row[j] * change for row, error in zip(centered, residual)]
                largest_change = max(largest_change, abs(change))
        if largest_change < 1e-8:
            break
    return beta, means, y_mean


def _cv_r2(x, y, entries):
    predictions, baselines = [0.0] * len(y), [0.0] * len(y)
    order = sorted(range(len(entries)), key=lambda i: sha256(str(entries[i]['traceId']).encode()).hexdigest())
    folds = {index: rank % min(5, len(entries)) for rank, index in enumerate(order)}
    for fold in range(min(5, len(entries))):
        train = [i for i in range(len(y)) if folds[i] != fold]
        test = [i for i in range(len(y)) if folds[i] == fold]
        beta, means, intercept = _fit([x[i] for i in train], [y[i] for i in train])
        baseline = sum(y[i] for i in train) / len(train)
        for i in test:
            predictions[i] = intercept + sum(beta[j] * (x[i][j] - means[j]) for j in range(len(beta)))
            baselines[i] = baseline
    denominator = sum((a - sum(y) / len(y)) ** 2 for a in y)
    if denominator == 0:
        return 0.0
    model_error = sum((a - b) ** 2 for a, b in zip(y, predictions))
    baseline_error = sum((a - b) ** 2 for a, b in zip(y, baselines))
    return (baseline_error - model_error) / denominator


def _fit_cohort(task, metric, entries):
    all_families = sorted({str(i["familyId"]) for e in entries for i in e.get("instances", [])})
    present = {f: sum(f in {str(i["familyId"]) for i in e.get("instances", [])} for e in entries)
               for f in all_families}
    variable = [f for f in all_families if present[f] >= 2 and len(entries) - present[f] >= 2]
    limit = min(MAX_BOOTSTRAP_FEATURES, len(entries) // 2)
    ranked = sorted(variable, key=lambda f: (-min(present[f], len(entries) - present[f]), -present[f], f))
    families = ranked[:limit]
    dropped = ranked[limit:]
    rows = [[int(f in {str(i["familyId"]) for i in e.get("instances", [])}) for f in families]
            for e in entries]
    scores = [float(e["score"]) for e in entries]
    output = {"taskId": task, "scoreMetric": metric, "sampleCount": len(entries),
              "familyIds": all_families, "variableFamilyIds": variable,
              "droppedFamilyIds": dropped, "families": {},
              "method": "exact marginal-background Shapley for a centered linear ridge predictor",
              "ridge": 1.0, "gates": {"minimumExecutionsForAvailableLabel": 20, "minimumDistinctScores": 2,
                                        "minimumPerClassSupport": 2, "minimumCVGain": 0,
                                        "minimumBootstrapSignStability": 0.7}}
    if len(set(scores)) < 2:
        output.update(status="insufficient", cvR2=None)
        return output
    if not variable:
        output.update(status="not_identifiable", cvR2=None)
        return output
    if not families:
        output.update(status="insufficient", cvR2=None)
        return output
    cv = _cv_r2(rows, scores, entries)
    beta, means, intercept = _fit(rows, scores)
    rng = random.Random(20261017)
    signs = [0] * len(families)
    for _ in range(100):
        indices = [rng.randrange(len(scores)) for _ in scores]
        sample_x, sample_y = [rows[i] for i in indices], [scores[i] for i in indices]
        if len(set(sample_y)) < 2:
            continue
        sample_beta, _, _ = _fit(sample_x, sample_y)
        for j, coefficient in enumerate(sample_beta):
            if beta[j] * coefficient > 0:
                signs[j] += 1
    stability = [s / 100 for s in signs]
    concerns = (["small cohort"] if len(entries) < 20 else [])
    if cv <= 0:
        concerns.append('no held-out predictive gain')
    if min(stability, default=0) < 0.7:
        concerns.append('unstable coefficient signs')
    output.update(status="exploratory" if concerns else "available", concerns=concerns,
                  cvR2=round(cv, 4), baseline=round(intercept, 6),
                  predictedScores={str(e["traceId"]): round(intercept + sum(
                      beta[k] * (row[k] - means[k]) for k in range(len(beta))), 6)
                                   for e, row in zip(entries, rows)})
    for j, family in enumerate(families):
        output["families"][family] = {
            "coefficient": round(beta[j], 6), "stability": round(stability[j], 3),
            "prevalence": round(means[j], 6), "presentCount": sum(row[j] for row in rows),
            "absentCount": len(rows) - sum(row[j] for row in rows),
            "distinctScoresPresent": len({score for score, row in zip(scores, rows) if row[j]}),
                "perTrace": {str(e["traceId"]): round(beta[j] * (row[j] - means[j]), 6)
                         for e, row in zip(entries, rows)},
        }
    return output


def _tool_data(entries, tools):
    groups = defaultdict(list)
    for entry in entries:
        groups[entry['taskId']].append(entry)
    stats, prepared = {}, []
    for task, group in sorted(groups.items()):
        if len({e['score'] for e in group}) < 2:
            continue
        mean = sum(e['score'] for e in group) / len(group)
        scale = math.sqrt(sum((e['score'] - mean) ** 2 for e in group) / len(group))
        if not scale:
            continue
        prevalence = [sum(tool in e['tools'] for e in group) / len(group) for tool in tools]
        stats[task] = {'mean': mean, 'scale': scale, 'prevalence': prevalence, 'count': len(group)}
        for entry in group:
            prepared.append((entry, [int(tool in entry['tools']) - p for tool, p in zip(tools, prevalence)],
                             (entry['score'] - mean) / scale))
    return stats, prepared


def _tool_coefficients(entries, tools):
    stats, data = _tool_data(entries, tools)
    if not data:
        return [], stats, data
    # Equal total weight per task. Both X and y are centered within task.
    weights = [math.sqrt(1 / stats[e['taskId']]['count']) for e, _, _ in data]
    beta, _, _ = _fit([[v * w for v in row] for (_, row, _), w in zip(data, weights)],
                      [y * w for (_, _, y), w in zip(data, weights)])
    return beta, stats, data


def _tool_cv(entries, tools):
    groups = defaultdict(list)
    for entry in entries:
        groups[entry['taskId']].append(entry)
    folds = {}
    for group in groups.values():
        for rank, entry in enumerate(sorted(group, key=lambda e: sha256(e['traceId'].encode()).hexdigest())):
            folds[entry['traceId']] = rank % 5
    model_error = baseline_error = 0.0
    evaluated = 0
    for fold in range(5):
        beta, stats, _ = _tool_coefficients([e for e in entries if folds[e['traceId']] != fold], tools)
        for entry in entries:
            if folds[entry['traceId']] != fold or entry['taskId'] not in stats:
                continue
            task = stats[entry['taskId']]
            actual = (entry['score'] - task['mean']) / task['scale']
            predicted = sum(b * (int(tool in entry['tools']) - p)
                            for b, tool, p in zip(beta, tools, task['prevalence']))
            weight = 1 / len(groups[entry['taskId']])
            model_error += weight * (actual - predicted) ** 2
            baseline_error += weight * actual ** 2
            evaluated += 1
    return ((baseline_error - model_error) / baseline_error if baseline_error else None), evaluated


def _fit_tools(metric, entries):
    all_tools = sorted({tool for entry in entries for tool in entry['tools']})
    stats, data = _tool_data(entries, all_tools)
    variable = [tool for j, tool in enumerate(all_tools)
                if any(0 < task['prevalence'][j] < 1 for task in stats.values())]
    output = {'scoreMetric': metric, 'sampleCount': len(data), 'taskCount': len(stats),
              'excludedExecutions': len(entries) - len(data), 'toolNames': all_tools, 'tools': {},
              'method': 'exact marginal-background linear Shapley with task-specific backgrounds',
              'normalization': 'within-task population z-score; within-task tool centering; equal task weights',
              'ridge': 1.0}
    if not variable:
        return {**output, 'status': 'not_identifiable', 'cvGain': None, 'cvEvaluated': 0}
    beta, stats, data = _tool_coefficients(entries, variable)
    cv, evaluated = _tool_cv(entries, variable)
    available = len(data) >= 20 and len(stats) >= 2 and evaluated >= 0.8 * len(data) and cv is not None and cv > 0
    output.update(status='available' if available else 'exploratory', cvGain=round(cv, 4) if cv is not None else None,
                  cvEvaluated=evaluated, baseline=0, predictedScores={
                      e['traceId']: round(sum(b * v for b, v in zip(beta, row)), 6) for e, row, _ in data},
                  taskBackgrounds={task: {'count': s['count'], 'scoreMean': s['mean'], 'scoreScale': s['scale']}
                                   for task, s in stats.items()})
    for j, tool in enumerate(variable):
        values = {e['traceId']: beta[j] * row[j] for e, row, _ in data}
        by_task = defaultdict(list)
        present = []
        varying_tasks = {task for task, s in stats.items() if 0 < s['prevalence'][j] < 1}
        for entry, _, _ in data:
            value = values[entry['traceId']]
            by_task[entry['taskId']].append(abs(value))
            if tool in entry['tools']:
                present.append((entry['taskId'], value))
        # Signed average over all traces is zero by construction; use |phi| for global importance.
        importance = sum(sum(v) / len(v) for v in by_task.values()) / len(by_task)
        present_tasks = defaultdict(list)
        for task, value in present:
            present_tasks[task].append(value)
        direction = sum(sum(v) / len(v) for v in present_tasks.values()) / len(present_tasks)
        output['tools'][tool] = {
            'status': 'available' if available and len(varying_tasks) >= 2 else 'exploratory',
            'coefficient': round(beta[j], 6), 'importance': round(importance, 6),
            'meanWhenPresent': round(direction, 6), 'varyingTaskCount': len(varying_tasks),
            'presentCount': len(present), 'absentCount': len(data) - len(present),
            'perTrace': {run: round(value, 6) for run, value in values.items()}}
    return output


def fit_score_models(reference: list, tool_reference=()) -> dict:
    """Memoized local patterns and cross-task tools; weak estimates are labeled exploratory."""
    canonical = sorted(({
        "traceId": str(entry["traceId"]), "taskId": str(entry["taskId"]),
        "scoreMetric": entry.get("scoreMetric") or "score", "score": entry["score"],
        "familyIds": sorted({str(i["familyId"]) for i in entry.get("instances", [])}),
    } for entry in reference if entry.get("taskId") is not None and numeric_score(entry.get("score"))),
        key=lambda entry: (entry["taskId"], str(entry["scoreMetric"]), entry["traceId"]))
    tool_canonical = sorted(({
        'traceId': str(e['traceId']), 'taskId': str(e['taskId']),
        'scoreMetric': e.get('scoreMetric') or 'score', 'score': e['score'],
        'tools': sorted(set(e['tools'])),
    } for e in tool_reference if e.get('taskId') is not None and numeric_score(e.get('score'))),
        key=lambda e: (e['scoreMetric'], e['taskId'], e['traceId']))
    key = sha256(json.dumps([VERSION, canonical, tool_canonical], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if key in _CACHE:
        return _CACHE[key]
    cohorts = defaultdict(list)
    for item in canonical:
        cohorts[(item["taskId"], item["scoreMetric"])].append({**item, "instances": [
            {"familyId": family} for family in item["familyIds"]]})
    result = {"cohorts": [_fit_cohort(task, metric, entries)
                          for (task, metric), entries in sorted(cohorts.items())]}
    tool_cohorts = defaultdict(list)
    for entry in tool_canonical:
        tool_cohorts[entry['scoreMetric']].append(entry)
    result['toolModels'] = [_fit_tools(metric, entries) for metric, entries in sorted(tool_cohorts.items())]
    _CACHE.clear()
    _CACHE[key] = result
    return result
