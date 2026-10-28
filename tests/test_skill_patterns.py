import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agent_provenance_backend'))
from skill_patterns import (distill_candidate, distill_input_bundle,
                            mine_input_patterns, mine_paths)


def test_distillation_preserves_multiple_inputs_and_does_not_assume_inference():
    analysis = {'traceId': 'run', 'calls': [{'id': x, 'tool': x} for x in 'abcd'],
                'flow': [{'source': 'a', 'target': 'd'}, {'source': 'b', 'target': 'd'},
                         {'source': 'c', 'target': 'd', 'inferred': True}]}
    candidate = distill_candidate(analysis, ['d'])
    assert candidate['callIds'] == ['a', 'b', 'd']
    assert candidate['excludedCallIds'] == ['c']
    assert len(candidate['dependencies']) == 2
    assert len(analysis['calls']) == 4


def test_joint_candidates_cannot_stitch_paths_across_runs():
    def analysis(run, tools, edges):
        return {'traceId': run, 'calls': [{'id': x, 'tool': x} for x in tools],
                'flow': [{'source': a, 'target': b} for a, b in edges]}
    patterns = mine_paths([analysis('one', 'ab', [('a', 'b')]),
                           analysis('two', 'bc', [('b', 'c')])])
    assert not any(p['tools'] == ['a', 'b', 'c'] for p in patterns)
    assert {tuple(p['tools']) for p in patterns} == {('a', 'b'), ('b', 'c')}


def test_repeated_calls_count_as_one_run_support():
    analysis = {'traceId': 'one', 'calls': [{'id': str(i), 'tool': 't'} for i in range(3)],
                'flow': [{'source': '0', 'target': '1'}, {'source': '1', 'target': '2'}]}
    pair = next(p for p in mine_paths([analysis]) if len(p['tools']) == 2)
    assert pair['supportCount'] == 1
    assert len(pair['witnesses']) == 2


def test_alternative_consumer_roles_keep_their_own_witnesses():
    analysis = {'traceId': 'one', 'calls': [{'id': x, 'tool': x} for x in 'ab'],
                'flow': [{'source': 'a', 'target': 'b', 'evidence': [{'targetPath': path}]}
                         for path in ['/primary', '/comparison']]}
    patterns = mine_paths([analysis])
    assert len(patterns) == 2
    assert all(p['supportCount'] == 1 and len(p['witnesses']) == 1 for p in patterns)


def test_consumer_bundle_keeps_all_unequal_depth_branches_and_raw_calls():
    calls = [
        {'id': 'a', 'tool': 'source_a', 'args': {'token': 'a'}, 'response': {'id': 'A'}},
        {'id': 'b', 'tool': 'source_b', 'args': {'token': 'b'}, 'response': {'id': 'B'}},
        {'id': 'c', 'tool': 'combine', 'args': {'id': 'B'}, 'response': {'id': 'C'}},
        {'id': 'e', 'tool': 'filter', 'args': {'conditions': [{'op': '<', 'value': 1}],
                                                'enabled': True}, 'response': {'id': 'E'}},
    ]
    analysis = {'traceId': 'run', 'calls': calls,
                'flow': [{'source': 'a', 'target': 'e'}, {'source': 'b', 'target': 'c'},
                         {'source': 'c', 'target': 'e'}]}
    before = repr(analysis)
    bundle = distill_input_bundle(analysis, 'e')
    assert bundle['callIds'] == ['a', 'b', 'c', 'e']
    assert bundle['recordedCallIds'] == ['a', 'b', 'c', 'e']
    assert [call['id'] for call in bundle['steps']] == bundle['callIds']
    assert bundle['steps'][1]['response'] == {'id': 'B'}
    assert repr(analysis) == before


def test_inferred_parents_are_context_not_recorded_steps():
    analysis = {'traceId': 'r', 'calls': [{'id': 'source', 'tool': 'lookup'},
                                          {'id': 'consumer', 'tool': 'act'}],
                'flow': [{'source': 'source', 'target': 'consumer', 'inferred': True}]}
    bundle = distill_input_bundle(analysis, 'consumer')
    assert bundle['callIds'] == ['source', 'consumer']
    assert bundle['contextCallIds'] == ['source']
    assert bundle['recordedCallIds'] == ['consumer']
    assert bundle['links'][0]['inferred'] is True


