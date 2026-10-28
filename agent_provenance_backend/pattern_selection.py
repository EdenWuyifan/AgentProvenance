"""Budgeted selection of complete, source-grounded input-pattern witnesses."""

import json
import re
from collections import defaultdict
from skill_patterns import complete_example
from private_enabling import private_enabling_relations


def _input_closure(call_ids, analysis, bindings, enabling):
    """Keep cited argument sources and recorded prerequisites in their source run."""
    incoming = defaultdict(set)
    for edge in analysis.get('flow', []):
        if not edge.get('inferred'):
            incoming[edge['target']].add(edge['source'])
    for binding in bindings:
        incoming[binding.get('targetCallId')].update(
            parent['sourceCallId'] for parent in binding.get('parents', []))
    for edge in enabling:
        incoming[edge['target']].add(edge['source'])
    closed = set(call_ids)
    pending = list(closed)
    while pending:
        for source in incoming[pending.pop()] - closed:
            closed.add(source)
            pending.append(source)
    return closed


def _joint_argument(witness):
    return any(len({parent['sourceCallId'] for parent in binding.get('parents', [])
                    if parent.get('inputRole') != 'enabling'}) > 1
               for binding in witness.get('inputBindings', [])
               if binding.get('targetCallId') in witness['consumerCallIds'])


def _coverage(witness):
    tools = {call['id']: call['tool'] for call in witness.get('calls', [])}
    roles = {('direct', row['sourceTool'], row['relation'], row['inferred'], tuple(row['targetPaths']))
             for row in witness.get('directRoleCoverage', []) if row.get('sourceRefs')}
    for consumer in witness.get('consumerCallIds', []):
        joint = {('direct', row['sourceTool'], row['relation'], row['inferred'], tuple(row['targetPaths']))
                 for row in witness.get('directRoleCoverage', []) if consumer in row.get('observedAt', [])}
        if len(joint) > 1:
            roles.add(('direct_joint', tuple(sorted(joint, key=repr))))
    bindings = set()
    for binding in witness.get('inputBindings', []):
        joint = []
        for parent in binding.get('parents', []):
            signature = (parent.get('inputRole'), tools.get(parent.get('sourceCallId')), tuple(sorted({
                              re.sub(r'/\d+(?=/|$)', '/*', item.get('path', ''))
                              for item in parent.get('selectedEvidence', [])
                              if item.get('callId') == parent.get('sourceCallId')})))
            bindings.add(('binding', binding.get('targetPath'), *signature))
            joint.append(signature)
        if len(joint) > 1:
            bindings.add(('joint', binding.get('targetPath'), tuple(sorted(set(joint), key=repr))))
    for use in witness.get('initialContextUses', []):
        bindings.add(('context', use.get('targetPath'), use.get('inputRole')))
    # Equal dependency shapes do not make successful and failed histories
    # interchangeable, nor does a single occurrence demonstrate a repeated loop.
    if witness.get('sourceOutcome') in {'success', 'failure'}:
        bindings.add(('historical_outcome', witness['sourceOutcome']))
    if len(witness.get('consumerCallIds', [])) > 1:
        bindings.add(('occurrences', 'multiple'))
    return roles | bindings


def _quality(witness):
    links = witness.get('links', [])
    bindings = witness.get('inputBindings', [])
    missing = sum(len(link.get('missingInputs', [])) for link in links)
    missing += sum(len(binding.get('missingInputs', [])) for binding in bindings)
    missing += len(witness.get('boundaryInputs', []))
    input_count = max(len({(row['sourceTool'], row['relation'], row['inferred'],
                           tuple(row['targetPaths'])) for row in witness.get('directRoleCoverage', [])}),
                      max((len(binding.get('parents', [])) for binding in bindings), default=0))
    has_input_evidence = bool(links or bindings or witness.get('directRoleCoverage'))
    return (missing == 0 if has_input_evidence else None), input_count > 1


