import sys
import importlib.util
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agent_provenance_backend'))
spec = importlib.util.spec_from_file_location('production_pattern_selection',
    Path(__file__).resolve().parents[1] / 'agent_provenance_backend/pattern_selection.py')
selection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selection)
select_pattern_examples = selection.select_pattern_examples
from skill_patterns import mine_input_patterns


def test_selector_keeps_a_complete_supporting_branch_and_does_not_stitch_runs():
    def source(run, prefix, second=False):
        calls = [{'id': prefix + 'a', 'tool': 'read_a'},
                 {'id': prefix + 'consumer', 'tool': 'act', 'args': {'ok': True}}]
        flow = [{'source': prefix + 'a', 'target': prefix + 'consumer'}]
        if second:
            calls.insert(1, {'id': prefix + 'b', 'tool': 'read_b'})
            flow.append({'source': prefix + 'b', 'target': prefix + 'consumer'})
        return {'traceId': run, 'calls': calls, 'flow': flow,
                'trainingOutcome': {'status': 'success' if second else 'unknown'}}

    analyses = [source('one', 'x'), source('two', 'y', True)]
    patterns = mine_input_patterns(analyses, limit=20)
    rendered_refs = []
    selected, refs = select_pattern_examples(patterns, analyses,
                                             lambda refs: rendered_refs.append(set(refs)) or len(refs),
                                             budget=10)
    assert len(selected) == 1
    assert {unit['witness']['run'] for unit in selected} == {'two'}
    assert ('two', 'yconsumer') in refs
    assert rendered_refs[-1] == refs
    for unit in selected:
        witness = unit['witness']
        assert all(link['source'][0] == link['target'][0] for link in witness['links'])


def test_same_pattern_keeps_witness_when_it_adds_observed_input_role():
    def source(run, prefix, source_tool):
        return {'traceId': run, 'calls': [
            {'id': prefix + 's', 'tool': source_tool},
            {'id': prefix + 'c', 'tool': 'use', 'args': {'ok': True}}],
            'flow': [{'source': prefix + 's', 'target': prefix + 'c'}]}

    analyses = [source('a', 'a', 'read'), source('b', 'b', 'read')]
    patterns = mine_input_patterns(analyses, limit=20)
    patterns[0]['witnesses'][1]['inputBindings'] = [{
        'targetCallId': 'bc', 'targetPath': '/item', 'parents': [{
            'sourceCallId': 'bs', 'inputRole': 'selection',
            'selectedEvidence': [{'path': '/query/condition'}]}]}]
    selected, _ = select_pattern_examples(patterns, analyses, lambda refs: len(refs), budget=10)
    # One complete witness can cover both the original and additional role.
    assert len(selected) == 1
    assert selected[0]['witness']['run'] == 'b'
    assert selected[0]['witness']['inputBindings'][0]['parents'][0]['inputRole'] == 'selection'


def test_successful_only_does_not_promote_unknown_outcomes():
    analyses = [{'traceId': 'u', 'calls': [{'id': 'r', 'tool': 'read'}, {'id': 'c', 'tool': 'act'}],
                 'flow': [{'source': 'r', 'target': 'c'}]},
                {'traceId': 's', 'calls': [{'id': 'r', 'tool': 'read'}, {'id': 'c', 'tool': 'act'}],
                 'flow': [{'source': 'r', 'target': 'c'}],
                 'trainingOutcome': {'status': 'success'}}]
    patterns = mine_input_patterns(analyses)
    selected, _ = select_pattern_examples(patterns, analyses, lambda refs: len(refs),
                                          successful_only=True)
    assert [unit['witness']['run'] for unit in selected] == ['s']


def test_renderer_budget_charges_shared_prerequisite_once():
    analysis = {'traceId': 'shared', 'calls': [
        {'id': 'source', 'tool': 'read'},
        {'id': 'a', 'tool': 'act_a', 'args': {'ok': True}},
        {'id': 'b', 'tool': 'act_b', 'args': {'ok': True}}],
        'flow': [{'source': 'source', 'target': 'a'}, {'source': 'source', 'target': 'b'}]}
    patterns = mine_input_patterns([analysis], limit=20)
    def render(cumulative):
        return sum({'source': 12, 'a': 5, 'b': 5}[call_id] for _, call_id in cumulative)

    # The shared prerequisite is charged once; budget 22 admits both witnesses.
    selected, refs = select_pattern_examples(patterns, [analysis], render, budget=22)
    assert len(selected) == 2
    assert refs == {('shared', 'source'), ('shared', 'a'), ('shared', 'b')}


