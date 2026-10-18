import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / 'agent_provenance_backend'))

from workflow_insights import build_workflow_insights


def run(trace_id='r1', offset=0):
    events = [
        {'id': f'{trace_id}:e0', 'eventType': 'experiment', 'agentId': 'a', 'round': 0,
         'timeIndex': 0, 'args': {'selected_conditions': {'x': offset}}, 'response': {'y': 5}},
        {'id': f'{trace_id}:p', 'eventType': 'information_publication', 'agentId': 'a', 'round': 0,
         'timeIndex': 1, 'args': {'sourcePayload': {'x': offset}, 'communicatedPayload': {'x': offset}}},
        {'id': f'{trace_id}:d', 'eventType': 'information_reception', 'agentId': 'b', 'round': 1,
         'timeIndex': 2, 'args': {'sourcePayload': {'x': offset}, 'payload': {'x': offset}}},
        {'id': f'{trace_id}:e1', 'eventType': 'experiment', 'agentId': 'b', 'round': 2,
         'timeIndex': 3, 'args': {'selected_conditions': {'x': offset}, 'proposalEvidence': {'candidates': []}}, 'response': {'y': 9}},
        {'id': f'{trace_id}:p1', 'eventType': 'information_publication', 'agentId': 'b', 'round': 2,
         'timeIndex': 4},
    ]
    links = [
        {'source': f'{trace_id}:e0', 'target': f'{trace_id}:p', 'relation': 'publishes'},
        {'source': f'{trace_id}:p', 'target': f'{trace_id}:d', 'relation': 'delivered_to'},
        {'source': f'{trace_id}:d', 'target': f'{trace_id}:e1', 'relation': 'used_shared_evidence'},
        {'source': f'{trace_id}:e1', 'target': f'{trace_id}:p1', 'relation': 'publishes'},
    ]
    outcomes = [
        {'id': f'{trace_id}:o0', 'name': 'Best', 'metric': 'yield', 'value': 5,
         'eventId': f'{trace_id}:e0', 'round': 0, 'direction': 'higher'},
        {'id': f'{trace_id}:o1', 'name': 'Best', 'metric': 'yield', 'value': 9,
         'eventId': f'{trace_id}:e1', 'round': 2, 'direction': 'higher'},
    ]
    return {'traceId': trace_id, 'score': 9 + offset, 'scoreMetric': 'yield_auc', 'calls': events,
            'workflow': {'participants': [{'id': 'a', 'role': 'planner'}, {'id': 'b', 'role': 'planner'}],
                         'eventLinks': links, 'outcomes': outcomes, 'roundCount': 3}}


def test_agent_activity_counts_and_prompt_evidence_are_nested():
    insights = build_workflow_insights([run()])
    timing = insights['timing']['runs'][0]
    assert timing['roundCount'] == 3
    assert timing['communication']['publications'] == 2
    assert timing['communication']['receptions'] == 1
    assert timing['communication']['promptExposures'] == 1
    assert timing['communication']['deliveryLag'] == {'count': 1, 'meanRounds': 1, 'maxRounds': 1}
    agents = {item['agentId']: item for item in timing['activitiesByAgent']}
    assert agents['a']['activityCounts'] == {'experiment': 1, 'information_publication': 1}
    assert agents['b']['activityCounts'] == {'experiment': 1, 'information_publication': 1,
                                             'information_reception': 1}


def test_source_payload_comparison_ignores_added_communication_metadata():
    entry = run()
    entry['calls'][2]['args']['payload']['insight'] = 'Additional interpretation'
    comm = build_workflow_insights([entry])['timing']['aggregate']
    assert comm['sourcePayloadMismatchCount'] == 0
    entry['calls'][2]['args']['payload']['x'] = 10
    comm = build_workflow_insights([entry])['timing']['aggregate']
    assert comm['sourcePayloadMismatchCount'] == 1


