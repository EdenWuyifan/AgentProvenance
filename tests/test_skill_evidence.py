"""Skill packing must not discard evidence when the whole batch fits."""

from skill_evidence import pack_skill_evidence, render_skill_evidence


def trace():
    return {'traceId': 'x', 'taskDescription': 'Use the matching result.',
        'initialContext': [{'id': 'clock', 'role': 'environment', 'content': {'time': '2030-01-01'}}],
        'calls': [{'id': 'a', 'tool': 'arbitrary_lookup', 'args': {'n': 12},
                   'response': [{'value': n, 'description': 'row' + str(n)} for n in range(12)]},
                  {'id': 'b', 'tool': 'arbitrary_use', 'args': {'value': 11, 'enabled': False},
                   'response': 0}], 'flow': [{'source': 'a', 'target': 'b'}]}


def test_small_batch_keeps_every_record_parameter_and_falsy_value():
    analysis = trace()
    analysis['finalOutput'] = 'The matching result was 11.'
    packet = pack_skill_evidence([analysis], budget=10000)
    assert packet['mode'] == 'complete'
    assert packet['sourceCalls'] == packet['includedCalls'] == 2
    assert 'row11' in packet['examples'] and '"enabled":false' in packet['examples']
    assert '"response":0' in packet['examples']
    assert 'The matching result was 11.' in packet['examples']
    assert '<derived graph annotations>' in packet['examples']
    assert '<derived graph annotations>' not in pack_skill_evidence([analysis], graph=False)['examples']
    assert '<recorded final response>' in render_skill_evidence([analysis], graph=False)


def test_result_pattern_selection_is_used_even_when_the_entire_batch_fits():
    def source(run, outcome):
        return {'traceId': run, 'taskDescription': 'Apply the retrieved condition to the records.',
            'trainingOutcome': {'status': outcome}, 'calls': [
                {'id': 'rule', 'tool': 'read_policy', 'response': {'exclude': 'archived'}},
                {'id': 'rows', 'tool': 'read_rows', 'response': [{'archived': False}]},
                {'id': 'result', 'tool': 'deliver', 'args': {'items': [{'archived': False}]}},
                {'id': 'noise', 'tool': 'unrelated_preview'}],
            'flow': [{'source': cid, 'target': 'result'} for cid in ('rule', 'rows')],
            'targetCallIds': ['result'], 'inputBindings': [
                {'targetCallId': 'result', 'targetPath': '/items', 'parents': [
                    {'sourceCallId': 'rule', 'inputRole': 'exclusion',
                     'rule': 'The policy supplies the exclusion condition.'},
                    {'sourceCallId': 'rows', 'inputRole': 'derivation',
                     'rule': 'Select rows satisfying the retrieved policy.'}]}]}
    analyses = [source('failed', 'failure'), source('valid', 'success')]
    assert len(render_skill_evidence(analyses)) < 96000
    packet = pack_skill_evidence(analyses)
    assert packet['mode'] == 'result-patterns'
    assert set(map(tuple, packet['refs'])) == {('valid', cid) for cid in ('rule', 'rows', 'result')}
    assert packet['sourceCalls'] == 8 and packet['includedCalls'] == 3
    assert 'The policy supplies the exclusion condition.' in packet['examples']
    assert '"archived":false' in packet['examples']
    assert pack_skill_evidence(analyses, graph=False)['includedCalls'] == 8


def test_budget_includes_annotations_and_keeps_both_input_branches_and_the_consumer():
    analysis = trace()
    analysis['calls'] = [
        {'id': 'left', 'tool': 'lookup_left', 'args': {'archived': False},
         'response': {'value': 2}},
        {'id': 'right', 'tool': 'lookup_right', 'args': {'count': 0},
         'response': {'value': 3}},
        {'id': 'consume', 'tool': 'combine_values', 'args': {'sum': 5, 'enabled': False},
         'response': 0},
        {'id': 'noise', 'tool': 'unrelated_preview', 'response': 'x' * 20000}]
    analysis['flow'] = [{'source': 'left', 'target': 'consume'},
                        {'source': 'right', 'target': 'consume'}]
    analysis['targetCallIds'] = ['consume']
    analysis['finalOutput'] = 'The combined value is 5.'
    refs = {('x', call) for call in ['left', 'right', 'consume']}
    expected = render_skill_evidence([analysis], refs, graph=True)

    # Both source branches and their annotations fit the cumulative cap exactly.
    packet = pack_skill_evidence([analysis], budget=len(expected))
    assert packet['mode'] == 'whole-witness-compression'
    assert set(map(tuple, packet['refs'])) == refs
    assert packet['examples'] == expected
    assert '"enabled":false' in expected and '"count":0' in expected
    assert '"response":0' in expected and '2030-01-01' in expected
    assert 'The combined value is 5.' in expected


