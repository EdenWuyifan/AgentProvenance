"""Participant-aware provenance for explicit workflow events.

Adapters describe what happened. This module aligns individual activities without
guessing dependencies from adjacent rows, numeric identifiers, or tool names.
"""

from collections import Counter, defaultdict, deque
from urllib.parse import quote

from importance import numeric_score, score_summary
from models import digest
from workflow_attribution import fit_workflow_attribution
from workflow_insights import build_workflow_insights
from abstraction import _entity_ports

VERSION = 'workflow-activities-v2'
EVENT_FIELDS = ('eventType', 'agentId', 'role', 'round', 'phase', 'source', 'diagnostics', 'patterns')


def has_workflow(entry):
    return bool(entry.get('eventSchemaVersion') or entry.get('workflowRef') or any(
        call.get('agentId') is not None or call.get('role') is not None
        for call in entry.get('toolCalls', []) if isinstance(call, dict)))


def normalize_workflow(entry, calls):
    participants = {str(p['id']): dict(p, id=str(p['id'])) for p in entry.get('participants', [])}
    roles = defaultdict(set)
    round_label = 'Round' if all('round' in call for call in calls) else 'Step'
    for call in calls:
        participant = str(call['agentId']) if call.get('agentId') is not None else str(call.get('role') or 'execution')
        call['agentId'] = participant
        call['eventType'] = call.get('eventType') or 'tool_execution'
        call['round'] = call.get('round', call['timeIndex'])
        if not isinstance(call['round'], int) or call['round'] < 0:
            raise ValueError('Workflow event rounds must be nonnegative integers.')
        participants.setdefault(participant, {'id': participant, 'label': participant,
                                             'role': call.get('role')})
        if call.get('role'):
            roles[participant].add(call['role'])
    for participant, observed in roles.items():
        if not participants[participant].get('role') and len(observed) == 1:
            participants[participant]['role'] = next(iter(observed))
    calls.sort(key=lambda call: call['round'])
    for index, call in enumerate(calls):
        call['timeIndex'] = index
    by_id = {call['id']: call for call in calls}
    links = entry.get('eventLinks', [])
    if not isinstance(links, list):
        raise ValueError('eventLinks must be an array.')
    links = list(links)
    links.extend({'source': str(parent), 'target': call['id'], 'relation': 'recorded_parent', 'evidenceLevel': 'recorded'}
                 for call in calls for parent in call.get('parentCallIds', []))
    outgoing, incoming = defaultdict(list), Counter({cid: 0 for cid in by_id})
    for link in links:
        if link.get('source') not in by_id or link.get('target') not in by_id:
            raise ValueError('Workflow links must reference existing event IDs.')
        if by_id[link['source']]['round'] > by_id[link['target']]['round']:
            raise ValueError('Workflow evidence cannot flow to an earlier round.')
        outgoing[link['source']].append(link['target'])
        incoming[link['target']] += 1
    queue = deque(cid for cid, count in incoming.items() if count == 0)
    visited = 0
    while queue:
        visited += 1
        for target in outgoing[queue.popleft()]:
            incoming[target] -= 1
            if incoming[target] == 0:
                queue.append(target)
    if visited != len(calls):
        raise ValueError('Workflow event links must be acyclic.')
    outcomes = entry.get('outcomes', [])
    if any(outcome.get('eventId') not in by_id or not numeric_score(outcome.get('value')) for outcome in outcomes):
        raise ValueError('Structured outcomes need a finite value and an existing eventId.')
    metadata = entry.get('importMetadata', {})
    feature_end, score_end = metadata.get('featureWindowEnd'), metadata.get('scoreWindowEnd')
    features = Counter()
    if isinstance(feature_end, int):
        for call in calls:
            if call['round'] <= feature_end:
                features.update(call.get('patterns', []))
    return {'participants': list(participants.values()), 'eventLinks': links, 'outcomes': outcomes, 'roundLabel': round_label,
            'patternFeatures': dict(features), 'featureWindowEnd': feature_end, 'scoreWindowEnd': score_end,
            'importMetadata': metadata,
            'roundCount': max((call['round'] for call in calls), default=0) + 1}