def test_non_chemistry_work_uses_consistent_exposure_lags_and_skill_types():
    entries = [run('r1'), run('r2')]
    for entry in entries:
        entry['calls'][0]['eventType'] = 'tool_execution'
        entry['calls'][3]['eventType'] = 'review'
        entry['workflow']['eventLinks'].append({'source': entry['calls'][0]['id'],
            'target': entry['calls'][3]['id'], 'relation': 'used_local_evidence'})
    result = build_workflow_insights(entries)
    aggregate = result['timing']['aggregate']
    assert aggregate['exposureLag']['count'] == sum(row['communication']['exposureLag']['count'] for row in result['timing']['runs'])
    assert aggregate['localExposureCount'] == 2
    assert any(skill['patternTypes'][1] == 'review' for skill in result['skills'])


def test_payload_alteration_uses_explicit_delivery_and_outcomes_have_recorded_witness():
    entry = run()
    entry['calls'][1]['args']['communicatedPayload'] = {'x': 100}
    result = build_workflow_insights([entry])
    comm = result['timing']['runs'][0]['communication']
    assert comm['transportMismatchCount'] == 1
    assert comm['sourcePayloadMismatchCount'] == 0
    outcome = result['outcomes']['runs'][0]
    assert outcome['scoreMetric'] == 'yield_auc' and outcome['score'] == 9
    metric = outcome['metrics'][0]
    assert metric['first']['value'] == 5 and metric['final']['value'] == 9
    assert metric['best']['eventId'] == 'r1:e1'
    assert metric['finalMeaning'] == 'last_recorded_milestone'
    witness = result['keySteps']['runs'][0]['metrics'][0]['witness']
    assert [item['eventId'] for item in witness] == ['r1:e0', 'r1:p', 'r1:d', 'r1:e1']
    assert witness[1]['agentId'] == 'a' and witness[2]['agentId'] == 'b'
    assert witness[2]['relationToNext'] == 'used_shared_evidence'


def test_terminal_outcome_marks_observation_horizon_separately_from_event_round():
    entry = run()
    entry['workflow']['outcomes'].append({'id': 'terminal', 'name': 'Final', 'metric': 'yield',
        'value': 9, 'eventId': 'r1:e1', 'round': 2, 'direction': 'higher',
        'observedThroughRound': 9, 'terminal': True, 'kind': 'final'})
    entry.pop('score')
    insights = build_workflow_insights([entry])
    final_metric = next(metric for metric in insights['outcomes']['runs'][0]['metrics'] if metric['name'] == 'Final')
    assert final_metric['finalMeaning'] == 'terminal_outcome'
    assert final_metric['final']['round'] == 2
    assert final_metric['final']['observedThroughRound'] == 9
    assert insights['outcomes']['runs'][0]['score'] is None


def test_skills_need_repeated_independent_runs_and_are_labeled_candidates():
    one = run('r1')
    two = run('r2')
    result = build_workflow_insights([one, two])
    assert result['scope']['runCount'] == 2
    assert result['skills']
    assert all(skill['status'] == 'candidate' and skill['runSupport'] == 2 for skill in result['skills'])
    assert all('not validated' in skill['limitations'] for skill in result['skills'])
    assert build_workflow_insights([one])['skills'] == []


def test_missing_lag_and_payload_stay_unknown_and_duplicate_run_is_excluded():
    entry = run('r1')
    entry['workflow']['eventLinks'] = []
    entry['calls'][1]['args'].pop('communicatedPayload')
    entry['calls'][2]['args'].pop('payload')
    result = build_workflow_insights([entry, run('r1', 10)])
    assert result['scope']['runCount'] == 0
    single = build_workflow_insights([entry])
    communication = single['timing']['runs'][0]['communication']
    assert communication['linkedDeliveries'] == 0
    assert communication['sourcePayloadMismatchCount'] == 0
    assert communication['transportMismatchCount'] == 0
    assert communication['deliveryLag'] == {'count': 0, 'meanRounds': None, 'maxRounds': None}