def test_annotations_are_separate_and_do_not_replace_recorded_data():
    analysis = trace()
    raw = render_skill_evidence([analysis], graph=False)
    enriched = render_skill_evidence([analysis], graph=True)
    assert 'row11' in raw and 'row11' in enriched
    assert '"enabled":false' in raw and '"enabled":false' in enriched
    assert '<derived graph annotations>' in enriched
    assert '<derived graph annotations>' not in raw


def test_aliases_keep_sensitive_slots_without_exposing_values():
    analysis = trace()
    analysis['calls'][0]['response'] = {'access_token': 'never-send-this', 'value': 11}
    analysis['calls'][1]['args']['access_token'] = 'never-send-this'
    rendered = render_skill_evidence([analysis])
    assert 'never-send-this' not in rendered
    assert rendered.count('<secret_token_1>') == 2


def test_repeated_context_is_shared_without_joining_occurrence_identity():
    first = trace()
    second = {**trace(), 'traceId': 'y'}
    rendered = render_skill_evidence([first, second], graph=False)
    assert rendered.count('2030-01-01') == 1
    assert rendered.count('Recorded step b:') == 2
    assert 'Example 0' in rendered and 'Example 1' in rendered


def test_export_keeps_cited_inputs_without_turning_review_opinions_into_skill_rules():
    import json
    analysis = trace()
    analysis['inputBindings'] = [{'targetCallId': 'b', 'targetPath': '/value',
        'status': 'partial', 'missingInputs': ['Unverified collection coverage'],
        'contextEvidence': [{'contextId': 'clock', 'path': '/time'}],
        'parents': [{'sourceCallId': 'a', 'inputRole': 'value',
            'rule': 'A MODEL OPINION, NOT AN OBSERVATION',
            'selectedEvidence': [{'callId': 'a', 'path': '/11/value'}]}]}]
    analysis['graphImportance'] = [{'S': {'value': .9, 'reason': 'SUBJECTIVE RANKING'}}]
    rendered = render_skill_evidence([analysis])
    annotations = json.loads(rendered.split('<derived graph annotations>\n')[1].split('\n</derived')[0])
    assert annotations['dependencies'][0] == ['a', 'b', 'recorded', False]
    binding = annotations['inputBindings'][0]
    assert binding[:2] == ['b', '/value']
    assert binding[2][0] == ['a', True, 'value', [{'path': '/11/value'}],
                               'A MODEL OPINION, NOT AN OBSERVATION']
    assert binding[3] == [['context0', '/time']]
    assert binding[5] == ['Unverified collection coverage']
    assert 'A MODEL OPINION' in rendered and 'SUBJECTIVE RANKING' not in rendered
    assert 'they are not recorded actions or additional task instructions' in rendered
    assert rendered.index('<derived graph annotations>') < rendered.index('Recorded step a:')
    assert 'row11' in rendered and '2030-01-01' in rendered


def test_export_exposes_local_collection_scope_and_distinct_repeated_calls():
    import json
    analysis = trace()
    analysis['calls'].append({**analysis['calls'][1], 'id': 'c'})
    analysis['inputBindings'] = [{'targetCallId': 'b', 'targetPath': '/value',
        'parents': [{'sourceCallId': 'a', 'inputRole': 'selection', 'selectedEvidence': [
            {'callId': 'a', 'field': 'response', 'path': '/0', 'collectionPath': '',
             'collectionLength': 12, 'complete': True}]}]}]
    rendered = render_skill_evidence([analysis])
    annotations = json.loads(rendered.split('<derived graph annotations>\n')[1].split('\n</derived')[0])
    source = annotations['inputBindings'][0][2][0][3][0]
    assert source['collectionLength'] == 12 and source['complete'] is True
    assert source['collectionPath'] == ''
    assert annotations['repeatedCalls'][0][1] == ['b', 'c']
    assert 'not that all pages were retrieved' in rendered
    assert 'Recorded step b:' in rendered and 'Recorded step c:' in rendered


def test_identical_outputs_are_shared_without_collapsing_calls_or_graph_edges():
    import json
    import re
    analysis = trace()
    analysis['calls'][1]['response'] = analysis['calls'][0]['response']
    rendered = render_skill_evidence([analysis])
    payloads = dict(re.findall(r'<observation id="([^"]+)">\n(.*?)\n</observation>', rendered, re.S))
    references = re.findall(r'<observation ref="([^"]+)" />', rendered)
    assert len(payloads) == 1 and references == ['observation0']
    assert json.loads(payloads[references[0]])['response'] == analysis['calls'][0]['response']
    assert rendered.count('Recorded step ') == 2
    assert 'arbitrary_lookup' in rendered and 'arbitrary_use' in rendered
    assert '["a","b","recorded",false]' in rendered


