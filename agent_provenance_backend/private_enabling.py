"""Exact, content-free private-state enabling relations."""
import json
from bisect import bisect_left
from collections import defaultdict

from evidence_records import RecordEvidence, _secret_key, _secret_kind


def private_enabling_relations(analysis):
    """Return unique earlier private-state producers and content-free diagnostics.

    Values are compared only in memory. A producer is excluded when the same
    typed private value is already among its own private input slots.
    """
    calls = analysis.get('calls', [])
    evidence = RecordEvidence(analysis)
    positions = {call['id']: pos for pos, call in enumerate(calls)}

    def slots(value):
        for path, key, item in evidence._scalar_locations(value, ''):
            if (_secret_key(key) and isinstance(item, (str, dict, list)) and item and
                    not (isinstance(item, str) and not item.strip())):
                signature = (_secret_kind(key), type(item),
                    json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(',', ':')))
                yield path, signature

    input_signatures = {
        call['id']: {signature for _, signature in slots(call.get('args') or {})}
        for call in calls
    }
    outputs = defaultdict(list)
    for pos, call in enumerate(calls):
        if call.get('status') == 'error':
            continue
        for path, signature in slots(call.get('response')):
            if signature not in input_signatures[call['id']]:
                outputs[signature].append((pos, call['id'], path))
    output_positions = {signature: [row[0] for row in rows]
                        for signature, rows in outputs.items()}

    relations, diagnostics = [], []
    for target in calls:
        target_pos = positions[target['id']]
        for target_path, signature in slots(target.get('args') or {}):
            candidates = outputs.get(signature, ())
            earlier_count = bisect_left(output_positions.get(signature, ()), target_pos)
            if earlier_count == 1:
                _, source, source_path = candidates[0]
                relations.append({'source': source, 'target': target['id'],
                    'sourcePath': source_path, 'targetPath': target_path,
                    'relation': 'enabling',
                    'evidenceMode': 'exact_private_value_match'})
            else:
                diagnostics.append({'target': target['id'], 'targetPath': target_path,
                    'status': 'ambiguous_prior_producer' if earlier_count > 1
                        else 'no_unique_prior_producer',
                    'candidateCount': earlier_count})
    return relations, diagnostics


def close_over_enablers(call_ids, relations):
    """Transitively include unique enabling producers, without changing data flow."""
    by_target = defaultdict(list)
    for relation in relations:
        by_target[relation['target']].append(relation['source'])
    closed = set(call_ids)
    pending = list(closed)
    while pending:
        for source in by_target.get(pending.pop(), ()):
            if source not in closed:
                closed.add(source)
                pending.append(source)
    return closed
