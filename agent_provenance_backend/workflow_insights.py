"""Bounded, observational summaries of agent activities in workflow traces."""

from collections import Counter, defaultdict, deque
from hashlib import sha256
import math


PUBLICATION = 'information_publication'
RECEPTION = 'information_reception'
DELIVERY_RELATIONS = {'delivered_to'}
EXPOSURE_RELATIONS = {'included_in_prompt', 'present_in_prompt',
                      'used_local_evidence', 'used_shared_evidence'}
MAX_SKILLS = 10
MAX_EXAMPLES = 3
MAX_WITNESS_EVENTS = 24


def _finite(value):
    if isinstance(value, bool):
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _role_map(workflow):
    return {str(participant['id']): participant.get('role')
            for participant in workflow.get('participants', []) if participant.get('id') is not None}


def _round(call):
    return call.get('round') if isinstance(call.get('round'), int) and not isinstance(call.get('round'), bool) else None


def _lag_summary(values):
    return {'count': len(values), 'meanRounds': round(sum(values) / len(values), 3) if values else None,
            'maxRounds': max(values) if values else None}


def _payload(call, event_type):
    args = call.get('args')
    if not isinstance(args, dict):
        return None
    aliases = (('communicatedPayload', 'payload', 'communicated_payload')
               if event_type == PUBLICATION else ('payload', 'receivedPayload', 'received_payload'))
    return next((args[key] for key in aliases if key in args), None)


def _payload_differs(reference, observed):
    if isinstance(reference, dict) and isinstance(observed, dict):
        return any(key not in observed or _payload_differs(value, observed[key])
                   for key, value in reference.items())
    return reference != observed


def _witness(anchor, calls, links):
    """Return one shortest recorded source-to-outcome path through explicit links."""
    by_id = {call['id']: call for call in calls}
    outgoing, incoming_count = defaultdict(list), Counter({cid: 0 for cid in by_id})
    for link in links:
        if link.get('inferred') or link.get('source') not in by_id or link.get('target') not in by_id:
            continue
        outgoing[link['source']].append(link)
        incoming_count[link['target']] += 1
    sort_key = lambda cid: (_round(by_id[cid]) if _round(by_id[cid]) is not None else -1,
                            by_id[cid].get('timeIndex', 0), str(cid))
    roots = sorted((cid for cid, count in incoming_count.items() if count == 0), key=sort_key)
    predecessor = {}
    seen = set(roots)
    queue = deque(roots)
    while queue:
        source = queue.popleft()
        for link in sorted(outgoing[source], key=lambda item: (sort_key(item['target']), item.get('relation', ''))):
            target = link['target']
            if target in seen:
                continue
            seen.add(target)
            predecessor[target] = (source, link.get('relation'))
            queue.append(target)
    if anchor not in seen:
        return []
    ids = [anchor]
    relations = []
    cursor = anchor
    while cursor in predecessor:
        previous, relation = predecessor[cursor]
        relations.append(relation)
        ids.append(previous)
        cursor = previous
    ids.reverse()
    relations.reverse()
    truncated = len(ids) > MAX_WITNESS_EVENTS
    if truncated:
        ids = ids[-MAX_WITNESS_EVENTS:]
        relations = relations[-(MAX_WITNESS_EVENTS - 1):]
    result = []
    for index, cid in enumerate(ids):
        call = by_id[cid]
        result.append({'eventId': cid, 'eventType': call.get('eventType'),
                       'agentId': call.get('agentId'), 'round': _round(call),
                       'relationToNext': relations[index] if index < len(relations) else None})
    if truncated:
        result[0]['truncatedEarlierPath'] = True
    return result