def test_patterns_pool_ancestor_variants_without_stitching_witnesses():
    def make(run, prefix, prior_tool):
        calls = [{'id': prefix + '0', 'tool': prior_tool, 'args': {'x': 1}},
                 {'id': prefix + '1', 'tool': 'csv_read', 'args': {'id': 'opaque'}},
                 {'id': prefix + '2', 'tool': 'filter', 'args': {'enabled': True,
                                                                  'conditions': [{'op': '<'}]}}]
        return {'traceId': run, 'analysisKey': run + '-key', 'calls': calls,
                'flow': [{'source': prefix + '0', 'target': prefix + '1'},
                         {'source': prefix + '1', 'target': prefix + '2'}]}
    patterns = mine_input_patterns([make('one', 'a', 'csv_record'),
                                    make('two', 'b', 'csv_join')])
    pattern = next(item for item in patterns if item['consumerTool'] == 'filter')
    assert pattern['supportCount'] == 2
    assert {w['run'] for w in pattern['witnesses']} == {'one', 'two'}
    assert [w['callIds'] for w in pattern['witnesses']] == [['a0', 'a1', 'a2'],
                                                            ['b0', 'b1', 'b2']]
    assert all(not any(cid.startswith('a') for cid in w['callIds'] if w['run'] == 'two')
               for w in pattern['witnesses'])
    assert all('args' not in call and 'response' not in call
               for w in pattern['witnesses'] for call in w['calls'])


def test_patterns_keep_operator_direction_and_boolean_controls_distinct():
    def analysis(run, op, enabled):
        return {'traceId': run,
                'calls': [{'id': 's', 'tool': 'read', 'args': {}},
                          {'id': 'c', 'tool': 'filter', 'args': {
                              'enabled': enabled, 'conditions': [{'op': op}]}}],
                'flow': [{'source': 's', 'target': 'c'}]}
    patterns = mine_input_patterns([analysis('a', '<', True),
                                    analysis('b', '>', True),
                                    analysis('c', '<', False)])
    assert len([p for p in patterns if p['consumerTool'] == 'filter']) == 3


def test_bundle_reports_oversize_whole_and_depth_boundary():
    calls = [{'id': str(i), 'tool': 't'} for i in range(5)]
    wide = {'traceId': 'wide', 'calls': calls,
            'flow': [{'source': str(i), 'target': '4'} for i in range(4)]}
    result = distill_input_bundle(wide, '4', max_depth=1, max_nodes=3)
    assert result['status'] == 'oversized'
    chain = {'traceId': 'chain', 'calls': calls,
             'flow': [{'source': '0', 'target': '1'}, {'source': '1', 'target': '2'},
                      {'source': '2', 'target': '3'}, {'source': '3', 'target': '4'}]}
    result = distill_input_bundle(chain, '4', max_depth=2, max_nodes=5)
    assert result['callIds'] == ['2', '3', '4']
    assert result['boundaryInputs'] == ['1']
    assert result['unobservedPreconditions'] != ''


def test_default_raw_bundle_and_pattern_summary_use_the_same_capacity():
    a = {'traceId': 'wide', 'calls': [{'id': str(i), 'tool': 'read', 'args': {'i': i}} for i in range(21)],
         'flow': [{'source': str(i), 'target': '20'} for i in range(20)]}
    bundle = distill_input_bundle(a, '20')
    pattern = mine_input_patterns([a])[0]
    assert bundle['status'] == 'candidate' and len(bundle['steps']) == 21
    assert bundle['callIds'] == pattern['witnesses'][0]['callIds']


