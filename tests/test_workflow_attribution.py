import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / 'agent_provenance_backend'))

from workflow_attribution import fit_workflow_attribution


def runs(size=20):
    return [{'traceId': f't{i}', 'taskId': 'task', 'scoreMetric': 'quality',
             'score': float(i % 2) + (i % 5) * .01,
             'workflow': {'patternFeatures': {'handoff': float(i % 2), 'noise': float(i % 5),
                                               'constant': 1.0},
                          'featureWindowEnd': 9, 'scoreWindowEnd': 19}}
            for i in range(size)]


def model(entries):
    return fit_workflow_attribution(entries)['cohorts'][0]


def test_linear_shapley_values_reconstruct_centered_prediction():
    fitted = model(runs())
    assert fitted['patterns']
    assert set(fitted['featureNormalization']) == set(fitted['patterns'])
    assert fitted['scoreNormalization']['scale'] > 0
    for trace, prediction in fitted['predictedScores'].items():
        contribution = sum(pattern['perTrace'][trace] for pattern in fitted['patterns'].values())
        assert abs(prediction - fitted['baseline'] - contribution) < 1e-5
    assert abs(sum(fitted['patterns']['handoff']['perTrace'].values())) < 1e-5


def test_ten_runs_are_labeled_exploratory():
    fitted = model(runs(10))
    assert fitted['sampleCount'] == 10
    assert fitted['status'] == 'exploratory'


def test_constant_score_and_constant_features_are_not_attributed():
    entries = runs()
    for entry in entries:
        entry['score'] = 1
    assert model(entries)['status'] == 'insufficient'
    entries = runs()
    for entry in entries:
        entry['workflow']['patternFeatures'] = {'constant': 1}
    fitted = model(entries)
    assert fitted['status'] == 'not_identifiable'
    assert fitted['patterns'] == {}


def test_duplicate_run_ids_are_excluded_as_nonindependent():
    entries = runs(10)
    entries.append(dict(entries[0]))
    fitted = model(entries)
    assert fitted['sampleCount'] == 9
    assert 't0' not in fitted.get('predictedScores', {})


def test_future_features_and_missing_cases_are_omitted():
    entries = runs(10)
    entries[0]['workflow']['featureWindowEnd'] = 19
    entries[1]['workflow']['patternFeatures']['handoff'] = None
    fitted = model(entries)
    assert fitted['sampleCount'] == 8
    assert 't0' not in fitted.get('predictedScores', {})
    assert 't1' not in fitted.get('predictedScores', {})


def test_a_missing_feature_key_omits_that_run_without_zero_filling():
    entries = runs(10)
    del entries[1]['workflow']['patternFeatures']['handoff']
    fitted = model(entries)
    assert fitted['sampleCount'] == 9
    assert 't1' not in fitted.get('predictedScores', {})


def test_missing_temporal_windows_do_not_create_numeric_importance():
    entries = runs(10)
    for entry in entries:
        entry['workflow'].pop('featureWindowEnd')
    fitted = model(entries)
    assert fitted['status'] == 'insufficient'
    assert fitted['patterns'] == {}