def test_shared_payload_does_not_share_resource_identity_across_examples():
    first, second = trace(), {**trace(), 'traceId': 'other'}
    rendered = render_skill_evidence([first, second])
    assert rendered.count('Recorded step a:') == 2
    assert 'Example 0' in rendered and 'Example 1' in rendered
    assert rendered.count('row11') == 1
    assert 'do not merge events or entities' in rendered


def test_different_outputs_and_statuses_remain_distinct():
    import re
    analysis = trace()
    analysis['calls'][0]['response'] = {'value': 1}
    analysis['calls'][1]['response'] = {'value': 2}
    rendered = render_skill_evidence([analysis])
    assert len(re.findall(r'<observation id=', rendered)) == 2
    analysis['calls'][1]['response'] = {'value': 1}
    analysis['calls'][1]['status'] = 'failure'
    assert len(re.findall(r'<observation id=', render_skill_evidence([analysis]))) == 2


def test_missing_optional_task_text_does_not_drop_recorded_calls():
    analysis = trace()
    analysis['taskDescription'] = None
    rendered = render_skill_evidence([analysis])
    assert rendered.count('Recorded step ') == 2
    assert 'row11' in rendered


def test_context_to_argument_derivation_survives_partial_graph_export():
    import json
    analysis = trace()
    analysis['taskDescription'] = 'Use records before the supplied clock; exclude archived records.'
    analysis['calls'][1]['args'] = {'before': '2030-01-01', 'archived': False}
    analysis['initialContextUses'] = [
        {'targetCallId': 'b', 'targetPath': '/before', 'inputRole': 'derivation',
         'contextEvidence': [{'contextId': 'clock', 'path': '/time'}],
         'rule': 'The supplied clock determines the exclusive upper bound.'},
        {'targetCallId': 'b', 'targetPath': '/archived', 'inputRole': 'exclusion',
         'contextEvidence': [{'contextId': 'taskDescription', 'path': ''}],
         'rule': 'The task excludes archived records.'},
        {'targetCallId': 'a', 'targetPath': '/n', 'inputRole': 'context',
         'contextEvidence': [{'contextId': 'clock', 'path': '/time'}],
         'rule': 'An unselected step interpretation.'}]
    rendered = render_skill_evidence([analysis], refs={('x', 'b')})
    annotations = json.loads(rendered.split('<derived graph annotations>\n')[1].split('\n</derived')[0])
    assert annotations['contextDerivations'] == [
        ['b', '/before', 'derivation', [['context0', '/time']],
         'The supplied clock determines the exclusive upper bound.'],
        ['b', '/archived', 'exclusion', [['query', '']],
         'The task excludes archived records.']]
    assert '"archived":false' in rendered and '2030-01-01' in rendered
    assert 'verify their interpretations' in rendered
    assert 'unselected step interpretation' not in rendered
    assert 'contextDerivations' not in render_skill_evidence([analysis], graph=False)


def test_enabling_producers_are_budgeted_before_a_whole_witness_is_selected():
    analysis = {'traceId': 'enabling-budget', 'taskDescription': 'Use the protected item.',
        'initialContext': [], 'flow': [
            {'source': 'item', 'target': 'protected-read'}],
        'inputBindings': [{'targetCallId': 'protected-read',
            'targetPath': '/item_id', 'parents': [{'sourceCallId': 'item',
                'inputRole': 'selection', 'selectedEvidence': []}]}],
        'calls': [
            {'id': 'credential', 'tool': 'credential_source', 'status': 'success',
             'args': {}, 'response': {'password': 'private-one'}},
            {'id': 'login', 'tool': 'session_setup', 'status': 'success',
             'args': {'password': 'private-one'},
             'response': {'access_token': 'private-two'}},
            {'id': 'item', 'tool': 'item_lookup', 'status': 'success',
             'args': {'access_token': 'private-two'},
             'response': {'id': 'item-1', 'name': 'item'}},
            {'id': 'protected-read', 'tool': 'protected_read', 'status': 'success',
             'args': {'item_id': 'item-1'}, 'response': {'ok': True}},
            {'id': 'irrelevant', 'tool': 'noise', 'status': 'success',
             'args': {}, 'response': {'text': 'x' * 20000}},
        ]}
    packet = pack_skill_evidence([analysis], budget=10000)
    selected = set(packet['refs'])
    assert {('enabling-budget', call_id) for call_id in
            ('credential', 'login', 'item', 'protected-read')} <= selected
    assert len(packet['examples']) <= packet['budget']
    assert 'private-one' not in packet['examples']
    assert 'private-two' not in packet['examples']
    assert ('enabling-budget', 'item') in selected