def test_support_counts_distinct_traces_not_repeated_consumers():
    def repeated(run):
        return {'traceId': run,
                'calls': [{'id': 's', 'tool': 'read', 'args': {}},
                          {'id': 'c1', 'tool': 'use', 'args': {'ok': True}},
                          {'id': 'c2', 'tool': 'use', 'args': {'ok': True}}],
                'flow': [{'source': 's', 'target': 'c1'}, {'source': 's', 'target': 'c2'}]}
    pattern = next(p for p in mine_input_patterns([repeated('same')])
                   if p['consumerTool'] == 'use')
    assert pattern['supportCount'] == 1
    assert len(pattern['witnesses']) == 1
    assert pattern['witnesses'][0]['consumerCallIds'] == ['c1', 'c2']


def test_repeated_consumers_resolve_recorded_dual_pointer_citations():
    from repeat_patterns import group_repetitions
    a = {'traceId': 'r', 'calls': [
        {'id': 's', 'tool': 'list', 'response': {'rows': [{'id': 10}, {'id': 20}]}},
        {'id': 'a', 'tool': 'apply', 'args': {'item_id': 10, 'mode': 'keep'}},
        {'id': 'b', 'tool': 'apply', 'args': {'item_id': 20, 'mode': 'keep'}}],
        'flow': [{'source': 's', 'target': cid, 'evidence': [{'kind': 'reference',
            'sourcePath': f'/rows/{index}/id', 'targetPath': '/item_id'}]}
            for index, cid in enumerate(['a', 'b'])]}
    assert [[c['id'] for c in group] for group in group_repetitions(a)] == [['a', 'b']]
    a['calls'][2]['args']['item_id'] = 99
    assert group_repetitions(a) == []


def test_complete_example_keep_a_rare_middle_input_branch():
    from skill_patterns import complete_example
    analysis = {'traceId': 'r', 'calls': [{'id': cid, 'tool': 'source' if cid in 'st' else 'apply',
        'args': {}} for cid in ['s', 't', 'c0', 'c1', 'c2']], 'flow': [
            {'source': 's', 'target': cid} for cid in ['c0', 'c1', 'c2']] + [
            {'source': 't', 'target': 'c1', 'inferred': True}]}
    witness = next(p for p in mine_input_patterns([analysis]) if p['consumerTool'] == 'apply')['witnesses'][0]
    example = complete_example(witness)
    assert example['consumerCallIds'] == ['c0', 'c1', 'c2']
    assert 't' in example['callIds']


def test_complete_example_keeps_all_occurrences_with_distinct_outputs():
    from skill_patterns import complete_example
    analysis = {'traceId': 'r', 'calls': [{'id': cid, 'tool': 'source' if cid == 's' else 'apply',
        'args': {}, 'response': {'member': cid}} for cid in ['s', 'c0', 'c1', 'c2', 'c3']], 'flow': [
            {'source': 's', 'target': cid} for cid in ['c0', 'c1', 'c2', 'c3']]}
    witness = mine_input_patterns([analysis])[0]['witnesses'][0]
    before = repr(witness)
    example = complete_example(witness)
    assert example['consumerCallIds'] == ['c0', 'c1', 'c2', 'c3']
    assert example['callIds'] == ['s', 'c0', 'c1', 'c2', 'c3']
    assert example['abstractedConsumerCallIds'] == []
    assert repr(witness) == before


def test_successful_source_witnesses_are_retained_first_using_explicit_labels():
    def source(run, status):
        return {'traceId': run, 'trainingOutcome': {'status': status},
                'calls': [{'id': 's', 'tool': 'read', 'args': {}},
                          {'id': 'c', 'tool': 'use', 'args': {'ok': True}}],
                'flow': [{'source': 's', 'target': 'c'}]}
    pattern = mine_input_patterns([source('unknown-run', 'unknown'),
                                   source('success-run', 'success'),
                                   source('failure-run', 'failure')], max_witnesses=2)[0]
    assert pattern['supportTraces'] == ['failure-run', 'success-run', 'unknown-run']
    assert [w['sourceOutcome'] for w in pattern['witnesses']] == ['success', 'failure']
    assert pattern['failedSourceTraces'] == ['failure-run']