def test_key_result_without_incoming_edges_remains_a_candidate_and_ranks_first():
    analysis = {'traceId': 'isolated', 'calls': [
                    {'id': 'read', 'tool': 'read_doc'}, {'id': 'doc', 'tool': 'summarize_doc'},
                    {'id': 'result', 'tool': 'report'}],
                'flow': [{'source': 'read', 'target': 'doc'}],
                'observedResults': [{'callId': 'result'}],
                'targetCallIds': ['result'],
                'evidenceReview': {'events': {'result': {'level': 'key'}}}}
    patterns = mine_input_patterns([analysis], limit=10)
    assert len(patterns) == 2
    selected, refs = select_pattern_examples(patterns, [analysis], lambda cumulative: len(cumulative), budget=1)
    assert len(selected) == 1
    assert refs == {('isolated', 'result')}
    assert selected[0]['features']['semanticLevel'] == 'key'
    assert selected[0]['features']['noKnownMissingInputs'] is None


def test_graph_semantic_and_result_support_rank_candidates_without_gating_them():
    def witness(run, call):
        return {'run': run, 'consumerCallId': call, 'callIds': [call],
            'consumerCallIds': [call], 'inputCoverage': [], 'links': [],
            'calls': [{'id': call, 'tool': 'report'}], 'inputBindings': []}

    patterns = [{'id': 'low', 'supportCount': 1, 'witnesses': [witness('low', 'l')]},
                {'id': 'high', 'supportCount': 1, 'witnesses': [witness('high', 'h')]}]
    analyses = [
        {'traceId': 'low', 'calls': [{'id': 'l', 'tool': 'report'}], 'graphImportance': [
            {'calls': ['l'], 'S': {'level': 'routine'},
             'R': {'status': 'none', 'supportedClaims': []}}]},
        {'traceId': 'high', 'calls': [{'id': 'h', 'tool': 'report'}], 'graphImportance': [
            {'calls': ['h'], 'S': {'level': 'key'},
             'R': {'status': 'supported', 'supportedClaims': ['claim-1']}}]},
    ]
    selected, _ = select_pattern_examples(patterns, analyses,
        lambda cumulative: len(cumulative), budget=1)
    assert len(selected) == 1
    assert selected[0]['witness']['run'] == 'high'
    assert selected[0]['features']['semanticImportance'] == 2
    assert selected[0]['features']['resultSupport'] == 1

    # Missing graph metadata leaves ordinary candidates eligible.
    selected, _ = select_pattern_examples([patterns[0]], analyses[:1],
        lambda cumulative: len(cumulative), budget=1)
    assert len(selected) == 1


def test_same_family_witness_with_complementary_role_is_kept_cumulatively():
    def source(run, prefix, role):
        return {'traceId': run, 'calls': [
            {'id': prefix + 's', 'tool': 'read'}, {'id': prefix + 'c', 'tool': 'use'}],
            'flow': [{'source': prefix + 's', 'target': prefix + 'c'}]}

    analyses = [source('one', 'a', 'record'), source('two', 'b', 'context')]
    patterns = mine_input_patterns(analyses, limit=20)
    assert len(patterns) == 1
    patterns[0]['witnesses'][0]['inputBindings'] = [{'targetCallId': 'ac', 'targetPath': '/record',
        'parents': [{'sourceCallId': 'as', 'inputRole': 'record', 'rule': 'record id selects result'}]}]
    patterns[0]['witnesses'][1]['initialContextUses'] = [{'targetCallId': 'bc',
        'targetPath': '/query', 'inputRole': 'context', 'rule': 'query controls selection'}]
    seen = []
    selected, refs = select_pattern_examples(patterns, analyses,
        lambda cumulative: seen.append(set(cumulative)) or len(cumulative), budget=10)
    assert len(selected) == 2
    assert refs == {('one', 'as'), ('one', 'ac'), ('two', 'bs'), ('two', 'bc')}
    assert seen[-1] == refs