def _outcome_rows(analysis):
    groups = defaultdict(list)
    calls = {call['id']: call for call in analysis.get('calls', [])}
    for outcome in analysis.get('workflow', {}).get('outcomes', []):
        value = _finite(outcome.get('value'))
        if value is None:
            continue
        event_id = outcome.get('eventId')
        event = calls.get(event_id, {})
        round_number = outcome.get('round', _round(event))
        if isinstance(round_number, bool) or not isinstance(round_number, int):
            round_number = _round(event)
        observed_through = outcome.get('observedThroughRound')
        if isinstance(observed_through, bool) or not isinstance(observed_through, int):
            observed_through = None
        item = {'value': value, 'round': round_number, 'eventId': event_id,
                'observedThroughRound': observed_through,
                'direction': outcome.get('direction'), 'terminal': outcome.get('terminal') is True}
        participant = str(event.get('agentId', '')) if outcome.get('scope') == 'participant' else ''
        groups[(str(outcome.get('metric') or 'outcome'), str(outcome.get('name') or 'Outcome'),
                outcome.get('scope') or 'unspecified', participant)].append(item)
    metrics, key_metrics = [], []
    for (metric, name, scope, participant), values in sorted(groups.items()):
        values.sort(key=lambda item: (item['round'] if item['round'] is not None else -1,
                                      str(item['eventId'])))
        direction = next((item['direction'] for item in values if item['direction'] in {'higher', 'lower'}), None)
        best = (max(values, key=lambda item: item['value']) if direction == 'higher' else
                min(values, key=lambda item: item['value']) if direction == 'lower' else None)
        def compact(item):
            return {key: item[key] for key in ('value', 'round', 'eventId', 'observedThroughRound')}
        metric_row = {'name': name, 'metric': metric, 'scope': scope, 'participantId': participant or None,
                      'first': compact(values[0]),
                      'final': compact(values[-1]),
                      'finalMeaning': 'terminal_outcome' if any(item['terminal'] for item in values)
                      else 'last_recorded_milestone',
                      'best': compact(best) if best else None}
        metrics.append(metric_row)
        key_item = best or values[-1]
        if scope != 'participant':
            key_metrics.append({'name': name, 'metric': metric, **compact(key_item)})
    return metrics, key_metrics


def _run_summary(analysis):
    workflow = analysis.get('workflow', {})
    calls = analysis.get('calls', [])
    trace_id = str(analysis.get('traceId'))
    roles = _role_map(workflow)
    by_agent = defaultdict(list)
    for call in calls:
        agent = str(call.get('agentId') or 'unknown')
        by_agent[agent].append(call)
    agent_rows = []
    for agent, agent_calls in sorted(by_agent.items()):
        activities = agent_calls
        if not activities:
            continue
        rounds = [_round(call) for call in activities if _round(call) is not None]
        active_rounds = sorted(set(rounds))
        activity_counts = Counter(call.get('eventType', 'unknown') for call in activities)
        agent_rows.append({'agentId': agent, 'role': roles.get(agent), 'eventCount': len(activities),
                           'firstRound': min(active_rounds) if active_rounds else None,
                           'lastRound': max(active_rounds) if active_rounds else None,
                           'activeSpanRounds': max(active_rounds) - min(active_rounds) + 1 if active_rounds else None,
                           'activeRounds': active_rounds, 'activeRoundCount': len(active_rounds),
                           'activityCounts': dict(sorted(activity_counts.items()))})
    events = {call['id']: call for call in calls}
    publications = [call for call in calls if call.get('eventType') == PUBLICATION]
    receptions = [call for call in calls if call.get('eventType') == RECEPTION]
    delivery_lags, exposure_lags = {}, {}
    delivery_pairs, local_exposures, shared_exposures = set(), set(), set()
    source_mismatch_receptions, transport_mismatch_receptions = set(), set()
    for link in workflow.get('eventLinks', []):
        source, target = events.get(link.get('source')), events.get(link.get('target'))
        if source is None or target is None or link.get('inferred'):
            continue
        gap = _round(target) - _round(source) if _round(target) is not None and _round(source) is not None else None
        if (link.get('relation') in DELIVERY_RELATIONS and source.get('eventType') == PUBLICATION
                and target.get('eventType') == RECEPTION):
            pair = (source['id'], target['id'])
            if gap is not None and gap >= 0:
                delivery_lags[pair] = gap
            delivery_pairs.add(pair)
            source_payload, received_payload = _payload(source, PUBLICATION), _payload(target, RECEPTION)
            if source_payload is not None and received_payload is not None and _payload_differs(source_payload, received_payload):
                transport_mismatch_receptions.add(target['id'])
        if (link.get('relation') in EXPOSURE_RELATIONS and target.get('eventType') not in {PUBLICATION, RECEPTION}
                and source.get('eventType') != PUBLICATION):
            exposure = (source['id'], target['id'])
            destination = shared_exposures if source.get('eventType') == RECEPTION else local_exposures
            destination.add(exposure)
            if gap is not None and gap >= 0:
                exposure_lags[exposure] = gap
    for reception in receptions:
        source_payload = reception.get('args', {}).get('sourcePayload') if isinstance(reception.get('args'), dict) else None
        received_payload = _payload(reception, RECEPTION)
        altered = reception.get('args', {}).get('payload_altered') if isinstance(reception.get('args'), dict) else None
        if altered is True or (source_payload is not None and received_payload is not None and _payload_differs(source_payload, received_payload)):
            source_mismatch_receptions.add(reception['id'])
    observed_rounds = [_round(call) for call in calls if _round(call) is not None]
    fallback_round_count = max(observed_rounds, default=-1) + 1
    round_count = workflow.get('roundCount')
    if not isinstance(round_count, int) or isinstance(round_count, bool) or round_count < fallback_round_count:
        round_count = fallback_round_count
    metrics, key_metrics = _outcome_rows(analysis)
    score = _finite(analysis.get('score'))
    outcome = {'traceId': trace_id, 'scoreMetric': analysis.get('scoreMetric') or 'score',
               'score': score, 'metrics': metrics}
    key_steps = []
    for item in key_metrics:
        key_steps.append({**item, 'witness': _witness(item.get('eventId'), calls, workflow.get('eventLinks', []))})
    unique_exposed_receptions = {source for source, _ in shared_exposures
                                 if events[source].get('eventType') == RECEPTION}
    communication = {'publications': len(publications), 'receptions': len(receptions),
                     'sourcePayloadMismatchCount': len(source_mismatch_receptions),
                     'transportMismatchCount': len(transport_mismatch_receptions),
                     'linkedDeliveries': len(delivery_pairs), 'deliveryLag': _lag_summary(list(delivery_lags.values())),
                     'sharedExposureCount': len(shared_exposures), 'localExposureCount': len(local_exposures),
                     'uniqueExposedReceptionCount': len(unique_exposed_receptions),
                     'observedReceptionCoverage': len(unique_exposed_receptions) / len(receptions) if receptions else None,
                     'promptExposures': len(shared_exposures) + len(local_exposures),
                     'exposureLag': _lag_summary(list(exposure_lags.values())),
                     'coverageBasis': 'matched explicit shared-evidence links only'}
    return {
        'traceId': trace_id,
        'timing': {'roundCount': round_count, 'activitiesByAgent': agent_rows,
                   'communication': communication},
        'outcome': outcome, 'keySteps': key_steps,
        '_calls': calls, '_links': workflow.get('eventLinks', []),
    }