def test_application_carries_explicit_training_status_without_thresholding_score():
    from app import with_context
    a = {'traceId': 'r', 'calls': [{'id': 's', 'tool': 'read'}, {'id': 'c', 'tool': 'act'}],
         'flow': [{'source': 's', 'target': 'c'}]}
    labeled = with_context(a, {'score': .2, 'trainingOutcome': {'status': 'success'}})
    assert mine_input_patterns([labeled])[0]['successfulSourceTraces'] == ['r']
    unlabeled = with_context(a, {'score': 1})
    assert mine_input_patterns([unlabeled])[0]['successfulSourceTraces'] == []


def test_retained_witnesses_cover_distinct_runs_before_repeated_occurrences():
    def make(run, count):
        return {'traceId': run, 'calls': [{'id': 's', 'tool': 'read'}] + [
            {'id': str(i), 'tool': 'use', 'args': {'column': 'signal'}} for i in range(count)],
            'flow': [{'source': 's', 'target': str(i)} for i in range(count)]}
    pattern = mine_input_patterns([make('a', 5), make('b', 1)], max_witnesses=2)[0]
    assert pattern['supportCount'] == 2
    assert {w['run'] for w in pattern['witnesses']} == {'a', 'b'}


def test_parameter_roles_and_numeric_signs_do_not_pool_opposite_selections():
    def make(run, field, value):
        return {'traceId': run, 'calls': [{'id': 's', 'tool': 'read'},
            {'id': 'c', 'tool': 'filter', 'args': {'column': field, 'op': '<', 'value': value}}],
            'flow': [{'source': 's', 'target': 'c'}]}
    patterns = mine_input_patterns([make('a', 'x', -1), make('b', 'x', 1), make('c', 'y', -1)])
    assert len(patterns) == 3


def test_pattern_ranking_uses_result_and_semantic_judgments_without_inventing_scores():
    a = {'traceId': 'a', 'calls': [{'id': x, 'tool': x} for x in ['s', 'key', 'target', 'routine']],
         'resultAnchors': ['target'], 'evidenceReview': {'events': {'key': {'level': 'key'}}},
         'flow': [{'source': 's', 'target': x} for x in ['key', 'target', 'routine']]}
    patterns = mine_input_patterns([a])
    assert [p['consumerTool'] for p in patterns] == ['target', 'key', 'routine']
    assert patterns[0]['witnesses'][0]['sourceOutcome'] == 'unknown'


def test_isolated_key_consumer_is_mined_as_a_standalone_witness():
    analysis = {'traceId': 'isolated', 'calls': [{'id': 'c', 'tool': 'decide', 'args': {'choice': 'yes'}}],
                'flow': [], 'evidenceReview': {'events': {'c': {'level': 'key'}}}}
    pattern, = mine_input_patterns([analysis])
    witness, = pattern['witnesses']
    assert witness['consumerCallId'] == 'c'
    assert witness['semanticLevel'] == 'key'
    assert witness['links'] == []


def test_repeated_group_uses_highest_member_semantic_level():
    analysis = {'traceId': 'repeat', 'calls': [
        {'id': 's', 'tool': 'read'},
        {'id': 'c1', 'tool': 'use', 'args': {'ok': True}},
        {'id': 'c2', 'tool': 'use', 'args': {'ok': True}}],
        'flow': [{'source': 's', 'target': 'c1'}, {'source': 's', 'target': 'c2'}],
        'evidenceReview': {'events': {'c1': {'level': 'routine'}, 'c2': {'level': 'key'}}}}
    witness = next(p for p in mine_input_patterns([analysis]) if p['consumerTool'] == 'use')['witnesses'][0]
    assert witness['semanticLevel'] == 'key'


def test_context_lengths_and_ordinal_variants_do_not_fragment_input_patterns():
    def make(run, count, ordinal):
        return {'traceId': run, 'calls': [{'id': 's', 'tool': 'receive'},
            {'id': 'c', 'tool': 'decide', 'args': {'selected_index': ordinal,
                'history': [{'round': i, 'context': {'values': [i]}} for i in range(1, count)]}}],
            'flow': [{'source': 's', 'target': 'c'}]}
    pattern = mine_input_patterns([make('a', 5, 0), make('b', 8, 4)])[0]
    assert pattern['supportCount'] == 2
    assert {w['run'] for w in pattern['witnesses']} == {'a', 'b'}
    a = make('a', 5, 0)
    assert distill_input_bundle(a, 'c')['steps'][1]['args']['selected_index'] == 0