def _outcome_magnitude(analysis, call_ids):
    values = [abs(value) for row in analysis.get('graphImportance', [])
              if set(row['calls']) & set(call_ids) and row.get('O', {}).get('status') != 'unavailable'
              for value in row.get('O', {}).get('values', [])]
    return sum(values) / len(values) if values else None


def _graph_features(analysis, call_ids):
    """Summarize generic semantic and result evidence for overlapping calls."""
    rows = [row for row in analysis.get('graphImportance', [])
            if set(row.get('calls', [])) & set(call_ids)]
    semantic_rank = {'key': 2, 'supporting': 1, 'routine': 0}
    semantic = [semantic_rank[row['S']['level']] for row in rows
                if row.get('S', {}).get('level') in semantic_rank]
    result = [len(row['R'].get('supportedClaims', []))
              for row in rows if row.get('R', {}).get('status') == 'supported']
    return (max(semantic) if semantic else None, sum(result) if result else None)


def select_pattern_examples(patterns, analyses, render, budget=24000, successful_only=False,
                            sro_weights=(1.0, 1.0, 1.0)):
    """Select whole witness examples within a rendered-size budget.

    ``render(refs)`` renders the cumulative set of ``(run, callId)`` references
    and returns text or its numeric cost. Each returned
    unit contains one complete original witness. Repeated calls may share input
    roles while returning distinct observations, so selection does not sample them.
    ``sro_weights`` scales semantic, result and outcome ranking signals. Disabling
    result weighting also disables result-recipe focus, retaining diagnostic
    coverage across the original source histories.
    When a complete successful multi-source result is available, recipe packing
    focuses successful result witnesses. Other histories remain in the source
    graph; spare capacity is not a reason to mix their partial recipes into it.
    """
    by_run = {analysis['traceId']: analysis for analysis in analyses}
    enabling_by_trace = {analysis['traceId']: private_enabling_relations(analysis)[0]
                         for analysis in analyses}
    candidates = []
    for pattern in patterns:
        for witness in pattern.get('witnesses', []):
            if successful_only and witness.get('sourceOutcome') != 'success':
                continue
            analysis = by_run.get(witness['run'], {})
            example = complete_example(witness)
            bindings = {(row.get('targetCallId'), row.get('targetPath')): row
                        for row in analysis.get('inputBindings', [])}
            bindings.update({(row.get('targetCallId'), row.get('targetPath')): row
                             for row in witness.get('inputBindings', [])})
            call_ids = _input_closure(example['callIds'], analysis, bindings.values(),
                                     enabling_by_trace.get(witness['run'], []))
            calls = analysis.get('calls', witness.get('calls', []))
            example = {**example, 'callIds': [call['id'] for call in calls if call['id'] in call_ids]}
            witness = {**witness, 'callIds': example['callIds'],
                       'inputBindings': [row for row in bindings.values()
                                         if row.get('targetCallId') in call_ids],
                       'boundaryInputs': [cid for cid in witness.get('boundaryInputs', [])
                                          if cid not in call_ids],
                       'calls': [{'id': call['id'], 'tool': call['tool']}
                                 for call in calls if call['id'] in call_ids],
                       'enablingRelations': [edge for edge in enabling_by_trace.get(witness['run'], [])
                           if {edge['source'], edge['target']} <= call_ids]}
            refs = {(witness['run'], call_id) for call_id in example['callIds']}
            no_known_missing, multi_input = _quality(witness)
            semantic_importance, result_support = _graph_features(analysis, example['callIds'])
            unit = {'patternId': pattern['id'], 'witness': witness, 'features': {
                'sourceOutcome': witness.get('sourceOutcome', 'unknown'),
                'consumerError': any(call.get('status') == 'error' for call in calls
                    if call['id'] in example['consumerCallIds']),
                'resultAnchor': witness.get('resultAnchor', False),
                'semanticLevel': witness.get('semanticLevel', 'unknown'),
                'supportCount': pattern.get('supportCount', 0),
                'noKnownMissingInputs': no_known_missing, 'multiInput': multi_input,
                'jointArgument': _joint_argument(witness),
                'semanticImportance': semantic_importance, 'resultSupport': result_support,
                'outcomeMagnitude': _outcome_magnitude(analysis, example['callIds'])},
                'refs': refs, 'example': example}
            unit['_coverage'] = _coverage(witness)
            consumer = next(call for call in calls if call['id'] == witness['consumerCallId'])
            unit['_family'] = json.dumps([consumer['tool'], pattern.get('argumentShape')], sort_keys=True)
            candidates.append(unit)

    if sro_weights[1]:
        successful_results = [unit for unit in candidates
            if unit['features']['sourceOutcome'] == 'success'
            and not unit['features']['consumerError']
            and (unit['features']['resultAnchor'] or unit['features']['resultSupport'])]
        junctions = [unit for unit in successful_results
                     if unit['features']['jointArgument']
                     and unit['features']['noKnownMissingInputs'] is True]
        if junctions:
            def fits(unit):
                rendered = render(unit['refs'])
                return (rendered if isinstance(rendered, (int, float)) else len(rendered)) <= budget

            # Do not substitute cheap prefixes when the result derivation cannot fit.
            if not any(fits(unit) for unit in junctions):
                return [], set()
            candidates = successful_results
            for unit in candidates:
                unit['features']['resultRecipeFocus'] = True

    level_rank = {'key': 3, 'supporting': 2, 'routine': 1, 'unknown': 0}
    selected, refs = [], set()
    family_coverage = {}
    costs = {(analysis['traceId'], call['id']): len(json.dumps(call, ensure_ascii=False))
             for analysis in analyses for call in analysis['calls']}
    source_costs = {analysis['traceId']: len(json.dumps({key: analysis.get(key) for key in
        ('taskDescription', 'initialContext', 'initialMessages', 'finalOutput')}, ensure_ascii=False))
        for analysis in analyses}

    def priority(unit):
        features = unit['features']
        prior = family_coverage.get(unit['_family'], set())
        gain = len(unit['_coverage'] - prior) + (unit['_family'] not in family_coverage)
        cost = sum(costs.get(ref, 1) for ref in unit['refs'] - refs)
        if not any(run == unit['witness']['run'] for run, _ in refs):
            cost += source_costs.get(unit['witness']['run'], 0)
        semantic = max(level_rank.get(features['semanticLevel'], 0) / 3,
                       (features['semanticImportance'] or 0) / 2)
        result = bool(features['resultAnchor'] or features['resultSupport'])
        outcome = min(features['outcomeMagnitude'] or 0, 1)
        positive = features['sourceOutcome'] == 'success' and not features['consumerError']
        # Reserve room for a whole result derivation before buying cheaper fragments.
        # Missing annotations remain eligible; this is a priority, not an S/R gate.
        result_junction = (bool(sro_weights[1]) and result and features['jointArgument']
                           and features['noKnownMissingInputs'] is True
                           and not features['consumerError'])
        # S/R/O favor relevant evidence without making rank a hard budget gate.
        weight = (1 + sro_weights[0] * semantic + sro_weights[1] * result
                  + sro_weights[2] * outcome + positive)
        return (result_junction, positive if result_junction else False,
                gain * weight / max(cost, 1), not features['consumerError'], positive,
                features['multiInput'], bool(features['noKnownMissingInputs']),
                bool(sro_weights[1]) and result, features['supportCount'])

    # Costs estimate ordering only. The actual cumulative rendering enforces the cap.
    candidates.sort(key=lambda unit: (unit['witness']['run'], unit['witness']['consumerCallId']))
    while candidates:
        candidates = [unit for unit in candidates if unit['_family'] not in family_coverage
                      or unit['_coverage'] - family_coverage[unit['_family']]]
        if not candidates:
            break
        unit = max(candidates, key=priority)
        candidates.remove(unit)
        coverage = unit['_coverage']
        rendered = render(refs | unit['refs'])
        total = rendered if isinstance(rendered, (int, float)) else len(rendered)
        if total > budget:
            continue
        unit.pop('_coverage')
        selected.append(unit)
        refs.update(unit['refs'])
        family_coverage.setdefault(unit.pop('_family'), set()).update(coverage)
    return selected, refs
