"""Small, evidence-preserving skill candidates; execution validates transfer."""

from collections import defaultdict
from copy import deepcopy
import re

from models import digest
from evidence_context import result_targets
from semantics import _shape
from repeat_patterns import edge_role, group_repetitions


def _bundle_index(analysis):
    calls = {call['id']: call for call in analysis['calls']}
    incoming = defaultdict(list)
    for edge in analysis['flow']:
        if edge['target'] in calls and edge['source'] in calls:
            incoming[edge['target']].append(edge)
    return calls, incoming, {call['id']: i for i, call in enumerate(analysis['calls'])}


def _input_bundle(analysis, consumer_id, max_depth, max_nodes, include_steps, index):
    calls, incoming, order = index
    if consumer_id not in calls:
        raise KeyError(consumer_id)

    depths = {consumer_id: 0}
    frontier = [consumer_id]
    while frontier:
        target = frontier.pop(0)
        depth = depths[target]
        if depth == max_depth:
            continue
        for edge in incoming[target]:
            source = edge['source']
            if source not in depths:
                depths[source] = depth + 1
                frontier.append(source)

    if len(depths) > max_nodes:
        return {'status': 'oversized', 'traceId': analysis['traceId'],
                'consumerCallId': consumer_id, 'nodeCount': len(depths),
                'maxNodes': max_nodes, 'callIds': [], 'steps': [], 'links': [],
                'boundaryInputs': [], 'unobservedPreconditions': 'unknown'}

    call_ids = sorted(depths, key=order.get)
    selected = set(call_ids)
    links = [edge for target in call_ids for edge in incoming[target] if edge['source'] in selected]
    boundary = sorted({edge['source'] for target in call_ids
                       if depths[target] == max_depth
                       for edge in incoming[target]
                       if edge['source'] not in selected}, key=order.get)
    recorded = {consumer_id}
    queue = [consumer_id]
    while queue:
        target = queue.pop()
        for edge in incoming[target]:
            if edge.get('inferred'):
                continue
            if edge['source'] in selected and edge['source'] not in recorded:
                recorded.add(edge['source'])
                queue.append(edge['source'])
    result = {'status': 'candidate', 'traceId': analysis['traceId'],
              'analysisKey': analysis.get('analysisKey'),
              'consumerCallId': consumer_id, 'callIds': call_ids,
              'recordedCallIds': sorted(recorded, key=order.get),
              'contextCallIds': [cid for cid in call_ids if cid not in recorded],
              'links': deepcopy(links) if include_steps else links, 'boundaryInputs': boundary,
              'interpretation': 'recorded links are transport evidence; inferred links are context, not executable or causal proof',
              'unobservedPreconditions': 'unknown beyond retrieved graph and depth limit'}
    if include_steps:
        result['steps'] = [deepcopy(calls[cid]) for cid in call_ids]
    return result


def distill_input_bundle(analysis, consumer_id, max_depth=2, max_nodes=64):
    """Return the complete retrieved input cone for one actual consumer call."""
    return _input_bundle(analysis, consumer_id, max_depth, max_nodes, True, _bundle_index(analysis))


def complete_example(witness):
    """Keep all occurrences in a selected group, including distinct outputs.

    Sharing an input role does not make two observations interchangeable.
    Exact payload sharing belongs in the renderer, where event identity survives.
    """
    return {'consumerCallIds': list(witness['consumerCallIds']),
            'callIds': list(witness['callIds']), 'abstractedConsumerCallIds': []}