def test_repeated_consumers_pool_union_roles_and_keep_missing_edges_unknown():
    calls = [
        {'id': 'directory', 'tool': 'directory', 'response': {'value': 'bill'}},
        {'id': 'bill', 'tool': 'read_bill', 'response': {'value': 'bill'}},
        {'id': 'contacts', 'tool': 'find_people', 'response': {'value': [
            {'email': 'a@example.test'}, {'email': 'b@example.test'}, {'email': 'c@example.test'}]}},
        {'id': 'c1', 'tool': 'send', 'args': {'user_email': 'a@example.test',
                                               'description': 'bill', 'amount': 9}},
        {'id': 'c2', 'tool': 'send', 'args': {'user_email': 'b@example.test',
                                               'description': 'bill', 'amount': 9}},
        {'id': 'c3', 'tool': 'send', 'args': {'user_email': 'c@example.test',
                                               'description': 'bill', 'amount': 9}},
    ]

    def edge(source, target, evidence=None, inferred=True, relation='context'):
        return {'source': source, 'target': target, 'inferred': inferred,
                'relation': relation, 'evidence': evidence or []}

    flows = [edge('directory', cid, inferred=False, relation='data_flow')
             for cid in ('c1', 'c2', 'c3')]
    flows.extend([edge('bill', cid, [
        {'callId': 'bill', 'field': 'response', 'path': '/value'},
        {'callId': cid, 'field': 'args', 'path': '/description'}])
        for cid in ('c2', 'c3')])
    flows.extend(edge('contacts', cid, [
        {'callId': 'contacts', 'field': 'response', 'path': f'/value/{i}/email'},
        {'callId': cid, 'field': 'args', 'path': '/user_email'}], relation='reference')
        for i, cid in enumerate(('c1', 'c2', 'c3')))
    analysis = {'traceId': 'repeat-run', 'calls': calls, 'flow': flows,
                'trainingOutcome': {'status': 'success'}}

    pattern, = [item for item in mine_input_patterns([analysis], limit=20)
                if item['consumerTool'] == 'send']
    witness, = pattern['witnesses']
    assert witness['consumerCallId'] == 'c1'
    assert witness['consumerCallIds'] == ['c1', 'c2', 'c3']
    assert witness['callIds'] == ['directory', 'bill', 'contacts', 'c1', 'c2', 'c3']
    bill_role = next(role for role in witness['directRoleCoverage']
                     if role['sourceTool'] == 'read_bill')
    assert bill_role['observedAt'] == ['c2', 'c3']
    assert bill_role['unknownAt'] == ['c1']
    assert [(ref['sourceCallId'], ref['consumerCallId']) for ref in bill_role['sourceRefs']] == [
        ('bill', 'c2'), ('bill', 'c3')]
    assert all(row['consumerCallId'] == cid for row, cid in zip(witness['inputCoverage'],
                                                               ['c1', 'c2', 'c3']))
    assert not any(link['source'] == 'bill' and link['target'] == 'c1'
                   for link in witness['links'])