def test_rule_paraphrase_and_record_row_index_novelty_do_not_expand_family_coverage():
    def witness(run, prefix, rule, row):
        source, consumer = prefix + 's', prefix + 'c'
        return {'run': run, 'consumerCallId': consumer, 'callIds': [source, consumer],
            'consumerCallIds': [consumer], 'inputCoverage': [], 'links': [],
            'calls': [{'id': source, 'tool': 'read'}, {'id': consumer, 'tool': 'use'}],
            'inputBindings': [{'targetCallId': consumer, 'targetPath': '/recipient', 'parents': [{
                'sourceCallId': source, 'inputRole': 'selection', 'rule': rule,
                'selectedEvidence': [{'callId': source, 'path': f'/results/{row}/email'}]}]}]}

    pattern = {'id': 'same-family', 'supportCount': 2, 'witnesses': [
        witness('one', 'a', 'Choose the matching recipient.', 0),
        witness('two', 'b', 'Select the corresponding email address.', 8)]}
    selected, refs = select_pattern_examples([pattern], [], lambda cumulative: len(cumulative), budget=10)
    assert len(selected) == 1
    assert len(refs) == 2


def test_matching_record_branch_with_a_changed_parent_role_is_retained():
    def witness(run, prefix, role):
        source, consumer = prefix + 's', prefix + 'c'
        return {'run': run, 'consumerCallId': consumer, 'callIds': [source, consumer],
            'consumerCallIds': [consumer], 'inputCoverage': [], 'links': [],
            'calls': [{'id': source, 'tool': 'read_record'}, {'id': consumer, 'tool': 'use_record'}],
            'inputBindings': [{'targetCallId': consumer, 'targetPath': '/recipient', 'parents': [{
                'sourceCallId': source, 'inputRole': role,
                'selectedEvidence': [{'callId': source, 'path': '/records/0/email'}]}]}]}

    pattern = {'id': 'matching-record', 'supportCount': 2,
               'witnesses': [witness('recorded', 'a', 'recorded_reference'),
                             witness('selected', 'b', 'selection')]}
    selected, refs = select_pattern_examples([pattern], [], lambda cumulative: len(cumulative), budget=10)
    assert {unit['witness']['run'] for unit in selected} == {'recorded', 'selected'}
    assert refs == {('recorded', 'as'), ('recorded', 'ac'), ('selected', 'bs'), ('selected', 'bc')}


def test_shorter_complete_witness_leaves_room_for_a_second_pattern():
    def source(run, tool, size):
        return {'traceId': run, 'calls': [
            {'id': 'r', 'tool': 'read', 'response': 'x' * size},
            {'id': 'c', 'tool': tool}], 'flow': [{'source': 'r', 'target': 'c'}],
            'trainingOutcome': {'status': 'success'}}

    analyses = [source('a-long', 'use_a', 500), source('b-short', 'use_a', 1),
                source('c-other', 'use_b', 1)]
    patterns = mine_input_patterns(analyses, limit=20)
    cost = lambda refs: sum(3 if ref == ('a-long', 'r') else 1 for ref in refs)
    selected, refs = select_pattern_examples(patterns, analyses, cost, budget=5)
    assert {unit['witness']['run'] for unit in selected} == {'b-short', 'c-other'}
    assert len(refs) == 4


def test_reviewed_multi_input_is_retained_even_when_a_flow_edge_is_missing():
    analysis = {'traceId': 'one', 'calls': [
        {'id': 'a', 'tool': 'read_a'}, {'id': 'b', 'tool': 'read_b'},
        {'id': 'c', 'tool': 'combine'}], 'flow': [{'source': 'a', 'target': 'c'}],
        'inputBindings': [{'targetCallId': 'c', 'targetPath': '/value', 'parents': [
            {'sourceCallId': 'a', 'inputRole': 'selection'},
            {'sourceCallId': 'b', 'inputRole': 'exclusion'}]}]}
    selected, refs = select_pattern_examples(mine_input_patterns([analysis]), [analysis],
        lambda refs: len(refs), budget=3)
    assert refs == {('one', 'a'), ('one', 'b'), ('one', 'c')}
    assert selected[0]['example']['callIds'] == ['a', 'b', 'c']
    assert analysis['flow'] == [{'source': 'a', 'target': 'c'}]


