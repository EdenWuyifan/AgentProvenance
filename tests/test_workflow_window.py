from copy import deepcopy

from agent_provenance.workflow_window import prune_after_result


def example():
    return {
        'id': 'generic-workers', 'score': 0.87, 'scoreMetric': 'fixed-budget-quality',
        'events': [
            {'id': 'old', 'name': 'Acquire input', 'round': 0, 'patterns': ['acquisition']},
            {'id': 'message', 'name': 'Share', 'round': 1, 'patterns': ['handoff']},
            {'id': 'best', 'name': 'Verify artifact', 'round': 4, 'patterns': ['verification']},
            {'id': 'same-round', 'name': 'Publish result', 'round': 4, 'patterns': ['handoff']},
            {'id': 'later', 'name': 'Independent improvement', 'round': 5, 'patterns': ['exploration']},
        ],
        'eventLinks': [{'source': 'old', 'target': 'message'}, {'source': 'message', 'target': 'best'},
                       {'source': 'best', 'target': 'same-round'}, {'source': 'same-round', 'target': 'later'}],
        'outcomes': [{'eventId': 'best', 'value': 0.99, 'kind': 'final', 'observedThroughRound': 5},
                     {'eventId': 'later', 'value': 0.9, 'scope': 'participant'}],
        'importMetadata': {'featureWindowEnd': 4, 'scoreWindowEnd': 5},
    }


def test_prefix_retains_old_ancestors_whole_terminal_round_and_literal_links():
    trace = example()
    source = deepcopy(trace)
    cropped = prune_after_result(trace, 'best')
    assert trace == source
    assert [event['id'] for event in cropped['events']] == ['old', 'message', 'best', 'same-round']
    assert cropped['eventLinks'] == trace['eventLinks'][:3]
    assert cropped['outcomes'] == trace['outcomes'][:1]
    assert cropped['outcomes'][0]['observedThroughRound'] == 5
    assert cropped['score'] == trace['score']
    assert cropped['scoreMetric'] == trace['scoreMetric']
    metadata = cropped['importMetadata']
    assert metadata['sourcePatternFeatures'] == {'acquisition': 1, 'handoff': 2, 'verification': 1}
    assert metadata['featureWindowEnd'] == 4 and metadata['scoreWindowEnd'] == 5
    window = metadata['pruning']
    assert window['sourceEventCount'] == 5 and window['retainedEventCount'] == 4
    assert window['removedEventCount'] == window['removedLinkCount'] == 1
    assert window['retainedThroughRound'] == 4 and window['sourceThroughRound'] == 5


def test_first_round_success_has_no_later_activities_and_keeps_score_window_features():
    trace = example()
    cropped = prune_after_result(trace, 'old')
    assert [event['id'] for event in cropped['events']] == ['old']
    assert cropped['eventLinks'] == []
    assert cropped['score'] == 0.87
    assert cropped['importMetadata']['sourcePatternFeatures'] == {
        'acquisition': 1, 'handoff': 2, 'verification': 1,
    }
    assert cropped['importMetadata']['scoreWindowEnd'] == 5