def _argument_shape(value, key=None, depth=0):
    if depth >= 4:
        return type(value).__name__
    if isinstance(value, dict):
        return {k: _argument_shape(v, k, depth + 1) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return {'items': sorted({_shape_key(_argument_shape(v, key, depth + 1)) for v in value}),
                'arity': 'one' if len(value) == 1 else 'many' if value else 'empty'}
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not re.search(r'value|threshold|cutoff|limit|^min$|^max$', key or '', re.I):
        return 'number'
    return _shape(value, key or '')


def _shape_key(value):
    import json
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def _compact_link(edge):
    return {'source': edge['source'], 'target': edge['target'],
            'relation': edge.get('relation', 'data_flow'),
            'inferred': bool(edge.get('inferred', False)),
            'evidenceRole': edge.get('evidenceRole'),
            'parameterUses': deepcopy(edge.get('parameterUses', [])),
            'missingInputs': list(edge.get('missingInputs', [])),
            'selectedEvidence': [{k: item[k] for k in ('callId', 'field', 'path',
                'collectionPath', 'collectionLength', 'complete') if k in item}
                                 for item in edge.get('selectedEvidence', [])],
            'evidence': [{k: item[k] for k in ('kind', 'callId', 'field', 'path', 'sourcePath', 'targetPath') if k in item}
                         for item in edge.get('evidence', [])]}


def _pattern_roles(consumer_id, direct, calls):
    role_set = set()
    for edge in direct:
        paths = tuple(sorted(item.get('targetPath', '')
                             for item in edge.get('evidence', [])
                             if item.get('targetPath')))
        if edge.get('inferred'):
            paths = tuple(sorted({item['path'] for item in edge.get('evidence', [])
                                  if item.get('callId') == consumer_id and item.get('field') == 'args'}))
            if edge.get('selectedEvidence'):
                paths = tuple(sorted({item['path'] for item in edge['selectedEvidence']
                                      if item.get('callId') == consumer_id and item.get('field') == 'args'}))
        role_set.add((calls[edge['source']]['tool'], edge.get('relation', 'data_flow'),
                      bool(edge.get('inferred', False)), paths))
    return role_set


def mine_input_patterns(analyses, max_depth=2, max_nodes=64, limit=6, max_witnesses=3):
    """Group consumer-rooted bundles by consumer interface and direct input roles."""
    patterns = {}
    for analysis in analyses:
        index = _bundle_index(analysis)
        calls, incoming, order = index
        edge_order = {id(edge): position for position, edge in enumerate(analysis['flow'])}
        anchors = result_targets(analysis)
        judgments = analysis.get('evidenceReview', {}).get('events', {})
        repeated = group_repetitions(analysis)
        grouped_ids = set()
        units = []
        for group in repeated:
            bundles = [_input_bundle(analysis, call['id'], max_depth, max_nodes, False, index)
                       for call in group]
            union_ids = {cid for bundle in bundles if bundle['status'] == 'candidate'
                         for cid in bundle['callIds']}
            if (all(bundle['status'] == 'candidate' for bundle in bundles)
                    and len(union_ids) <= max_nodes):
                units.append((group, bundles))
                grouped_ids.update(call['id'] for call in group)
        for consumer_id, consumer in calls.items():
            if consumer_id not in grouped_ids and (incoming[consumer_id] or consumer_id in anchors
                    or judgments.get(consumer_id, {}).get('level') == 'key' or any(
                    row['targetCallId'] == consumer_id for row in analysis.get('initialContextUses', []))):
                bundle = _input_bundle(analysis, consumer_id, max_depth, max_nodes, False, index)
                if bundle['status'] == 'candidate':
                    units.append(([consumer], [bundle]))
        for group, bundles in units:
            consumer_id = group[0]['id']
            consumer = group[0]
            direct_by_call = {call['id']: _pattern_roles(call['id'], incoming[call['id']], calls)
                              for call in group}
            role_set = set.union(*direct_by_call.values())
            roles = [{'sourceTool': tool, 'relation': relation, 'inferred': inferred,
                      'targetPaths': list(paths)}
                     for tool, relation, inferred, paths in sorted(role_set)]
            shape = _argument_shape(consumer.get('args', {}))
            key = digest([consumer['tool'], shape, roles])[:20]
            pattern = patterns.setdefault(key, {
                'id': key, 'consumerTool': consumer['tool'], 'argumentShape': shape,
                'directInputRoles': roles, 'witnesses': [], 'supportTraces': [],
                'successfulSourceTraces': [], 'failedSourceTraces': [], 'explicitResultAnchorCount': 0,
                'keyActivityWitnessCount': 0,
                'multiInputWitnessCount': 0})
            trace_id = analysis['traceId']
            pattern['supportTraces'].append(trace_id)
            pattern['explicitResultAnchorCount'] += sum(call['id'] in anchors for call in group)
            pattern['keyActivityWitnessCount'] += sum(
                judgments.get(call['id'], {}).get('level') == 'key' for call in group)
            pattern['multiInputWitnessCount'] += sum(
                len({edge['source'] for edge in incoming[call['id']]}) > 1 for call in group)
            outcome = analysis.get('trainingOutcome', {})
            source_status = outcome.get('status')
            if source_status not in ('success', 'failure'):
                source_status = 'unknown'
            if source_status == 'success':
                pattern['successfulSourceTraces'].append(trace_id)
            elif source_status == 'failure':
                pattern['failedSourceTraces'].append(trace_id)
            union_ids = {cid for bundle in bundles for cid in bundle['callIds']}
            call_ids = sorted(union_ids, key=order.get)
            link_map = {}
            for bundle in bundles:
                for edge in bundle['links']:
                    link_map.setdefault((edge['source'], edge['target'], edge.get('relation', 'data_flow'),
                                         bool(edge.get('inferred', False)), repr(edge)), edge)
            role_rows = []
            for role in sorted(role_set, key=repr):
                observed_at = [call['id'] for call in group if role in direct_by_call[call['id']]]
                source_refs = [{'traceId': trace_id, 'sourceCallId': edge['source'],
                                'consumerCallId': edge['target']}
                               for edge in sorted((edge for cid in observed_at for edge in incoming[cid]),
                                                  key=lambda edge: edge_order[id(edge)])
                               if edge['source'] in calls
                               and role in _pattern_roles(edge['target'], [edge], calls)
                               and order[edge['source']] < order[edge['target']]]
                row = {'sourceTool': role[0], 'relation': role[1], 'inferred': role[2],
                       'targetPaths': list(role[3]), 'observedAt': observed_at,
                       'unknownAt': [call['id'] for call in group if call['id'] not in observed_at],
                       'sourceRefs': source_refs}
                role_rows.append(row)
            input_coverage = []
            for call, bundle in zip(group, bundles):
                input_coverage.append({'consumerCallId': call['id'],
                    'retainedCallIds': bundle['callIds'],
                    'recordedCallIds': bundle['recordedCallIds'],
                    'contextCallIds': bundle['contextCallIds'],
                    'boundaryInputs': bundle['boundaryInputs'],
                    'observedDirectRoles': [row for row in role_rows if call['id'] in row['observedAt']],
                    'unknownDirectRoles': [row for row in role_rows if call['id'] in row['unknownAt']],
                    'unobservedPreconditions': bundle['unobservedPreconditions']})
            all_recorded = {cid for bundle in bundles for cid in bundle['recordedCallIds']}
            all_boundaries = {cid for bundle in bundles for cid in bundle['boundaryInputs']}
            links = list(link_map.values())
            witness = {
                'run': trace_id, 'analysisKey': analysis.get('analysisKey'),
                'sourceOutcome': source_status,
                'resultAnchor': any(call['id'] in anchors for call in group),
                'semanticLevel': max((judgments.get(call['id'], {}).get('level', 'unknown')
                                      for call in group), key=lambda level: {
                                          'key': 3, 'supporting': 2, 'routine': 1, 'unknown': 0
                                      }.get(level, 0)),
                'consumerCallId': consumer_id,
                'consumerCallIds': [call['id'] for call in group],
                'callIds': call_ids,
                'recordedCallIds': sorted(all_recorded, key=order.get),
                'contextCallIds': [cid for cid in call_ids if cid not in all_recorded],
                'calls': [{'id': calls[cid]['id'], 'tool': calls[cid]['tool']} for cid in call_ids],
                'links': [_compact_link(edge) for edge in links],
                'boundaryInputs': sorted(all_boundaries, key=order.get),
                'directRoleCoverage': role_rows,
                'inputCoverage': input_coverage,
                'initialContextUses': [deepcopy(row) for row in analysis.get('initialContextUses', [])
                                       if row['targetCallId'] in union_ids],
                'inputBindings': [deepcopy(row) for row in analysis.get('inputBindings', [])
                                  if row['targetCallId'] in union_ids],
                'observedResults': [deepcopy(row) for row in analysis.get('observedResults', [])
                                    if row['callId'] in union_ids],
                'unobservedPreconditions': 'unknown across the union of bounded per-occurrence input cones'}
            pattern['witnesses'].append(witness)
    for pattern in patterns.values():
        pattern['supportTraces'] = sorted(set(pattern['supportTraces']))
        pattern['supportCount'] = len(pattern['supportTraces'])
        pattern['successfulSourceTraces'] = sorted(set(pattern['successfulSourceTraces']))
        pattern['failedSourceTraces'] = sorted(set(pattern['failedSourceTraces']))
        ordered = sorted(pattern['witnesses'], key=lambda w: (
            w['sourceOutcome'] != 'success', w['sourceOutcome'] == 'unknown',
            not w['resultAnchor'], w['semanticLevel'] != 'key', w['run'], w['consumerCallId']))
        first, rest, seen = [], [], set()
        for witness in ordered:
            (rest if witness['run'] in seen else first).append(witness)
            seen.add(witness['run'])
        pattern['witnesses'] = (first + rest)[:max_witnesses]
    return sorted(patterns.values(), key=lambda p: (
        -bool(p['explicitResultAnchorCount']), -bool(p['successfulSourceTraces']),
        -bool(p['keyActivityWitnessCount']), -p['supportCount'], -p['multiInputWitnessCount'], p['id']))[:limit]


def distill_candidate(analysis, targets):
    """Take the recorded ancestor cone of explicit targets, retaining all witnesses.

    Selecting an output is a caller decision. Inferred semantic links do not
    silently become executable prerequisites. The source analysis is untouched.
    """
    calls = {call['id']: call for call in analysis['calls']}
    incoming = defaultdict(list)
    for edge in analysis['flow']:
        if not edge.get('inferred'):
            incoming[edge['target']].append(edge)
    selected = set(targets)
    queue = list(targets)
    while queue:
        for edge in incoming[queue.pop()]:
            if edge['source'] not in selected:
                selected.add(edge['source'])
                queue.append(edge['source'])
    steps = [call for call in analysis['calls'] if call['id'] in selected]
    edges = [edge for edge in analysis['flow'] if not edge.get('inferred')
             and edge['source'] in selected and edge['target'] in selected]
    return {'status': 'candidate', 'traceId': analysis['traceId'],
            'targets': list(targets), 'callIds': [call['id'] for call in steps],
            'steps': steps, 'dependencies': edges,
            'sourceCallCount': len(calls), 'selectedCallCount': len(steps),
            'excludedCallIds': [cid for cid in calls if cid not in selected],
            'validation': 'unexecuted; recurrence does not establish transfer or causal effect'}


def mine_paths(analyses, max_nodes=3):
    """Join observed call paths by tool roles; retain complete per-run witnesses.

    These are candidates for subsequent argument binding and validation, not
    executable skills. Enumerating source paths avoids fabricated quotient paths.
    """
    patterns = {}
    for analysis in analyses:
        calls = {call['id']: call for call in analysis['calls']}
        outgoing = defaultdict(list)
        for edge in analysis['flow']:
            if not edge.get('inferred'):
                outgoing[edge['source']].append(edge)
        seen = set()

        def visit(ids, links):
            if len(ids) >= 2:
                signature = [calls[cid]['tool'] for cid in ids]
                roles = [sorted({item.get('targetPath', '') for item in link.get('evidence', [])})
                         for link in links]
                key = digest([signature, roles])[:20]
                pattern = patterns.setdefault(key, {'id': key, 'tools': signature, 'inputRoles': roles,
                                                   'witnesses': []})
                witness_key = (key, tuple(ids))
                if witness_key not in seen:
                    seen.add(witness_key)
                    pattern['witnesses'].append({'run': analysis['traceId'], 'callIds': ids,
                                                 'links': links})
            if len(ids) == max_nodes:
                return
            for edge in outgoing[ids[-1]]:
                if edge['target'] not in ids:
                    visit(ids + [edge['target']], links + [edge])

        for cid in calls:
            visit([cid], [])
    for pattern in patterns.values():
        pattern['supportTraces'] = sorted({w['run'] for w in pattern['witnesses']})
        pattern['supportCount'] = len(pattern['supportTraces'])
    return sorted(patterns.values(), key=lambda item: (-item['supportCount'], item['id']))