def test_successful_run_does_not_turn_its_failed_consumer_into_a_positive_example():
    def source(run, status):
        return {'traceId': run, 'calls': [{'id': 'r', 'tool': 'read'},
            {'id': 'c', 'tool': 'use', 'status': status}],
            'flow': [{'source': 'r', 'target': 'c'}], 'trainingOutcome': {'status': 'success'}}
    analyses = [source('a-error', 'error'), source('b-valid', 'success')]
    selected, _ = select_pattern_examples(mine_input_patterns(analyses), analyses,
        lambda refs: len(refs), budget=2)
    assert selected[0]['witness']['run'] == 'b-valid'


def test_separate_partial_runs_do_not_replace_a_joint_multi_input_witness():
    def source(run, inputs):
        return {'traceId': run, 'calls': [*[
            {'id': tool, 'tool': tool} for tool in inputs], {'id': 'e', 'tool': 'use'}],
            'flow': [{'source': tool, 'target': 'e'} for tool in inputs],
            'trainingOutcome': {'status': 'success'}}
    analyses = [source('a-single', ['read_a']), source('b-single', ['read_b']),
                source('c-joint', ['read_a', 'read_b'])]
    selected, refs = select_pattern_examples(mine_input_patterns(analyses), analyses,
        lambda refs: len(refs), budget=7)
    assert any(unit['witness']['run'] == 'c-joint' for unit in selected)
    assert {('c-joint', 'read_a'), ('c-joint', 'read_b'), ('c-joint', 'e')} <= refs


def test_identical_graph_shapes_preserve_success_and_failure_contrast():
    analyses = [{'traceId': outcome, 'calls': [{'id': 's', 'tool': 'read'},
        {'id': 'c', 'tool': 'apply'}], 'flow': [{'source': 's', 'target': 'c'}],
        'trainingOutcome': {'status': outcome}} for outcome in ('success', 'failure')]
    selected, refs = select_pattern_examples(mine_input_patterns(analyses), analyses,
        lambda refs: len(refs), budget=4)
    assert {unit['witness']['sourceOutcome'] for unit in selected} == {'success', 'failure'}
    assert len(refs) == 4


def test_zero_sro_weights_isolates_graph_ranking_without_removing_candidates():
    analyses=[]
    patterns=[]
    for run,level in [('first','routine'),('second','key')]:
        analyses.append({'traceId':run,'calls':[{'id':'c','tool':'report'}],
            'graphImportance':[{'calls':['c'],'S':{'level':level},
                'R':{'status':'none','supportedClaims':[]}}]})
        patterns.append({'id':run,'supportCount':1,'witnesses':[{
            'run':run,'consumerCallId':'c','consumerCallIds':['c'],'callIds':['c'],
            'calls':[{'id':'c','tool':'report'}],'links':[],'inputBindings':[]}]})
    weighted,_=select_pattern_examples(patterns,analyses,lambda refs:len(refs),budget=1)
    uniform,_=select_pattern_examples(patterns,analyses,lambda refs:len(refs),budget=1,
        sro_weights=(0,0,0))
    assert weighted[0]['witness']['run']=='second'
    assert uniform[0]['witness']['run']=='first'
    remaining,refs=select_pattern_examples(patterns[1:],analyses[1:],lambda refs:len(refs),budget=1,
        sro_weights=(0,0,0))
    assert remaining[0]['witness']['run']=='second'
    assert refs=={('second','c')}


