"""Exploratory observational attribution for workflow pattern features."""

from collections import defaultdict
from hashlib import sha256
from functools import lru_cache
import json
import math
import random

from score_attribution import _fit

MAX_FEATURES = 16
BOOTSTRAPS = 100


def _number(value):
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _cv_gain(rows, names):
    """Cross-validated R2 gain with all scaling learned in each training fold."""
    n = len(rows)
    fold_count = min(5, n)
    order = sorted(range(n), key=lambda i: sha256(rows[i]['traceId'].encode()).hexdigest())
    folds = {index: rank % fold_count for rank, index in enumerate(order)}
    model_error = baseline_error = 0.0
    for fold in range(fold_count):
        train = [i for i in range(n) if folds[i] != fold]
        test = [i for i in range(n) if folds[i] == fold]
        train_means = [sum(rows[i]['features'][name] for i in train) / len(train) for name in names]
        train_scales = [math.sqrt(sum((rows[i]['features'][name] - train_means[j]) ** 2
                                      for i in train) / len(train))
                        for j, name in enumerate(names)]
        train_scales = [scale or 1.0 for scale in train_scales]
        score_mean = sum(rows[i]['score'] for i in train) / len(train)
        score_scale = math.sqrt(sum((rows[i]['score'] - score_mean) ** 2 for i in train) / len(train))
        if not score_scale:
            return None
        train_x = [[(rows[i]['features'][name] - train_means[j]) / train_scales[j]
                    for j, name in enumerate(names)] for i in train]
        train_y = [(rows[i]['score'] - score_mean) / score_scale for i in train]
        beta, means, intercept = _fit(train_x, train_y)
        for i in test:
            actual = (rows[i]['score'] - score_mean) / score_scale
            test_x = [(rows[i]['features'][name] - train_means[j]) / train_scales[j]
                      for j, name in enumerate(names)]
            predicted = intercept + sum(beta[j] * (test_x[j] - means[j])
                                        for j in range(len(names)))
            model_error += (actual - predicted) ** 2
            baseline_error += actual ** 2
    return (baseline_error - model_error) / baseline_error if baseline_error else None