def test_repeated_consumer_support_stays_within_each_source_trace():
    def analysis(run, prefix, repeated):
        calls = [{'id': prefix + 'source', 'tool': 'read', 'response': {'value': 'x'}},
                 {'id': prefix + 'c1', 'tool': 'use', 'args': {'item': 'x'}}]
        flows = [{'source': prefix + 'source', 'target': prefix + 'c1',
                  'evidence': [{'callId': prefix + 'source', 'field': 'response', 'path': '/value'},
                               {'callId': prefix + 'c1', 'field': 'args', 'path': '/item'}]}]
        if repeated:
            calls.append({'id': prefix + 'c2', 'tool': 'use', 'args': {'item': 'y'}})
            calls[0]['response'] = {'value': ['x', 'y']}
            flows[0]['evidence'][0]['path'] = '/value/0'
            flows.append({'source': prefix + 'source', 'target': prefix + 'c2',
                          'evidence': [{'callId': prefix + 'source', 'field': 'response', 'path': '/value/1'},
                                       {'callId': prefix + 'c2', 'field': 'args', 'path': '/item'}]})
        return {'traceId': run, 'calls': calls, 'flow': flows}

    patterns = mine_input_patterns([analysis('one', 'a', True),
                                    analysis('two', 'b', False)], limit=20)
    pattern = next(item for item in patterns if item['consumerTool'] == 'use')
    assert pattern['supportCount'] == 2
    by_run = {witness['run']: witness for witness in pattern['witnesses']}
    assert by_run['one']['consumerCallIds'] == ['ac1', 'ac2']
    assert by_run['two']['consumerCallIds'] == ['bc1']
    assert not any(cid.startswith('a') for cid in by_run['two']['callIds'])


def test_repetition_over_union_capacity_retains_complete_individual_occurrences():
    analysis = {'traceId': 'wide-repeat',
        'calls': [{'id': 'source', 'tool': 'read', 'response': {'value': ['x', 'y', 'z']}}] + [
            {'id': f'c{i}', 'tool': 'use', 'args': {'item': value}}
            for i, value in enumerate(('x', 'y', 'z'))],
        'flow': [{'source': 'source', 'target': f'c{i}', 'evidence': [
            {'callId': 'source', 'field': 'response', 'path': f'/value/{i}'},
            {'callId': f'c{i}', 'field': 'args', 'path': '/item'}]}
            for i in range(3)]}
    patterns = mine_input_patterns([analysis], max_nodes=2, limit=20)
    assert len(patterns) == 1
    witnesses = patterns[0]['witnesses']
    assert {w['consumerCallId'] for w in witnesses} == {'c0', 'c1', 'c2'}
    assert all(len(w['consumerCallIds']) == 1 and len(w['callIds']) == 2 for w in witnesses)
    assert all('source' in w['callIds'] for w in witnesses)
    assert len(analysis['calls']) == 4 and len(analysis['flow']) == 3


def test_missing_source_pointer_does_not_count_as_exact_null_binding():
    analysis = {'traceId': 'missing-value', 'calls': [
        {'id': 's1', 'tool': 'read', 'response': {}},
        {'id': 's2', 'tool': 'read', 'response': {}},
        {'id': 'c1', 'tool': 'use', 'args': {'item': 'x', 'context': None}},
        {'id': 'c2', 'tool': 'use', 'args': {'item': 'y', 'context': None}}],
        'flow': [{'source': 's1', 'target': 'c1', 'evidence': [
            {'callId': 's1', 'field': 'response', 'path': '/missing'},
            {'callId': 'c1', 'field': 'args', 'path': '/item'}]},
            {'source': 's2', 'target': 'c2', 'evidence': [
            {'callId': 's2', 'field': 'response', 'path': '/missing'},
            {'callId': 'c2', 'field': 'args', 'path': '/item'}]}]}
    pattern, = [item for item in mine_input_patterns([analysis], limit=20)
                if item['consumerTool'] == 'use']
    assert len(pattern['witnesses']) == 2
    assert all(len(witness['consumerCallIds']) == 1 for witness in pattern['witnesses'])


def test_identical_receipts_in_different_agent_scopes_are_not_a_single_loop():
    a = {'traceId': 'multi', 'calls': [
        {'id': 's', 'tool': 'publish', 'args': {}, 'response': 'shared'},
        {'id': 'a', 'tool': 'receive', 'agentId': 'agent-a', 'args': {'message': 'shared'}},
        {'id': 'b', 'tool': 'receive', 'agentId': 'agent-b', 'args': {'message': 'shared'}}],
        'flow': [{'source': 's', 'target': cid} for cid in ['a', 'b']]}
    pattern, = mine_input_patterns([a])
    assert pattern['supportCount'] == 1
    assert len(pattern['witnesses']) == 2
    assert [w['consumerCallIds'] for w in pattern['witnesses']] == [['a'], ['b']]