def event_graph(calls, workflow):
    namespace = quote(str(calls[0]['traceId']), safe='') if calls else 'empty'
    nodes, edges, ids = [], [], {}
    for call in calls:
        identifier = quote(call['id'], safe='')
        activity, entity = f'act:{namespace}:{identifier}', f'ent:{namespace}:{identifier}'
        ids[call['id']] = (activity, entity)
        context = {key: call[key] for key in EVENT_FIELDS if key in call}
        nodes.extend([
            {'id': activity, 'kind': 'Activity', 'toolCallId': call['id'], 'tool': call['tool'],
             'args': call.get('args'), 'status': call.get('status'), 'timeIndex': call['timeIndex'],
             'traceId': call['traceId'], **context},
            {'id': entity, 'kind': 'Entity', 'entityType': call['eventType'],
             'response': call.get('response'), 'traceId': call['traceId'], 'source': call.get('source')},
        ])
        edges.append({'source': activity, 'target': entity, 'relation': 'generatedBy',
                      'inferred': False, 'evidence': [{'kind': 'recorded', 'source': call.get('source')}]})
    for link in workflow['eventLinks']:
        edges.append({'source': ids[link['source']][1], 'target': ids[link['target']][0],
                      'relation': 'usedBy', 'eventRelation': link['relation'],
                      'inferred': bool(link.get('inferred')), 'evidenceLevel': link.get('evidenceLevel'),
                      'evidence': [{'kind': 'semantic' if link.get('inferred') else 'recorded',
                                    'relation': link['relation'], 'evidenceLevel': link.get('evidenceLevel'),
                                    'details': link.get('evidence', [])}]})
    return {'nodes': nodes, 'edges': edges}


def _outcome_importance(members, models, analyses):
    tags = {tag for member in members for tag in member['patterns']}
    runs = {member['run'] for member in members}
    selected = {(str(a.get('taskId')), a.get('scoreMetric') or 'score') for a in analyses if a['traceId'] in runs}
    cohorts = [model for model in models['cohorts'] if (model['taskId'], model['scoreMetric']) in selected]
    contributions, patterns = [], []
    for model in cohorts:
        for tag in sorted(tags):
            pattern = model['patterns'].get(tag)
            if pattern:
                per_trace = [{'traceId': run, 'value': value} for run, value in pattern['perTrace'].items() if run in runs]
                patterns.append({'name': tag, 'importance': pattern['importance'], 'status': model['status'],
                                 'sampleCount': model['sampleCount'], 'stability': pattern['stability'],
                                 'contributions': per_trace})
                contributions.extend({**item, 'taskId': model['taskId'], 'scoreMetric': model['scoreMetric'],
                                      'sampleCount': model['sampleCount'], 'stability': pattern['stability']}
                                     for item in per_trace)
    status = ('available' if all(p['status'] == 'available' for p in patterns) else 'exploratory') if patterns else (
        cohorts[0]['status'] if cohorts else 'unavailable')
    return {'status': status, 'contributions': contributions or None, 'globalTools': [], 'patterns': patterns,
            'cohorts': [{'taskId': m['taskId'], 'sampleCount': m['sampleCount'], 'status': m['status']} for m in cohorts]}


def _activity_signature(call, by_id):
    """Align observed parameters, replacing only explicitly recorded event references."""
    def normalize(value):
        if isinstance(value, dict):
            return {key: normalize(item) for key, item in value.items()
                    if key not in {'cacheKey', 'matchStatus', 'encodeMatchStatus'}}
        if isinstance(value, list):
            return [normalize(item) for item in value]
        if isinstance(value, str) and value in by_id:
            source = by_id[value]
            return {'actor': source['agentId'], 'round': source['round'],
                    'type': source['eventType'], 'tool': source['tool']}
        return value
    return [call['agentId'], call['round'], call['eventType'], call['tool'],
            normalize(call.get('args')), call.get('status')]


