"""Task-neutral skill evidence: keep full examples until compression is necessary."""

import json

from evidence_records import EvidenceAliases
from initial_context import normalize_initial_context
from pattern_selection import select_pattern_examples
from skill_patterns import mine_input_patterns


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def historical_outcome(analysis):
    status = analysis.get('trainingOutcome', {}).get('status', 'unknown')
    return f'Recorded task outcome: {status} (whole execution; individual steps may differ).'


def render_skill_evidence(analyses, refs=None, graph=True):
    """Render recorded data without projecting output rows or clipping parameters.

    Exact repeated contexts and observation payloads are shared. Aliases and call
    IDs remain scoped to each source example; interpretations stay separate.
    """
    blocks = ['## Concrete Examples',
        'Observation references copy an earlier payload into this occurrence. '
        'They do not merge events or entities; call IDs and resource aliases remain local to each example.']
    contexts = {}
    observations = {}
    if graph:
        blocks.append('Graph table columns: ' + _json({
            'dependencies': ['source', 'target', 'relation', 'inferred'],
            'inputBindings': ['target', 'parameter', 'parents', 'initialContext', 'reviewCoverage', 'reportedMissingInputs'],
            'contextDerivations': ['target', 'parameter', 'role', 'initialContext', 'interpretation'],
            'parents': ['call', 'included', 'role', 'sourceEvidence', 'interpretation'],
            'repeatedCalls': ['tool', 'callIds', 'statuses'],
            'initialContext': ['context', 'path']}) +
            '. These are cited dependency hypotheses, not causal proof. '
            'Parents in one input binding jointly explain the same consumer parameter. '
            'Their interpretations describe how the cited inputs combine; they are not recorded actions '
            'or additional task instructions. Verify them against the source observations and consumer arguments. '
            'Context derivations explain how source instructions may determine recorded arguments; '
            'verify their interpretations against the cited context and action. '
            'Review coverage and reported missing inputs are review diagnostics, not task constraints. '
            'Collection length covers only the cited response; complete means the cited record was not clipped, '
            'not that all pages were retrieved. Repeated calls are distinct recorded actions, not proof of repeated external effects.')
    for ordinal, analysis in enumerate(analyses):
        run = analysis['traceId']
        calls = [call for call in analysis['calls'] if refs is None or (run, call['id']) in refs]
        if not calls:
            continue
        records = EvidenceAliases()
        blocks.append(f'Example {ordinal} (call IDs and aliases are local to this example):')
        blocks.append('Query: ' + records._safe(analysis.get('taskDescription') or ''))
        blocks.append(historical_outcome(analysis))
        context_aliases = {}
        for item in normalize_initial_context(analysis):
            if item['content'] == analysis.get('taskDescription'):
                context_aliases[item['id']] = 'query'
                continue
            identity = _json([item['role'], item.get('agentId'), item['content']])
            if identity not in contexts:
                contexts[identity] = f'context{len(contexts)}'
                blocks.append('Source context ' + contexts[identity] + ': ' + _json({
                    'role': item['role'], 'content': records._safe(item['content'])}))
            else:
                # Resolve local aliases in the same order even when the text is shared.
                records._safe(item['content'])
                blocks.append('Source context: ' + contexts[identity])
            context_aliases[item['id']] = contexts[identity]
        selected = {call['id'] for call in calls}
        annotation_position = len(blocks)
        for call in calls:
            arguments = _json(records._safe(call.get('args', {})))
            observation = _json({'status': call.get('status'),
                                 'response': records._safe(call.get('response'))})
            if observation in observations:
                output = '<observation ref="' + observations[observation] + '" />'
            else:
                label = 'observation' + str(len(observations))
                observations[observation] = label
                output = '<observation id="' + label + '">\n' + observation + '\n</observation>'
            blocks.append(f"Recorded step {call['id']}:\n<action>\n" + call['tool'] + '(' +
                arguments + ')\n</action>\n' + output)
        blocks.append('<recorded final response>\n' + _json(records._safe(
            analysis.get('finalOutput', ''))) + '\n</recorded final response>')
        if graph:
            review = analysis.get('evidenceReview', {})
            bindings = []
            for binding in analysis.get('inputBindings', review.get('inputBindings', [])):
                if binding['targetCallId'] not in selected:
                    continue
                parents = binding.get('parents', [])
                bindings.append([binding['targetCallId'], binding['targetPath'],
                    [[parent['sourceCallId'], parent['sourceCallId'] in selected, parent.get('inputRole'),
                        [{key: row[key] for key in ('path', 'field', 'collectionPath',
                            'collectionLength', 'complete') if key in row}
                            for row in parent.get('selectedEvidence', [])
                            if row.get('callId') == parent['sourceCallId']],
                        records._safe(parent.get('rule', ''))] for parent in parents],
                    [[context_aliases[row['contextId']], row['path']]
                        for row in binding.get('contextEvidence', [])],
                    binding.get('status', 'unknown'), records._safe(binding.get('missingInputs', []))])
            repeated = {}
            for call in calls:
                repeated.setdefault((call['tool'], _json(call.get('args', {}))), []).append(call)
            annotations = {
                'dependencies': [[edge['source'], edge['target'],
                    edge.get('relation', 'recorded'), bool(edge.get('inferred'))]
                    for edge in analysis['flow'] if {edge['source'], edge['target']} <= selected],
                'inputBindings': bindings,
                'repeatedCalls': [[group[0]['tool'], [call['id'] for call in group],
                    [call.get('status', 'unknown') for call in group]]
                    for group in repeated.values() if len(group) > 1],
                'contextDerivations': [[use['targetCallId'], use['targetPath'], use['inputRole'],
                    [[context_aliases[row['contextId']], row['path']]
                        for row in use['contextEvidence']], records._safe(use['rule'])]
                    for use in analysis.get('initialContextUses', [])
                    if use['targetCallId'] in selected]}
            blocks.insert(annotation_position, '<derived graph annotations>\n' + _json(annotations) +
                          '\n</derived graph annotations>')
    return '\n'.join(blocks + ['## Summary Workflows'])


def pack_skill_evidence(analyses, budget=96000, graph=True):
    """Pack whole source records and cited graph annotations under one budget."""
    all_refs = {(a['traceId'], c['id']) for a in analyses for c in a['calls']}
    complete = render_skill_evidence(analyses, graph=graph)
    if not graph:
        if len(complete) <= budget:
            return {'examples': complete, 'refs': sorted(all_refs), 'mode': 'complete',
                    'sourceCalls': len(all_refs), 'includedCalls': len(all_refs), 'budget': budget}
        raise ValueError(f'Full raw evidence requires {len(complete)} characters; budget is {budget}.')
    patterns = mine_input_patterns(analyses, max_depth=3, max_nodes=64, limit=10000,
        max_witnesses=sum(len(a['calls']) for a in analyses))
    render = lambda refs: render_skill_evidence(analyses, refs, graph=True)
    units, refs = select_pattern_examples(patterns, analyses, render, budget=budget)
    focused = any(unit['features'].get('resultRecipeFocus') for unit in units)
    if len(complete) <= budget and not focused:
        return {'examples': complete, 'refs': sorted(all_refs), 'mode': 'complete',
                'sourceCalls': len(all_refs), 'includedCalls': len(all_refs), 'budget': budget}
    if not refs:
        raise ValueError('No complete input witness fits the skill evidence budget.')
    examples = render(refs)
    return {'examples': examples, 'refs': sorted(refs),
            'mode': 'result-patterns' if focused else 'whole-witness-compression',
            'sourceCalls': len(all_refs), 'includedCalls': len(refs), 'budget': budget}