def _skills(summaries):
    motifs = defaultdict(list)
    for summary in summaries:
        trace = summary['traceId']
        calls = {call['id']: call for call in summary['_calls']}
        roles = {row['agentId']: row.get('role') for row in summary['timing']['activitiesByAgent']}
        outgoing = defaultdict(list)
        for link in summary['_links']:
            if link.get('inferred') or link.get('source') not in calls or link.get('target') not in calls:
                continue
            outgoing[link['source']].append(link)
        for use in summary['_links']:
            if use.get('inferred') or use.get('relation') not in EXPOSURE_RELATIONS:
                continue
            source, experiment = calls.get(use.get('source')), calls.get(use.get('target'))
            if not source or not experiment or experiment.get('eventType') in {PUBLICATION, RECEPTION}:
                continue
            if source.get('eventType') == PUBLICATION:
                continue
            agent = str(experiment.get('agentId') or 'unknown')
            role = roles.get(agent) or 'unspecified'
            for publish in outgoing[experiment['id']]:
                publication = calls[publish['target']]
                if publish.get('relation') != 'publishes' or publication.get('eventType') != PUBLICATION:
                    continue
                types = (source.get('eventType'), experiment.get('eventType'), PUBLICATION)
                key = (role, types)
                if not any(example['traceId'] == trace for example in motifs[key]):
                    motifs[key].append({'traceId': trace, 'agentId': agent,
                                        'eventIds': [source['id'], experiment['id'], publication['id']]})
    candidates = []
    for (role, types), data in motifs.items():
        examples = data
        run_count = len({example['traceId'] for example in examples})
        if run_count < 2:
            continue
        evidence = 'shared' if types[0] == RECEPTION else 'local'
        action = 'experiment' if types[1] == 'experiment' else 'work'
        label = f'Inspect {evidence} evidence, perform {action}, and publish findings'
        identifier = sha256(repr((role, types)).encode()).hexdigest()[:16]
        candidates.append({'id': 'skill:' + identifier, 'status': 'candidate',
                           'basis': 'repeated recorded dependency motif',
                           'pattern': f'{evidence} evidence → {action} → publication',
                           'patternTypes': list(types), 'label': label,
                           'role': role, 'runSupport': run_count,
                           'preconditions': ['Explicit evidence-context link into the activity', 'Recorded publication of its findings'],
                           'procedure': [f'Inspect the available {evidence} evidence', f'Perform {action} under local constraints', 'Publish the result together with its source'],
                           'outcomeEvidence': 'The motif was recorded in independent runs; this does not establish better outcomes.',
                           'sourceExamples': examples[:MAX_EXAMPLES],
                           'applicability': f'Observed for role {role} in {run_count} independent runs; a candidate workflow pattern for similar settings.',
                           'limitations': 'Candidate only, not validated; the observation does not establish effectiveness, causality, or transfer to another task.'})
    candidates.sort(key=lambda item: (-item['runSupport'], len(item['pattern']), item['role'], item['label']))
    return candidates[:MAX_SKILLS]