def build_workflow_view(analyses, references=(), cohort=None, focus='', detail='overview', lane_by='agent',
                        workflow_assessments=None):
    """Project individually assessed activities; never collapse a temporal window."""
    if lane_by not in {'agent', 'role'}:
        raise ValueError('laneBy must be agent or role.')
    entries = {a['traceId']: a for a in analyses}
    ports = {a['traceId']: _entity_ports(a) for a in analyses}
    assessment_runs = {item['traceId']: item for item in (workflow_assessments or {}).get('runs', [])}
    corpus = {a['traceId']: a for a in references}
    corpus.update(entries)
    names = {name for a in corpus.values() for name in a.get('workflow', {}).get('patternFeatures', {})}
    prepared = [{**a, 'workflow': {**a.get('workflow', {}), 'patternFeatures': {
        name: a.get('workflow', {}).get('patternFeatures', {}).get(name, 0) for name in names}}}
        for a in corpus.values() if a.get('workflow')]
    models = fit_workflow_attribution(prepared)
    families, lanes, memberships = defaultdict(list), {}, {}
    assessments_by_event = {}
    outcome_by_event, claims_by_event, joint_by_event = defaultdict(list), defaultdict(list), defaultdict(list)
    ancestors_by_run, link_assessments, joint_links = {}, {}, defaultdict(list)
    joint_groups = []
    view_links = {}
    for a in analyses:
        run, workflow = a['traceId'], a['workflow']
        by_id = {call['id']: call for call in a['calls']}
        if set(a.get('targetCallIds', [])) - by_id.keys():
            raise ValueError('Selected workflow target does not exist.')
        assessed = assessment_runs.get(run, a.get('workflowAssessment', {}))
        view_links[run] = workflow['eventLinks'] + [
            {'source': link['sourceCallId'], 'target': link['targetCallId'], 'relation': link['relation'],
             'inferred': True, 'evidence': link.get('evidence', [])}
            for link in assessed.get('links', []) if link.get('inferred')]
        for link in assessed.get('links', []):
            link_assessments[run, link['sourceCallId'], link['targetCallId'], link['relation']] = link
        for group in assessed.get('jointGroups', []):
            identifier = 'joint:' + digest([run, group['id']])[:20]
            joint_groups.append({**group, 'id': identifier, 'run': run})
            sources, targets = set(group['sourceCallIds']), set(group['targetCallIds'])
            for cid in sources | targets:
                joint_by_event[run, cid].append(identifier)
            for link in workflow['eventLinks']:
                if link['source'] in sources and link['target'] in targets:
                    joint_links[run, link['source'], link['target'], link['relation']].append(identifier)
        for outcome in workflow['outcomes']:
            outcome_by_event[run, outcome['eventId']].append(outcome)
        for claim in a.get('resultEvidence', {}).get('claims', []):
            for link in claim['links']:
                claims_by_event[run, link['callId']].append({**link, 'claimId': claim['id'], 'claimText': claim['text']})
        incoming = defaultdict(list)
        for link in workflow['eventLinks']:
            if not link.get('inferred'):
                incoming[link['target']].append(link['source'])
        main_outcomes = [o for o in workflow['outcomes'] if o.get('scope') != 'participant']
        final_outcomes = [o for o in main_outcomes if o.get('kind') == 'final' or o.get('terminal')]
        ancestors = ({o['eventId'] for o in final_outcomes or main_outcomes}
                     | set(a.get('targetCallIds', [])) | set(a.get('resultAnchors', [])))
        queue = deque(ancestors)
        while queue:
            for source in incoming[queue.popleft()]:
                if source not in ancestors:
                    ancestors.add(source)
                    queue.append(source)
        ancestors_by_run[run] = ancestors
        participants = {p['id']: p for p in workflow['participants']}
        occurrence = Counter()
        for call in a['calls']:
            participant = participants[call['agentId']]
            identity = str(call.get('role') or participant.get('role') or call['agentId']) if lane_by == 'role' else call['agentId']
            environment = participant.get('environment')
            lane_id = f'{lane_by}:' + digest([identity, environment if lane_by == 'agent' else None])[:16]
            labels = [str(v) for v in (environment or {}).values() if isinstance(v, str) and v]
            label = ' · '.join([participant.get('label', identity), *labels])
            lane = lanes.setdefault(lane_id, {'id': lane_id, 'label': identity if lane_by == 'role' else label,
                                             'kind': lane_by, 'participantIds': set()})
            lane['participantIds'].add(call['agentId'])
            signature = digest([lane_id, _activity_signature(call, by_id)])
            ordinal = occurrence[signature]
            occurrence[signature] += 1
            family = 'activity:' + digest([signature, ordinal])[:20]
            cid = call['id']
            assessment = assessed.get('events', {}).get(cid, {
                'level': 'unknown', 'label': call['tool'],
                'reason': 'This occurrence has not been semantically assessed.', 'evidence': [], 'status': 'not_assessed'})
            member = {'run': run, 'id': f'{run}:{family}', 'calls': [call], 'callIds': {cid},
                      'patterns': set(call.get('patterns', [])) if isinstance(workflow.get('featureWindowEnd'), int)
                                  and call['round'] <= workflow['featureWindowEnd'] else set(),
                      'laneId': lane_id, 'start': call['round'], 'end': call['round'], 'assessment': assessment}
            assessments_by_event[run, cid] = assessment
            families[family].append(member)
            memberships[run, cid] = (family, member['id'])
    nodes = []
    for family, members in sorted(families.items()):
        calls = [m['calls'][0] for m in members]
        support = sorted({m['run'] for m in members})
        outcomes = [o for m in members for o in outcome_by_event[m['run'], m['calls'][0]['id']]]
        diagnostics = [d for call in calls for d in call.get('diagnostics', [])]
        failures = any(str(call.get('status')).lower() in {'error', 'failed', 'failure'} for call in calls)
        levels = [m['assessment']['level'] for m in members]
        level = 'key' if 'key' in levels else 'unknown' if 'unknown' in levels else 'supporting'
        key = level == 'key'
        chosen = next(m['assessment'] for m in members if m['assessment']['level'] == level)
        result_ids = {f"{m['run']}:{o['id']}" for m in members for o in outcome_by_event[m['run'], m['calls'][0]['id']]
                      if o.get('scope') != 'participant'}
        explicit_targets = {call['id'] for m, call in zip(members, calls) if call['id'] in entries[m['run']].get('targetCallIds', [])}
        text_supported = {f"{m['run']}:{link['claimId']}" for m, call in zip(members, calls)
                          for link in claims_by_event[m['run'], call['id']] if link['relation'] == 'supports'}
        text_contradicted = {f"{m['run']}:{link['claimId']}" for m, call in zip(members, calls)
                             for link in claims_by_event[m['run'], call['id']] if link['relation'] == 'contradicts'}
        backbone = any(call['id'] in ancestors_by_run[m['run']] for m, call in zip(members, calls))
        instances, variants, operations = [], [], {}
        for member, call in zip(members, calls):
            run, cid = member['run'], call['id']
            targets = [cid] if outcome_by_event[run, cid] or cid in entries[run].get('targetCallIds', []) or cid in entries[run].get('resultAnchors', []) else []
            instances.append({'id': member['id'], 'run': run,
                              'calls': [{'id': cid, 'tool': call['tool'], 'step': call['timeIndex'] + 1}],
                              'internalFlow': [], 'internalCalls': [cid],
                              'attention': 'key' if member['assessment']['level'] == 'key' else 'supporting',
                              'resultTargets': targets, 'resultBackbone': cid in ancestors_by_run[run],
                              'background': False, 'targetEvidence': [],
                              'resultStatus': entries[run].get('resultEvidence', {}).get('status', 'available'),
                              'resultEvidence': claims_by_event[run, cid]})
            variants.append({'run': run, 'instanceId': member['id'],
                             'parameters': {'roundStart': call['round'], 'roundEnd': call['round']},
                             'roleBindings': {'participant': call['agentId']},
                             'diagnostics': call.get('diagnostics', []), 'evidence': member['assessment'].get('evidence', [])})
            operation = operations.setdefault(call['tool'], {'id': 'operation:' + digest([family, call['tool']])[:20],
                'tool': call['tool'], 'failure': failures, 'supportTraces': [], 'members': [], 'parameterVariants': []})
            operation['supportTraces'].append(run)
            operation['members'].append({'run': run, 'callId': cid, 'step': call['timeIndex'] + 1,
                                         'inputEntityIds': ports[run][0].get(cid, []), 'outputEntityIds': ports[run][1].get(cid, [])})
        assessment = {'status': 'unknown' if level == 'unknown' else 'assessed', 'level': level,
                      'semanticLabel': chosen['label'], 'reason': chosen['reason'], 'evidence': chosen.get('evidence', []),
                      'jointGroupIds': sorted({gid for m, call in zip(members, calls) for gid in joint_by_event[m['run'], call['id']]}),
                      'keySupportCount': levels.count('key'),
                      'assessedSupportCount': sum(m['assessment']['status'] == 'assessed' for m in members),
                      'perTrace': [{'run': m['run'], **m['assessment']} for m in members]}
        nodes.append({'id': family, 'kind': 'JoinedActivity', 'label': chosen['label'], 'semanticRole': calls[0]['eventType'],
                      'assessment': assessment, 'supportTraces': support, 'supportCount': len(support),
                      'methods': sorted(operations), 'instances': instances, 'variants': variants,
                      'operationGroups': list(operations.values()), 'attention': 'key' if key else 'supporting',
                      'resultBackbone': backbone, 'scoreSummary': score_summary([entries[run] for run in support]),
                      'executionContext': {'laneId': members[0]['laneId'], 'roundStart': calls[0]['round'],
                                           'roundEnd': calls[0]['round'], 'phase': calls[0].get('phase'),
                                           'eventOrder': min(call['timeIndex'] for call in calls)},
                      'eventSummary': {'eventCount': len(calls), 'diagnostics': sorted({d['kind'] for d in diagnostics}),
                                       'outcomes': [{'name': o['name'], 'value': o['value']} for o in outcomes]},
                      'importance': {'decision': 'expand' if key else 'collapse',
                          'tier': 'failure' if failures else 'result' if result_ids else 'key' if key else 'context',
                          'reasons': [chosen['reason']], 'support': len(support),
                          'facets': [{'id': 'key-event', 'label': 'Key event'}] if key else [],
                          'semantic': {'level': 'key' if key else 'supporting'},
                          'result': {'status': 'contradicted' if text_contradicted else 'supported' if text_supported else 'referenced' if result_ids or explicit_targets else 'none',
                                     'supportedClaims': sorted(result_ids | text_supported), 'contradictedClaims': sorted(text_contradicted),
                                     'onRecordedPath': backbone}, 'outcome': _outcome_importance(members, models, analyses)}})
    edge_groups = defaultdict(list)
    for a in analyses:
        run = a['traceId']
        for link in view_links[run]:
            key = (run, link['source'], link['target'], link['relation'])
            source, source_instance = memberships[run, link['source']]
            target, target_instance = memberships[run, link['target']]
            decision = link_assessments.get(key, {})
            group_ids = joint_links[key]
            source_key = assessments_by_event[run, link['source']]['level'] == 'key'
            target_key = assessments_by_event[run, link['target']]['level'] == 'key'
            handoff = link['relation'] in {'publishes', 'delivered_to', 'recorded_parent'}
            relevant = (bool(group_ids) or decision.get('relevance') == 'relevant'
                        or handoff and source_key and target_key or link['relation'] == 'delivered_to' and target_key)
            # Delivery and publication retain their literal endpoints. Relevance
            # of the receipt does not relabel its sender's action as important.
            visible = relevant or (source_key or target_key) and handoff
            edge_groups[source, target, link['relation']].append({
                'run': run, 'sourceInstance': source_instance, 'targetInstance': target_instance,
                'callPath': [link['source'], link['target']], 'inferred': bool(link.get('inferred')),
                'highlighted': relevant, 'overviewVisible': visible,
                'relevance': decision.get('relevance', 'unknown'), 'jointGroupIds': group_ids, 'internalPath': [],
                'reason': decision.get('reason') or 'Recorded relationship; exposure alone does not demonstrate causal influence.',
                'evidence': decision.get('evidence', []), 'sourceEvidence': link.get('evidence', [])})
    all_edges = []
    for (source, target, relation), witnesses in sorted(edge_groups.items()):
        support = sorted({w['run'] for w in witnesses})
        all_edges.append({'id': 'event-edge:' + digest([source, target, relation])[:20], 'source': source, 'target': target,
                          'supportTraces': support, 'supportCount': len(support), 'relation': relation,
                          'inferred': any(w['inferred'] for w in witnesses), 'witnesses': witnesses})
    edges = all_edges
    source_calls = sum(len(a['calls']) for a in analyses)
    counts = Counter(m['assessment']['level'] for members in families.values() for m in members)
    round_count = max((a['workflow']['roundCount'] for a in analyses), default=1)
    return {'nodes': nodes, 'edges': edges, 'omittedCalls': [], 'generation': 'mechanical',
            'templateVersion': VERSION, 'detail': detail, 'cohort': cohort or {},
            'workflow': {'lanes': [{**lane, 'participantIds': sorted(lane['participantIds'])} for lane in lanes.values()],
                         'roundRange': [0, round_count - 1], 'roundLabel': analyses[0]['workflow']['roundLabel'],
                         'laneBy': lane_by, 'granularity': 'activity'},
            'workflowAssessment': {'version': (workflow_assessments or {}).get('version'), 'coverage': dict(counts),
                                   'jointGroups': joint_groups, 'cached': (workflow_assessments or {}).get('cached', False),
                                   'runs': [{'run': item['traceId'], 'retrieval': item.get('retrievalMetrics', {})}
                                            for item in (workflow_assessments or {}).get('runs', [])],
                                   'retrieval': (workflow_assessments or {}).get('retrievalMetrics', {})},
            'projection': {'candidateEdges': len(all_edges), 'shownEdges': len(edges), 'hiddenContextEdges': len(all_edges) - len(edges)},
            'workflowAttribution': models, 'workflowInsights': build_workflow_insights(analyses),
            'resultEvidence': [a['resultEvidence'] for a in analyses if a.get('resultEvidence')],
            'scoreSummary': score_summary(analyses),
            'structuredOutcomes': [{'run': a['traceId'], 'outcomes': a['workflow']['outcomes']} for a in analyses],
            'alignment': {'mode': 'activity-parameters', 'sharedPatterns': sum(n['supportCount'] > 1 for n in nodes)},
            'compression': {'sourceCalls': source_calls, 'visibleCalls': source_calls, 'hiddenCalls': 0,
                            'visibleNodes': len(nodes), 'multiCallGroups': 0,
                            'expandedActivities': sum(n['assessment']['level'] == 'key' for n in nodes),
                            'supportingPoints': sum(n['assessment']['level'] == 'supporting' for n in nodes),
                            'unknownPoints': sum(n['assessment']['level'] == 'unknown' for n in nodes)},
            'modelMetrics': {'requestCount': 0, 'elapsedSeconds': 0, 'promptTokens': 0},
            'warnings': ['Temporal order is not a causal dependency.',
                         'Semantic importance and recorded evidence use do not prove causal influence.',
                         'Unknown means unreviewed or insufficient evidence, not that the activity is unimportant.',
                         'Support counts independent executions, not agents or message recipients.']}
