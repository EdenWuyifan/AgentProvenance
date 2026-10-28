"""Group source-grounded repetitions inside one analysis."""

from collections import defaultdict


_MISSING = object()


def _pointer_parts(path):
    return [part.replace('~1', '/').replace('~0', '~')
            for part in path.strip('/').split('/') if part]


def _pointer_value(value, path):
    for part in _pointer_parts(path):
        if isinstance(value, list):
            try:
                value = value[int(part)]
            except (ValueError, IndexError):
                return _MISSING
        elif isinstance(value, dict) and part in value:
            value = value[part]
        else:
            return _MISSING
    return value


def _scalar(value):
    return value is None or isinstance(value, (str, int, float, bool))


def _fixed_value(value):
    if isinstance(value, dict):
        return ('dict', tuple(sorted((key, _fixed_value(item)) for key, item in value.items())))
    if isinstance(value, list):
        return ('list', tuple(_fixed_value(item) for item in value))
    return value


def _fixed_arguments(call):
    args = call.get('args', {})
    if not isinstance(args, dict):
        return None
    return (tuple(sorted(args)), tuple(sorted((key, _fixed_value(value))
                                            for key, value in args.items() if not _scalar(value))))


def exact_bindings(analysis, consumer, calls_by_id, order):
    """Citations whose raw earlier source value equals a consumer argument."""
    bindings = []
    for edge in analysis.get('flow', []):
        source_id = edge.get('source')
        if edge.get('target') != consumer['id'] or source_id not in calls_by_id:
            continue
        if order[source_id] >= order[consumer['id']]:
            continue
        citations = edge.get('evidence', []) + edge.get('selectedEvidence', [])
        # Recorded references store both pointer paths on one citation;
        # interpreted links instead store separate source/consumer citations.
        for item in citations:
            if edge.get('inferred') or 'sourcePath' not in item or 'targetPath' not in item:
                continue
            value = _pointer_value(calls_by_id[source_id].get('response'), item['sourcePath'])
            consumed = _pointer_value(consumer.get('args', {}), item['targetPath'])
            if value is not _MISSING and consumed is not _MISSING and value is not None and value == consumed:
                bindings.append({'sourceCallId': source_id, 'sourcePath': item['sourcePath'],
                    'targetPath': item['targetPath'], 'inferred': False,
                    'relation': edge.get('relation', 'data_flow')})
        sources = [item for item in citations
                   if item.get('callId') == source_id and item.get('field') in ('response', 'result')]
        targets = [item for item in citations
                   if item.get('callId') == consumer['id'] and item.get('field') == 'args']
        for source in sources:
            source_path = source.get('sourcePath') or source.get('path')
            if source_path is None:
                continue
            source_value = _pointer_value(calls_by_id[source_id].get(source['field']), source_path)
            for target in targets:
                target_path = target.get('targetPath') or target.get('path')
                if target_path is None:
                    continue
                target_value = _pointer_value(consumer.get('args', {}), target_path)
                if source_value is not _MISSING and target_value is not _MISSING and source_value == target_value:
                    bindings.append({'sourceCallId': source_id, 'sourcePath': source_path,
                                     'targetPath': target_path,
                                     'inferred': bool(edge.get('inferred')),
                                     'relation': edge.get('relation', 'data_flow')})
    return bindings


def edge_role(edge, consumer_id, calls_by_id):
    paths = tuple(sorted(item.get('targetPath', '') for item in edge.get('evidence', [])
                         if item.get('targetPath')))
    if edge.get('inferred'):
        paths = tuple(sorted({item['path'] for item in edge.get('evidence', [])
                              if item.get('callId') == consumer_id and item.get('field') == 'args'}))
    return (calls_by_id[edge['source']].get('tool'), edge.get('relation', 'data_flow'),
            bool(edge.get('inferred', False)), paths)


def direct_roles(analysis, consumer, calls_by_id, order):
    return {edge_role(edge, consumer['id'], calls_by_id)
            for edge in analysis.get('flow', [])
            if edge.get('target') == consumer['id'] and edge.get('source') in calls_by_id
            and order[edge['source']] < order[consumer['id']]}


def _compatible(calls, bound_paths):
    args = [call.get('args', {}) for call in calls]
    if any(not isinstance(arg, dict) for arg in args) or any(set(arg) != set(args[0]) for arg in args[1:]):
        return False
    for key in args[0]:
        values = [arg[key] for arg in args]
        if all(value == values[0] for value in values[1:]):
            continue
        if not all(_scalar(value) and type(value) is type(values[0]) for value in values):
            return False
        path = '/' + key.replace('~', '~0').replace('/', '~1')
        for call in calls:
            if path not in bound_paths[call['id']]:
                return False
    return True


def group_repetitions(analysis):
    """Return maximal compatible same-tool groups; never cross analysis runs."""
    calls = analysis.get('calls', [])
    order = {call['id']: i for i, call in enumerate(calls)}
    calls_by_id = {call['id']: call for call in calls}
    incoming = defaultdict(list)
    for edge in analysis.get('flow', []):
        incoming[edge['target']].append(edge)
    # Evidence matching is independent of the proposed group. Compute it once
    # per consumer instead of rescanning the trace for every candidate pair.
    bound_paths = {call['id']: {binding['targetPath'] for binding in exact_bindings(
        {'flow': incoming[call['id']]}, call, calls_by_id, order)} for call in calls}
    roles = {call['id']: direct_roles({'flow': incoming[call['id']]}, call, calls_by_id, order)
             for call in calls}
    by_tool = defaultdict(list)
    for call in calls:
        by_tool[(call.get('tool'), call.get('agentId'))].append(call)
    groups = []
    for members in by_tool.values():
        candidates = defaultdict(list)
        ordered_candidates = []
        for call in members:
            placed = False
            shape = _fixed_arguments(call)
            if shape is None:
                continue
            for group, group_roles in candidates[shape]:
                if not group_roles & roles[call['id']]:
                    continue
                if _compatible(group + [call], bound_paths):
                    group.append(call)
                    group_roles.update(roles[call['id']])
                    placed = True
                    break
            if not placed:
                candidate = ([call], set(roles[call['id']]))
                candidates[shape].append(candidate)
                ordered_candidates.append(candidate)
        groups.extend(group for group, _ in ordered_candidates if len(group) > 1)
    return groups