def test_complete_result_argument_precedes_cheaper_high_scoring_fragments():
    analysis = {'traceId': 'joint', 'trainingOutcome': {'status': 'success'},
        'calls': [{'id': 'rule', 'tool': 'read_policy', 'response': 'x' * 500},
                  {'id': 'rows', 'tool': 'read_records', 'response': 'y' * 500},
                  {'id': 'result', 'tool': 'deliver', 'args': {'content': 'selected'}},
                  {'id': 'noise', 'tool': 'inspect'}],
        'flow': [{'source': 'rule', 'target': 'result'},
                 {'source': 'rows', 'target': 'result'}],
        'targetCallIds': ['result'],
        'inputBindings': [{'targetCallId': 'result', 'targetPath': '/content', 'parents': [
            {'sourceCallId': 'rule', 'inputRole': 'selection'},
            {'sourceCallId': 'rows', 'inputRole': 'derivation'}]}],
        'evidenceReview': {'events': {'noise': {'level': 'key'}}}}
    patterns = mine_input_patterns([analysis], limit=20)
    units, refs = select_pattern_examples(patterns, [analysis], lambda refs: len(refs), budget=3)
    assert refs == {('joint', cid) for cid in ('rule', 'rows', 'result')}
    assert units[0]['features']['jointArgument']
    # A cap below the complete pattern never produces a partial example of it.
    units, refs = select_pattern_examples(patterns, [analysis], lambda refs: len(refs), budget=2)
    assert not any(('joint', 'result') in unit['refs'] for unit in units)


def test_argument_sources_close_transitively_even_outside_the_bounded_flow_cone():
    analysis = {'traceId': 'closure', 'calls': [
        {'id': cid, 'tool': cid} for cid in ('rule', 'index', 'rows', 'result')],
        'flow': [{'source': 'rule', 'target': 'result'}],
        'targetCallIds': ['result'], 'inputBindings': [
            {'targetCallId': 'result', 'targetPath': '/value', 'parents': [
                {'sourceCallId': 'rule', 'inputRole': 'selection'},
                {'sourceCallId': 'rows', 'inputRole': 'derivation'}]},
            {'targetCallId': 'rows', 'targetPath': '/id', 'parents': [
                {'sourceCallId': 'index', 'inputRole': 'recorded_reference'}]}]}
    patterns = mine_input_patterns([analysis], limit=20)
    units, refs = select_pattern_examples(patterns, [analysis], lambda refs: len(refs), budget=4)
    assert refs == {('closure', cid) for cid in ('rule', 'index', 'rows', 'result')}
    assert len(units[0]['witness']['inputBindings']) == 2
    assert analysis['flow'] == [{'source': 'rule', 'target': 'result'}]


def test_enabling_parent_does_not_turn_one_argument_source_into_a_joint_derivation():
    witness = {'consumerCallIds': ['consume'], 'inputBindings': [
        {'targetCallId': 'consume', 'targetPath': '/value', 'parents': [
            {'sourceCallId': 'data', 'inputRole': 'value'},
            {'sourceCallId': 'login', 'inputRole': 'enabling'}]}]}
    assert not selection._joint_argument(witness)


def test_result_recipe_does_not_fill_spare_capacity_with_failed_partial_histories():
    def source(run, outcome):
        return {'traceId': run, 'trainingOutcome': {'status': outcome},
            'calls': [{'id': cid, 'tool': cid} for cid in ('policy', 'rows', 'result', 'extra')],
            'flow': [{'source': 'policy', 'target': 'result'}, {'source': 'rows', 'target': 'result'}],
            'targetCallIds': ['result', 'extra'], 'inputBindings': [
                {'targetCallId': 'result', 'targetPath': '/value', 'parents': [
                    {'sourceCallId': 'policy', 'inputRole': 'selection'},
                    {'sourceCallId': 'rows', 'inputRole': 'derivation'}]}]}
    analyses = [source('failed', 'failure'), source('valid', 'success')]
    patterns = mine_input_patterns(analyses, limit=30)
    units, refs = select_pattern_examples(patterns, analyses, lambda refs: len(refs), budget=20)
    assert refs == {('valid', cid) for cid in ('policy', 'rows', 'result', 'extra')}
    assert {unit['witness']['sourceOutcome'] for unit in units} == {'success'}
    # The failed history remains available for graph inspection and diagnosis.
    assert any(w['sourceOutcome'] == 'failure' for p in patterns for w in p['witnesses'])
    # Insufficient capacity is explicit, even though small prefixes would fit.
    assert select_pattern_examples(patterns, analyses, lambda refs: len(refs), budget=2) == ([], set())
    # Graph-only ranking keeps the same original pool, including failure contrast.
    units, refs = select_pattern_examples(patterns, analyses, lambda refs: len(refs), budget=20,
                                         sro_weights=(0, 0, 0))
    assert {'success', 'failure'} == {unit['witness']['sourceOutcome'] for unit in units}