def _fit_cohort(task, metric, entries):
    output = {
        'taskId': task, 'scoreMetric': metric, 'sampleCount': 0,
        'status': 'insufficient',
        'method': 'observational centered linear ridge with exact marginal-background Shapley values',
        'normalization': 'feature and score population z-scores within task and score metric',
        'featureWindowEnd': None, 'scoreWindowEnd': None, 'concerns': [],
        'patterns': {}, 'cvGain': None,
    }
    eligible = []
    duplicate_ids = set()
    seen = set()
    for entry in entries:
        trace = entry.get('traceId')
        if trace is None:
            continue
        trace = str(trace)
        if trace in seen:
            duplicate_ids.add(trace)
        seen.add(trace)
    for entry in entries:
        trace = str(entry.get('traceId')) if entry.get('traceId') is not None else None
        workflow = entry.get('workflow')
        if trace is None or trace in duplicate_ids or not isinstance(workflow, dict):
            continue
        feature_end = _number(workflow.get('featureWindowEnd'))
        score_end = _number(workflow.get('scoreWindowEnd'))
        score = _number(entry.get('score'))
        features = workflow.get('patternFeatures')
        if (feature_end is None or score_end is None or feature_end >= score_end or score is None
                or not isinstance(features, dict)):
            continue
        values = {str(name): _number(value) for name, value in features.items()}
        eligible.append({'traceId': trace, 'score': score, 'featureEnd': feature_end,
                         'scoreEnd': score_end, 'features': values})
    output['sampleCount'] = len(eligible)
    if not eligible:
        output['concerns'] = ['no runs have usable scores, features, and ordered temporal windows']
        return output
    windows = {(row['featureEnd'], row['scoreEnd']) for row in eligible}
    if len(windows) != 1:
        output['status'] = 'unavailable'
        output['concerns'] = ['inconsistent feature or score window boundaries']
        return output
    output['featureWindowEnd'], output['scoreWindowEnd'] = next(iter(windows))
    if len({row['score'] for row in eligible}) < 2:
        output['concerns'] = ['score outcome is constant']
        return output

    names = sorted({name for row in eligible for name in row['features']})
    varying = []
    for name in names:
        values = [row['features'].get(name) for row in eligible]
        observed = [value for value in values if value is not None]
        if len(observed) >= 2 and len(set(observed)) > 1:
            varying.append(name)
    if not varying:
        output['status'] = 'not_identifiable'
        output['concerns'] = ['no complete, variable pattern features']
        return output

    # Missing values are omitted as complete cases; they are never encoded as zero.
    rows = [row for row in eligible if all(row['features'].get(name) is not None for name in varying)]
    names = [name for name in varying if len({row['features'].get(name) for row in rows}) > 1]
    if not names:
        output['status'] = 'not_identifiable'
        output['concerns'] = ['no variable features remain among complete cases']
        output['sampleCount'] = len(rows)
        return output
    n = len(rows)
    output['sampleCount'] = n
    if n < 4 or len({row['score'] for row in rows}) < 2:
        output['concerns'] = ['too few complete cases or fewer than two distinct scores']
        return output

    variances = {name: sum((row['features'][name] - sum(r['features'][name] for r in rows) / n) ** 2
                           for row in rows) / n for name in names}
    names.sort(key=lambda name: (-variances[name], name))
    names = names[:min(MAX_FEATURES, n // 2)]
    raw_x = [[row['features'][name] for name in names] for row in rows]
    means = [sum(row[j] for row in raw_x) / n for j in range(len(names))]
    scales = [math.sqrt(sum((row[j] - means[j]) ** 2 for row in raw_x) / n)
              for j in range(len(names))]
    y_mean = sum(row['score'] for row in rows) / n
    y_scale = math.sqrt(sum((row['score'] - y_mean) ** 2 for row in rows) / n)
    if not y_scale:
        output['concerns'] = ['score outcome is constant among complete cases']
        return output
    x = [[(row[j] - means[j]) / scales[j] for j in range(len(names))] for row in raw_x]
    y = [(row['score'] - y_mean) / y_scale for row in rows]
    beta, x_means, intercept = _fit(x, y)
    cv_gain = _cv_gain(rows, names)
    rng = random.Random(20261018)
    sign_counts = [0] * len(names)
    valid_bootstraps = 0
    for _ in range(BOOTSTRAPS):
        indices = [rng.randrange(n) for _ in range(n)]
        sample_y = [y[i] for i in indices]
        if len(set(sample_y)) < 2:
            continue
        sample_beta, _, _ = _fit([x[i] for i in indices], sample_y)
        valid_bootstraps += 1
        for j, value in enumerate(sample_beta):
            if beta[j] * value > 0:
                sign_counts[j] += 1
    stability = [count / valid_bootstraps if valid_bootstraps else 0 for count in sign_counts]
    predictions = [intercept + sum(beta[j] * (row[j] - x_means[j]) for j in range(len(names)))
                   for row in x]
    concerns = []
    if n < 20:
        concerns.append('small cohort')
    if cv_gain is None or cv_gain <= 0:
        concerns.append('no held-out predictive gain')
    if min(stability, default=0) < 0.7:
        concerns.append('unstable coefficient signs')
    output.update(status='exploratory' if concerns else 'available', concerns=concerns,
                  cvGain=round(cv_gain, 4) if cv_gain is not None else None,
                  baseline=round(intercept, 6),
                  featureNormalization={name: {'mean': means[j], 'scale': scales[j]}
                                        for j, name in enumerate(names)},
                  scoreNormalization={'mean': y_mean, 'scale': y_scale},
                  predictedScores={row['traceId']: round(prediction, 6)
                                   for row, prediction in zip(rows, predictions)})
    for j, name in enumerate(names):
        per_trace = {row['traceId']: beta[j] * (x[i][j] - x_means[j])
                     for i, row in enumerate(rows)}
        output['patterns'][name] = {
            'coefficient': round(beta[j], 6),
            'importance': round(sum(abs(value) for value in per_trace.values()) / n, 6),
            'stability': round(stability[j], 3),
            'perTrace': {trace: round(value, 6) for trace, value in per_trace.items()},
        }
    return output


@lru_cache(maxsize=32)
def _cached_models(payload):
    groups = defaultdict(list)
    for entry in json.loads(payload):
        if not isinstance(entry, dict) or entry.get('taskId') is None:
            continue
        metric = str(entry.get('scoreMetric') or 'score')
        groups[(str(entry['taskId']), metric)].append(entry)
    return {'cohorts': [_fit_cohort(task, metric, entries)
                        for (task, metric), entries in sorted(groups.items())]}


def fit_workflow_attribution(analyses: list) -> dict:
    """Reuse cohort fits when a selection changes but its measured corpus does not."""
    prepared = [{key: entry.get(key) for key in ('traceId', 'taskId', 'score', 'scoreMetric', 'workflow')}
                for entry in analyses if isinstance(entry, dict)]
    for entry in prepared:
        workflow = entry.get('workflow')
        if isinstance(workflow, dict):
            entry['workflow'] = {key: workflow.get(key) for key in ('patternFeatures', 'featureWindowEnd', 'scoreWindowEnd')}
    return _cached_models(json.dumps(prepared, sort_keys=True, ensure_ascii=False))