def build_workflow_insights(analyses: list) -> dict:
    """Summarize recorded activity, communications, outcomes, and recurring motifs."""
    by_trace = defaultdict(list)
    for analysis in analyses:
        if isinstance(analysis, dict) and analysis.get('traceId') is not None and analysis.get('workflow'):
            by_trace[str(analysis['traceId'])].append(analysis)
    summaries = [_run_summary(items[0]) for _, items in sorted(by_trace.items()) if len(items) == 1]
    communication = [summary['timing']['communication'] for summary in summaries]
    # Preserve only observed round gaps; unlinked traffic has unknown lag.
    aggregate_delivery_lags, aggregate_exposure_lags = {}, {}
    for summary in summaries:
        calls = {call['id']: call for call in summary['_calls']}
        for link in summary['_links']:
            source, target = calls.get(link.get('source')), calls.get(link.get('target'))
            if source is None or target is None or link.get('inferred'):
                continue
            sr, tr = _round(source), _round(target)
            if sr is None or tr is None or tr < sr:
                continue
            if link.get('relation') in DELIVERY_RELATIONS and source.get('eventType') == PUBLICATION and target.get('eventType') == RECEPTION:
                aggregate_delivery_lags[(summary['traceId'], source['id'], target['id'])] = tr - sr
            if (link.get('relation') in EXPOSURE_RELATIONS and target.get('eventType') not in {PUBLICATION, RECEPTION}
                    and source.get('eventType') != PUBLICATION):
                aggregate_exposure_lags[(summary['traceId'], source['id'], target['id'])] = tr - sr
    runs = [{key: value for key, value in summary.items() if key not in {'_calls', '_links'}} for summary in summaries]
    aggregates = {
        'publicationCount': sum(item['publications'] for item in communication),
        'receptionCount': sum(item['receptions'] for item in communication),
        'sourcePayloadMismatchCount': sum(item['sourcePayloadMismatchCount'] for item in communication),
        'transportMismatchCount': sum(item['transportMismatchCount'] for item in communication),
        'linkedDeliveryCount': sum(item['linkedDeliveries'] for item in communication),
        'deliveryLag': _lag_summary(list(aggregate_delivery_lags.values())),
        'sharedExposureCount': sum(item['sharedExposureCount'] for item in communication),
        'localExposureCount': sum(item['localExposureCount'] for item in communication),
        'uniqueExposedReceptionCount': sum(item['uniqueExposedReceptionCount'] for item in communication),
        'observedReceptionCoverage': (sum(item['uniqueExposedReceptionCount'] for item in communication) /
                                      sum(item['receptions'] for item in communication)
                                      if sum(item['receptions'] for item in communication) else None),
        'promptExposureCount': sum(item['promptExposures'] for item in communication),
        'exposureLag': _lag_summary(list(aggregate_exposure_lags.values())),
        'coverageBasis': 'matched explicit shared-evidence links only',
    }
    return {'version': 'workflow-insights-v1',
            'scope': {'runCount': len(summaries), 'eventCount': sum(len(summary['_calls']) for summary in summaries),
                      'roundIndexing': 'zero-based'},
            'timing': {'runs': [{'traceId': summary['traceId'], **summary['timing']} for summary in summaries],
                       'aggregate': aggregates},
            'outcomes': {'runs': [summary['outcome'] for summary in summaries]},
            'keySteps': {'runs': [{'traceId': summary['traceId'], 'metrics': summary['keySteps']}
                                  for summary in summaries]},
            'skills': _skills(summaries),
            'limitations': ['Round gaps measure recorded round distance, not elapsed time or communication efficiency.',
                            'Source payload mismatch compares reception payload with the referenced source; transport mismatch compares it with the linked publication payload.',
                            'Reception coverage counts explicit shared-evidence links and may omit unmatched contexts.',
                            'Skill candidates are repeated recorded dependency motifs, not validated or causal skills.',
                            'Outcome final values are the last recorded milestones unless the source provides a terminal outcome.']}
