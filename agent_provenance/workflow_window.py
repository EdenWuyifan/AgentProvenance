"""Deterministic result-prefix selection, independent of tools and participants."""

from collections import Counter


def prune_after_result(trace, event_id):
    events = trace['events']
    cutoff = next(event['round'] for event in events if event['id'] == event_id)
    retained = [event for event in events if event['round'] <= cutoff]
    retained_ids = {event['id'] for event in retained}
    links = trace['eventLinks']
    metadata = trace.get('importMetadata', {})
    feature_end = metadata.get('featureWindowEnd')
    features = Counter()
    if isinstance(feature_end, int):
        for event in events:
            if event['round'] <= feature_end:
                features.update(event.get('patterns', []))
    window = {
        'policy': 'through-first-best-round',
        'anchorEventId': event_id,
        'retainedThroughRound': cutoff,
        'sourceThroughRound': max(event['round'] for event in events),
        'sourceEventCount': len(events),
        'retainedEventCount': len(retained),
        'removedEventCount': len(events) - len(retained),
        'removedLinkCount': sum(link['source'] not in retained_ids or link['target'] not in retained_ids for link in links),
        'selection': 'Observed result boundary; not an LLM importance judgment.',
    }
    return {
        **trace,
        'events': retained,
        'eventLinks': [link for link in links if link['source'] in retained_ids and link['target'] in retained_ids],
        'outcomes': [outcome for outcome in trace['outcomes'] if outcome['eventId'] in retained_ids],
        'importMetadata': {**metadata, 'pruning': window,
                           **({'sourcePatternFeatures': dict(features)} if isinstance(feature_end, int) else {})},
    }
