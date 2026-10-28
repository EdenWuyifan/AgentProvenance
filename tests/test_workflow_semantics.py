import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / 'agent_provenance_backend'))

import workflow_semantics as ws
from models import ModelResponseError


def make_analysis():
    calls = [
        {'id': 'trace-private:rx', 'eventType': 'information_reception', 'tool': 'receive', 'agentId': 'a1',
         'round': 0, 'args': {'payload': 'peer observed condition Q', 'sourceExperimentId': 'trace-private:old'},
         'response': 'condition Q was useful'},
        {'id': 'trace-private:work', 'eventType': 'experiment', 'tool': 'run trial', 'agentId': 'a1',
         'round': 1, 'args': {'physical_conditions': {'temperature': 40, 'solvent': 'water'},
                              'rationale': 'test the shared condition'},
         'response': {'y_raw': 0.83, 'source_mode': 'offline_dataset_replay'}},
        {'id': 'trace-private:publish', 'eventType': 'information_publication', 'tool': 'publish', 'agentId': 'a1',
         'round': 1, 'args': {'communicatedPayload': {'theta': [1, 2], 'insight': 'condition Q'}},
         'response': 'shared condition Q'},
        {'id': 'trace-private:routine', 'eventType': 'tool_execution', 'tool': 'prepare', 'agentId': 'a2',
         'round': 0, 'args': {'url': 'https://private.example/data?token=secret'}, 'response': 'workspace ready'},
    ]
    return {'traceId': 'trace-private', 'taskDescription': 'Find condition Q.',
            'score': 918273645, 'scoreMetric': 'private grade', 'finalOutput': 'Final score: 93.5; condition Q worked.',
            'calls': calls, 'resultAnchors': [calls[1]['id']], 'workflow': {'eventLinks': [
                {'source': calls[0]['id'], 'target': calls[1]['id'], 'relation': 'used_shared_evidence'},
                {'source': calls[2]['id'], 'target': calls[1]['id'], 'relation': 'used_local_evidence'},
                {'source': calls[1]['id'], 'target': calls[2]['id'], 'relation': 'publishes'},
            ], 'outcomes': [{'eventId': calls[1]['id'], 'kind': 'final', 'scope': 'system', 'terminal': True,
                             'value': 0.83, 'name': 'final'}]}}


@pytest.fixture
def cache(monkeypatch, tmp_path):
    monkeypatch.setattr(ws, 'CACHE_DIR', tmp_path)


def answer(prompt, *, key_events=(), decision='stop'):
    payload = json.loads(prompt.rsplit('\n', 1)[-1])
    assessments = []
    for event in payload['events']:
        is_key = event['ref'] in key_events
        response_refs = [ref for ref in event['evidence'] if payload['evidence'][ref]['field'] == 'response']
        assessments.append({'event': event['ref'], 'level': 'key' if is_key else 'supporting',
                            'label': 'Measured result' if is_key else 'Recorded activity',
                            'reason': 'This output records the selected result.' if is_key else 'Provides task context.',
                            'evidence': response_refs[:1] or event['evidence'][:1] if is_key else []})
    event_cards = {event['ref']: event for event in payload['events']}
    links = [{'link': item['ref'], 'relevance': 'relevant', 'reason': 'Explicit recorded evidence use.',
              'evidence': event_cards[item['source']]['evidence'][:1] + event_cards[item['target']]['evidence'][:1]}
             for item in payload['links'] if item['relation'].startswith('used_')]
    return {'defaultLevel': 'unknown', 'backtrace': {'decision': decision, 'reason': 'Mocked test decision.'},
            'assessments': assessments, 'keyParents': [], 'searchQueries': [],
            'linkAssessments': links, 'jointGroups': []}


def test_result_seed_and_explicit_parents_are_assessed_with_citations(cache, monkeypatch):
    prompts = []

    async def infer(prompt, **_kwargs):
        prompts.append(prompt)
        payload = json.loads(prompt.rsplit('\n', 1)[-1])
        return answer(prompt, key_events={event['ref'] for event in payload['events']
                                           if event['type'] == 'experiment'},
                      decision='continue' if len(prompts) == 1 else 'stop')

    monkeypatch.setattr(ws, 'infer_json', infer)
    analysis = make_analysis()
    result = asyncio.run(ws.assess_workflow([analysis], focus='find a useful result'))
    run = result['runs'][0]
    assert set(run['events']) == {call['id'] for call in analysis['calls']}
    assert run['events']['trace-private:work']['level'] == 'key'
    assert run['events']['trace-private:work']['evidence'][0]['field'] == 'response'
    assert run['events']['trace-private:routine']['status'] == 'not_assessed'
    assert run['events']['trace-private:routine']['level'] == 'unknown'
    assert len(run['links']) == 3  # recorded relation data is never removed
    assert sum(not e['status'] == 'not_assessed' for e in run['events'].values()) >= 3
    prompt = prompts[0]
    for private in ('trace-private', '918273645', 'private grade', '93.5', 'https://private.example',
                    'token', 'sourceExperimentId'):
        assert private not in prompt
    assert 'condition Q' in prompt
    assert result['retrievalMetrics']['requestCount'] == 1
    assert run['retrievalMetrics']['stopReason'] == 'no_new_evidence'


def test_long_workflow_reviews_independent_outcomes_and_trajectory():
    source = make_analysis()
    source['calls'] = [{'id': f'activity-{i}', 'tool': 'arbitrary operation', 'eventType': 'generic',
                        'agentId': f'actor-{i % 4}', 'round': i, 'args': {}, 'response': {'value': i}}
                       for i in range(80)]
    source['resultAnchors'] = []
    source['workflow'] = {'eventLinks': [], 'outcomes': [
        {'eventId': 'activity-0', 'name': 'First milestone', 'metric': 'quality', 'value': 10, 'scope': 'system'},
        {'eventId': 'activity-40', 'name': 'Middle milestone', 'metric': 'quality', 'value': 50, 'scope': 'system'},
        *[{'eventId': f'activity-{i}', 'name': 'Local result', 'metric': 'quality', 'value': i,
           'scope': 'participant'} for i in (76, 77, 78, 79)],
        {'eventId': 'activity-79', 'name': 'Final result', 'metric': 'quality', 'value': 79,
         'scope': 'system', 'kind': 'final', 'terminal': True}]}
    prepared = ws._prepare_uncached(source)
    assert {'activity-0', 'activity-40', 'activity-76', 'activity-77', 'activity-78', 'activity-79'} <= set(prepared['seeds'])
    assert prepared['seeds'][0] == 'activity-79'


def test_retrieval_uses_selected_rationale_and_balances_direct_input_relations():
    source = make_analysis()
    source['calls'][0]['response'] = 'Peer discovered alkoxide activation.'
    source['calls'][1]['args'] = {'rationale': 'Test peer alkoxide activation.',
                                'candidates': [{'rationale': 'Rejected phosphate idea.'} for _ in range(20)]}
    source['calls'][2]['response'] = 'Rejected phosphate idea.'
    source['calls'][3]['response'] = 'Earlier local alkoxide experiment.'
    target = source['calls'][1]['id']
    source['workflow']['eventLinks'] = [
        {'source': source['calls'][2]['id'], 'target': target, 'relation': 'shared_context'},
        {'source': source['calls'][0]['id'], 'target': target, 'relation': 'shared_context'},
        {'source': source['calls'][3]['id'], 'target': target, 'relation': 'local_context'}]
    prepared = ws._prepare_uncached(source)
    ranked = ws._rank_inputs(prepared, [target], [call['id'] for call in source['calls'] if call['id'] != target])
    assert ranked[:2] == [source['calls'][0]['id'], source['calls'][3]['id']]


def test_source_output_plaintext_and_actual_paths_are_in_prompt(cache, monkeypatch):
    prompts = []

    async def infer(prompt, **_kwargs):
        prompts.append(prompt)
        return answer(prompt, decision='stop')

    monkeypatch.setattr(ws, 'infer_json', infer)
    asyncio.run(ws.assess_workflow([make_analysis()]))
    payload = json.loads(prompts[0].rsplit('\n', 1)[-1])
    assert any('condition Q was useful' in item['quote'] and item['path'] == ''
               for item in payload['evidence'].values())
    assert any(item['path'] == '/physical_conditions' and 'temperature' in item['quote'] and 'MeCN' not in item['quote']
               for item in payload['evidence'].values())
    assert all(not path.startswith('/parameters') for item in payload['evidence'].values()
               for path in [item['path']])


def test_current_inputs_and_rationale_survive_query_matches_in_historical_context():
    source = make_analysis()
    source['calls'][1]['args']['promptEvidence'] = {
        'priorObservation': 'maximum final yield maximum final yield under a previous condition'}
    prepared = ws._prepare_uncached(source)
    card = ws._event_card(prepared, source['calls'][1]['id'], 'maximum final yield')
    paths = {prepared['evidence'][ref]['path'] for ref in card['evidence']}
    assert {'/physical_conditions', '/rationale', '/promptEvidence', ''} <= paths


def test_retrieval_document_keeps_current_output_when_history_floods_inputs():
    source = make_analysis()
    source['calls'][1]['args'] = {
        'history': [{'insight': 'Obsolete condition. ' * 30} for _ in range(40)],
        'rationale': 'Measure the new catalyst condition.',
        'conditions': {'pressure': 7},
    }
    prepared = ws._prepare_uncached(source)
    document = prepared['documents'][1]['quote']
    assert 'Measure the new catalyst condition.' in document
    assert 'y_raw' in document and '0.83' in document
    assert len(document) <= 2400
    assert prepared['retriever'].search('y_raw 0.83', allowed_call_ids={source['calls'][1]['id']})


def test_bounded_review_receives_whole_literal_input_path(cache, monkeypatch):
    def call(cid, response, round_=0, **args):
        return {'id': cid, 'tool': 'arbitrary operation', 'agentId': 'actor', 'round': round_,
                'args': args, 'response': response}
    source = {'traceId': 'private', 'calls': [
        call('origin', 'Measured quasarcondition at pressure 4.'),
        call('send', 'Published quasarcondition.'), call('receive', 'Received quasarcondition.'),
        *[call(f'decoy{i}', 'Unrelated history.') for i in range(12)],
        call('target', 'Improved result.', 1, rationale='Test received quasarcondition.')],
        'resultAnchors': ['target'], 'workflow': {'roundLabel': 'Round', 'eventLinks': [
            {'source': 'origin', 'target': 'send', 'relation': 'publishes'},
            {'source': 'send', 'target': 'receive', 'relation': 'delivered_to'},
            *[{'source': cid, 'target': 'target', 'relation': 'recorded_input'}
              for cid in ['receive', *[f'decoy{i}' for i in range(12)]]]]}}
    monkeypatch.setattr(ws, 'MAX_EVENTS', 6)
    monkeypatch.setattr(ws, 'MAX_ROUNDS', 1)
    prompts = []

    async def infer(prompt, **_kwargs):
        prompts.append(prompt)
        return answer(prompt)

    monkeypatch.setattr(ws, 'infer_json', infer)
    asyncio.run(ws.assess_workflow([source]))
    payload = json.loads(prompts[0].rsplit('\n', 1)[-1])
    refs = {event['ref'] for event in payload['events']}
    assert {'e0', 'e1', 'e2'} <= refs
    assert len(refs) <= 6
    assert {'publishes', 'delivered_to', 'recorded_input'} <= {link['relation'] for link in payload['links']}
    assert any('Measured quasarcondition' in row['quote'] for row in payload['evidence'].values())


def test_exact_context_cache_and_focus_variation(cache, monkeypatch):
    prompts = []

    async def infer(prompt, **_kwargs):
        prompts.append(prompt)
        return answer(prompt, decision='continue' if len(prompts) % 2 == 1 else 'stop')

    monkeypatch.setattr(ws, 'infer_json', infer)
    source = make_analysis()
    first = asyncio.run(ws.assess_workflow([source], focus='result A'))
    second = asyncio.run(ws.assess_workflow([source], focus='result A'))
    assert second['cached'] is True
    assert first['runs'][0]['events'] == second['runs'][0]['events']
    asyncio.run(ws.assess_workflow([source], focus='result B'))
    assert len(prompts) == 2


def test_model_requested_retrieval_excludes_future_events(cache, monkeypatch):
    source = make_analysis()
    source['workflow']['eventLinks'] = []
    source['resultAnchors'] = [source['calls'][2]['id']]
    source['calls'][0]['args']['payload'] = 'rare keyword useful experimental condition'
    source['calls'][3]['args'] = {'payload': 'rare keyword future must not be retrieved'}
    seen_allowlists = []
    original = ws.BM25Retriever.search

    def track(self, query, limit=5, allowed_call_ids=None):
        seen_allowlists.append(set(allowed_call_ids or []))
        return original(self, query, limit, allowed_call_ids)

    monkeypatch.setattr(ws.BM25Retriever, 'search', track)
    prompts = []

    async def infer(prompt, **_kwargs):
        prompts.append(prompt)
        response = answer(prompt, decision='continue' if len(prompts) == 1 else 'stop')
        payload = json.loads(prompt.rsplit('\n', 1)[-1])
        response['searchQueries'] = [{'target': payload['targetEvents'][0], 'query': 'rare keyword'}]
        return response

    monkeypatch.setattr(ws, 'infer_json', infer)
    asyncio.run(ws.assess_workflow([source], focus='rare keyword'))
    payloads = [json.loads(prompt.rsplit('\n', 1)[-1]) for prompt in prompts]
    assert seen_allowlists
    assert any(payload['retrievedContexts'] for payload in payloads)
    future_index = 3
    assert all(source['calls'][future_index]['id'] not in allow for allow in seen_allowlists)
    assert any(source['calls'][0]['id'] in allow for allow in seen_allowlists)


def test_missing_input_query_stays_with_its_consumer_not_every_result(cache, monkeypatch):
    calls = [{'id': cid, 'tool': 'generic tool', 'args': {}, 'response': response}
             for cid, response in [('source', 'quasarcondition discovered'),
                                   ('consumer-a', 'first result'), ('consumer-b', 'independent result')]]
    source = {'traceId': 'local', 'calls': calls, 'resultAnchors': ['consumer-a', 'consumer-b']}
    payloads = []

    async def infer(prompt, **_kwargs):
        payloads.append(json.loads(prompt.rsplit('\n', 1)[-1]))
        raw = answer(prompt, decision='continue' if len(payloads) == 1 else 'stop')
        if len(payloads) == 1:
            raw['searchQueries'] = [{'target': 'e1', 'query': 'quasarcondition'}]
        return raw

    monkeypatch.setattr(ws, 'infer_json', infer)
    result = asyncio.run(ws.assess_workflow([source]))
    assert len(payloads) == 2
    assert payloads[1]['retrievedContexts'] == [{'source': 'e0', 'target': 'e1'}]
    assert result['runs'][0]['retrievalMetrics']['contextQueries'] == 1


@pytest.mark.parametrize('citation_kind', ['source_only', 'consumer_only', 'unrelated', 'unavailable', 'not_array', 'too_many'])
def test_relevant_link_quarantines_bad_evidence_without_rejecting_the_graph(citation_kind):
    source = make_analysis()
    prepared = ws._prepare_uncached(source)
    ids = [call['id'] for call in source['calls']]
    rows = ws._context_links(prepared, [ids[1]], ids)
    payload = ws._prompt_payload(prepared, '', [ids[1]], ids, rows)
    source_ref = next(event for event in payload['events'] if event['ref'] == 'e0')['evidence'][0]
    consumer_ref = next(event for event in payload['events'] if event['ref'] == 'e1')['evidence'][0]
    unrelated_ref = next(event for event in payload['events'] if event['ref'] == 'e3')['evidence'][0]
    citations = {'source_only': [source_ref], 'consumer_only': [consumer_ref],
                 'unrelated': [unrelated_ref], 'unavailable': ['s-does-not-exist'],
                 'not_array': source_ref, 'too_many': [source_ref, consumer_ref] * 5}[citation_kind]
    raw = {'defaultLevel': 'unknown', 'backtrace': {'decision': 'stop', 'reason': 'Reviewed supplied inputs.'},
        'assessments': [], 'linkAssessments': [
        {'link': 'l0', 'relevance': 'relevant', 'reason': 'Same topic.', 'evidence': citations}]}
    normalized = ws._normalize_response(raw, prepared, payload, ids, rows)
    assert normalized[1]['l0']['relevance'] == 'unknown'
    assert normalized[1]['l0']['validation'] == 'rejected'
    assert normalized[1]['l0']['evidence'] == []
    assert normalized[6][0]['kind'] == 'link_evidence'


def test_joint_context_requires_relevant_inputs_and_every_endpoint_cited():
    calls = [{'id': cid, 'tool': 'arbitrary operation', 'args': {}, 'response': text}
             for cid, text in [('a', 'alpha observation'), ('b', 'beta observation'), ('c', 'combined result')]]
    source = {'calls': calls, 'workflow': {'eventLinks': [
        {'source': cid, 'target': 'c', 'relation': 'artifact_reference'} for cid in ('a', 'b')]}}
    prepared = ws._prepare_uncached(source)
    ids = ['a', 'b', 'c']
    rows = ws._context_links(prepared, ['c'], ids)
    payload = ws._prompt_payload(prepared, '', ['c'], ids, rows)
    refs = {e['ref']: e['evidence'][0] for e in payload['events']}
    raw = {'defaultLevel': 'unknown', 'backtrace': {'decision': 'stop', 'reason': 'Reviewed inputs.'},
        'assessments': [], 'linkAssessments': [
        {'link': row['ref'], 'relevance': 'relevant', 'reason': 'Combined recorded inputs.',
         'evidence': [refs[row['source']], refs[row['target']]]} for row in payload['links']],
        'jointGroups': [{'target': 'e2', 'sources': ['e0', 'e1'], 'label': 'Joint context',
                         'reason': 'Combined recorded inputs.', 'evidence': [refs['e0'], refs['e2']]}]}
    normalized = ws._normalize_response(raw, prepared, payload, ids, rows)
    assert normalized[4] == []
    assert normalized[6][0]['kind'] == 'joint_evidence'
    raw['jointGroups'][0]['evidence'] = list(refs.values())
    assert len(ws._normalize_response(raw, prepared, payload, ids, rows)[4]) == 1
    raw['linkAssessments'][0]['relevance'] = 'context'
    normalized = ws._normalize_response(raw, prepared, payload, ids, rows)
    assert normalized[4] == []
    assert normalized[6][0]['kind'] == 'joint_evidence'


def test_shared_excerpt_decodes_with_both_occurrence_owners():
    source = {'calls': [{'id': cid, 'tool': 'observe', 'args': {'note': 'same text'}, 'response': 'same output'}
                        for cid in ('a', 'b')]}
    prepared = ws._prepare_uncached(source)
    ref = prepared['byCall']['a'][0]
    citations = ws._endpoint_citations(prepared, [ref], ['a', 'b'])
    assert {row['callId'] for row in citations} == {'a', 'b'}


def test_link_accepts_a_provided_endpoint_excerpt_outside_its_short_card():
    source = {'calls': [
        {'id': 'a', 'tool': 'observe', 'args': {f'field{i}': {'detail': f'observation-{i}'} for i in range(8)},
         'response': 'output'},
        {'id': 'b', 'tool': 'consume', 'args': {'input': 'observation-7'}, 'response': 'result'}],
        'flow': [{'source': 'a', 'target': 'b', 'relation': 'recorded'}]}
    prepared = ws._prepare_uncached(source)
    rows = ws._context_links(prepared, ['b'], ['a', 'b'])
    payload = ws._prompt_payload(prepared, '', ['b'], ['a', 'b'], rows)
    extra = next(ref for ref in prepared['byCall']['a'] if ref not in payload['events'][0]['evidence'])
    payload['evidence'][extra] = {key: prepared['evidence'][extra][key] for key in ('field', 'path', 'quote')}
    target_ref = payload['events'][1]['evidence'][0]
    raw = {'defaultLevel': 'unknown', 'backtrace': {'decision': 'stop', 'reason': 'Inputs explained.'},
           'assessments': [], 'linkAssessments': [
               {'link': rows[0]['ref'], 'relevance': 'relevant', 'reason': 'Input used.',
                'evidence': [extra, target_ref]}]}
    normalized = ws._normalize_response(raw, prepared, payload, ['a', 'b'], rows)
    assert normalized[1][rows[0]['ref']]['relevance'] == 'relevant'
    assert normalized[6] == []


def test_rejected_link_keeps_valid_judgments_and_is_cached_without_retry(cache, monkeypatch):
    requests = []

    async def infer(prompt, **_kwargs):
        requests.append(prompt)
        raw = answer(prompt, key_events={'e1'})
        payload = json.loads(prompt.rsplit('\n', 1)[-1])
        target = next(event for event in payload['events'] if event['ref'] == 'e1')
        raw['linkAssessments'][0]['evidence'] = target['evidence'][:1]
        return raw

    monkeypatch.setattr(ws, 'infer_json', infer)
    first = asyncio.run(ws.assess_workflow([make_analysis()]))
    second = asyncio.run(ws.assess_workflow([make_analysis()]))
    assert len(requests) == 1
    assert second['cached']
    assert second['retrievalMetrics']['requestCount'] == 0
    assert first['runs'][0]['events']['trace-private:work']['level'] == 'key'
    assert len(first['runs'][0]['links']) == 3
    rejected = next(link for link in first['runs'][0]['links'] if link.get('validation') == 'rejected')
    assert rejected['relevance'] == 'unknown'
    assert first['retrievalMetrics']['rejectedAssessments'] == 1
    assert list((ws.CACHE_DIR / 'workflow-assessments/validation-issues').glob('*.json'))


def test_machine_event_references_are_presented_as_actor_and_step():
    prepared = ws._prepare_uncached(make_analysis())
    assert ws._human_text(prepared, 'e0 informs e1.') == 'a1, Step 1 informs a1, Step 2.'


def test_task_and_result_terms_do_not_trigger_generic_retrieval(cache, monkeypatch):
    source = make_analysis()
    calls = []
    original = ws.BM25Retriever.search

    def track(self, query, limit=5, allowed_call_ids=None):
        calls.append(allowed_call_ids)
        return original(self, query, limit, allowed_call_ids)

    monkeypatch.setattr(ws.BM25Retriever, 'search', track)

    async def infer(prompt, **_kwargs):
        return answer(prompt)

    monkeypatch.setattr(ws, 'infer_json', infer)
    asyncio.run(ws.assess_workflow([source], focus='rare task words'))
    # Ranking explicit inputs may use retrieval; arbitrary task/result terms may
    # not trigger an unconstrained corpus search without an LLM search query.
    assert all(allow is not None for allow in calls)
    assert all(source['calls'][3]['id'] not in allow for allow in calls)


def test_round_label_uses_rounds_not_adapter_order_for_inferred_context():
    source = make_analysis()
    source['workflow']['roundLabel'] = 'Round'
    prepared = ws._prepare_uncached(source)
    # Same-round events are not ordered by their adapter row positions.
    assert ws._strictly_earlier(prepared, source['calls'][1]['id'], source['calls'][2]['id']) is False
    assert ws._strictly_earlier(prepared, source['calls'][0]['id'], source['calls'][1]['id'])

    source['calls'][0]['round'] = 1
    source['calls'][1]['round'] = 1
    prepared = ws._prepare_uncached(source)
    source_id, target_id = source['calls'][0]['id'], source['calls'][1]['id']
    payload = ws._prompt_payload(prepared, '', [source_id, target_id], [source_id, target_id], [],
                                 [(source_id, target_id)])
    refs = [payload['events'][0]['evidence'][0], payload['events'][1]['evidence'][0]]
    raw = {'defaultLevel': 'unknown', 'assessments': [
        {'event': event['ref'], 'level': 'supporting', 'label': '', 'reason': '', 'evidence': []}
        for event in payload['events']],
        'semanticContexts': [{'source': prepared['idToRef'][source_id],
                              'target': prepared['idToRef'][target_id], 'relevance': 'context',
                              'reason': 'related', 'evidence': refs}]}
    with pytest.raises(ModelResponseError, match='earlier candidate pair'):
        ws._normalize_response(raw, prepared, payload, [source_id, target_id], [])


def test_milestone_fallback_uses_latest_system_outcome_only():
    source = make_analysis()
    source['workflow']['outcomes'] = [
        {'eventId': source['calls'][0]['id'], 'kind': 'best', 'scope': 'system', 'name': 'milestone'},
        {'eventId': source['calls'][2]['id'], 'kind': 'best', 'scope': 'participant', 'name': 'agent best'},
        {'eventId': source['calls'][1]['id'], 'kind': 'final', 'terminal': True,
         'scope': 'system', 'name': 'last recorded'},
    ]
    prepared = ws._prepare_uncached(source)
    assert prepared['seeds'] == [source['calls'][1]['id']]
    assert prepared['finalContext'][0]['name'] == 'last recorded'


def test_key_parent_is_expanded_backwards_across_multiple_rounds(cache, monkeypatch):
    monkeypatch.setattr(ws, 'MAX_ROUNDS', 3)
    calls = [
        {'id': 'chain:early', 'tool': 'early source', 'agentId': 'a', 'round': 0,
         'args': {'note': 'distinctive earlier observation'}, 'response': 'observation recorded'},
        {'id': 'chain:mid', 'tool': 'middle decision', 'agentId': 'b', 'round': 1,
         'args': {'rationale': 'used earlier observation'}, 'response': 'decision made'},
        {'id': 'chain:final', 'tool': 'final evaluation', 'agentId': 'a', 'round': 2,
         'args': {'method': 'evaluate decision'}, 'response': 'terminal output'},
    ]
    analysis = {'traceId': 'chain', 'taskDescription': 'trace the final outcome', 'calls': calls,
                'resultAnchors': [calls[2]['id']], 'workflow': {'roundLabel': 'Round', 'eventLinks': [
                    {'source': calls[0]['id'], 'target': calls[1]['id'], 'relation': 'used_shared_evidence'},
                    {'source': calls[1]['id'], 'target': calls[2]['id'], 'relation': 'used_local_evidence'}]}}
    target_rounds = []

    async def infer(prompt, **_kwargs):
        payload = json.loads(prompt.rsplit('\n', 1)[-1])
        target_rounds.append(payload['targetEvents'])
        raw = answer(prompt, decision='continue' if len(target_rounds) < 3 else 'stop')
        target_refs = set(payload['targetEvents'])
        raw['keyParents'] = [link['source'] for link in payload['links']
                             if link['target'] in target_refs and link['relation'].startswith('used_')]
        for assessment in raw['assessments']:
            if assessment['event'] in raw['keyParents']:
                assessment['level'] = 'key'
                event = next(event for event in payload['events'] if event['ref'] == assessment['event'])
                assessment['evidence'] = event['evidence'][:1]
        return raw

    monkeypatch.setattr(ws, 'infer_json', infer)
    result = asyncio.run(ws.assess_workflow([analysis]))['runs'][0]
    assert target_rounds == [['e2'], ['e1']]
    assert result['retrievalMetrics']['avoidedRepeatRounds'] == 1
    assert all(result['events'][call['id']]['status'] == 'assessed' for call in calls)


def test_model_stop_leaves_unreviewed_predecessors_unknown(cache, monkeypatch):
    source = make_analysis()
    source['calls'] = [
        {'id': 'stop:origin', 'tool': 'early source', 'args': {'note': 'distant source'}, 'response': 'origin'},
        {'id': 'stop:middle', 'tool': 'middle operation', 'args': {'note': 'intermediate'}, 'response': 'middle'},
        {'id': 'stop:result', 'tool': 'final operation', 'args': {'note': 'result'}, 'response': 'final'},
    ]
    source['resultAnchors'] = ['stop:result']
    source['workflow'] = {'eventLinks': [
        {'source': 'stop:origin', 'target': 'stop:middle', 'relation': 'recorded_input'},
        {'source': 'stop:middle', 'target': 'stop:result', 'relation': 'recorded_input'},
    ]}
    prompts = []
    monkeypatch.setattr(ws, 'MAX_EVENTS', 2)

    async def infer(prompt, **_kwargs):
        prompts.append(prompt)
        return answer(prompt, decision='stop')

    monkeypatch.setattr(ws, 'infer_json', infer)
    result = asyncio.run(ws.assess_workflow([source]))['runs'][0]

    assert len(prompts) == 1
    assert result['retrievalMetrics']['stopReason'] == 'model_stopped'
    assert result['events']['stop:result']['status'] == 'assessed'
    assert result['events']['stop:origin']['level'] == 'unknown'
    assert result['events']['stop:origin']['status'] == 'not_assessed'
    assert len(result['links']) == len(source['workflow']['eventLinks'])


def test_plain_single_actor_flow_can_continue_twice_then_stop(cache, monkeypatch):
    calls = [
        {'id': 'plain:source', 'tool': 'observe', 'agentId': 'one-agent',
         'args': {'note': 'earlier measured condition'}, 'response': 'condition recorded'},
        {'id': 'plain:decision', 'tool': 'choose', 'agentId': 'one-agent',
         'args': {'rationale': 'use earlier condition'}, 'response': 'decision recorded'},
        {'id': 'plain:result', 'tool': 'evaluate', 'agentId': 'one-agent',
         'args': {'method': 'evaluate decision'}, 'response': 'final result'},
    ]
    analysis = {'traceId': 'plain-run', 'calls': calls, 'targetCallIds': ['plain:result'],
                'flow': [
                    {'source': 'plain:source', 'target': 'plain:decision', 'relation': 'input_record'},
                    {'source': 'plain:decision', 'target': 'plain:result', 'relation': 'result_input'},
                ]}
    requests, targets = [], []
    monkeypatch.setattr(ws, 'MAX_EVENTS', 2)

    async def infer(prompt, **_kwargs):
        requests.append(prompt)
        payload = json.loads(prompt.rsplit('\n', 1)[-1])
        targets.append(payload['targetEvents'])
        raw = answer(prompt, decision='continue' if len(requests) == 1 else 'stop')
        if len(requests) == 1:
            parent = next(event for event in payload['events'] if event['ref'] == 'e1')
            result = next(event for event in payload['events'] if event['ref'] == 'e2')
            raw['assessments'] = [
                {'event': 'e1', 'level': 'key', 'label': 'Selected condition',
                 'reason': 'The recorded rationale uses this condition.', 'evidence': parent['evidence'][:1]},
                {'event': 'e2', 'level': 'supporting', 'label': 'Final evaluation',
                 'reason': 'Records the final result.', 'evidence': result['evidence'][:1]},
            ]
            raw['keyParents'] = ['e1']
            row = next(link for link in payload['links'] if link['source'] == 'e1' and link['target'] == 'e2')
            raw['linkAssessments'] = [{'link': row['ref'], 'relevance': 'relevant',
                                       'reason': 'The evaluation names the selected condition.',
                                       'evidence': next(event for event in payload['events'] if event['ref'] == 'e1')['evidence'][:1]
                                       + result['evidence'][:1]}]
        else:
            event = next(event for event in payload['events'] if event['ref'] == 'e1')
            raw['assessments'] = [{'event': 'e1', 'level': 'key', 'label': 'Selected condition',
                                   'reason': 'The condition is the recorded input.',
                                   'evidence': event['evidence'][:1]}]
        return raw

    monkeypatch.setattr(ws, 'infer_json', infer)
    run = asyncio.run(ws.assess_workflow([analysis]))['runs'][0]

    assert targets == [['e2'], ['e1']]
    assert run['retrievalMetrics']['requestCount'] == 2
    assert run['retrievalMetrics']['stopReason'] == 'model_stopped'
    assert run['events']['plain:decision']['level'] == 'key'
    assert run['events']['plain:decision']['evidence']
    assert run['events']['plain:source']['level'] == 'unknown'
    assert run['events']['plain:source']['status'] == 'assessed'
    assert len(run['links']) == 2


@pytest.mark.parametrize('control', [None, {'decision': 'continue', 'reason': ''},
                                     {'decision': 'later', 'reason': 'bad decision'}])
def test_invalid_backtrace_control_is_rejected_without_caching(cache, monkeypatch, tmp_path, control):
    call = {'id': 'control:result', 'tool': 'evaluate', 'args': {'result': 'done'}, 'response': 'done'}
    analysis = {'traceId': 'control', 'calls': [call], 'targetCallIds': [call['id']]}

    async def infer(prompt, **_kwargs):
        raw = answer(prompt)
        if control is None:
            raw.pop('backtrace')
        else:
            raw['backtrace'] = control
        return raw

    monkeypatch.setattr(ws, 'infer_json', infer)
    with pytest.raises(ModelResponseError, match='Backtracing requires an explicit'):
        asyncio.run(ws.assess_workflow([analysis]))
    assert not list((tmp_path / 'workflow-assessments').glob('*.json'))


def test_assessment_stops_after_one_call_without_model_expansion(cache, monkeypatch):
    call = {'id': 'single:event', 'tool': 'final output', 'args': {'result': 'complete'},
            'response': 'done'}
    analysis = {'traceId': 'single', 'calls': [call], 'resultAnchors': [call['id']]}
    prompts = []

    async def infer(prompt, **_kwargs):
        prompts.append(prompt)
        response = answer(prompt, decision='stop')
        response['searchQueries'] = [{'target': 'e0', 'query': query} for query in
                                    ['shared_warmup', 'system_best_yield', 'offline_dataset_replay']]
        return response

    monkeypatch.setattr(ws, 'infer_json', infer)
    result = asyncio.run(ws.assess_workflow([analysis]))
    assert len(prompts) == 1
    assert result['retrievalMetrics']['requestCount'] == 1
    assert result['runs'][0]['retrievalMetrics']['stopReason'] == 'model_stopped'
    assert result['runs'][0]['retrievalMetrics']['coverage'] == {'assessed': 1, 'total': 1}


def test_relevant_supporting_input_is_followed_to_its_recorded_input(cache, monkeypatch):
    monkeypatch.setattr(ws, 'MAX_ROUNDS', 3)
    calls = [
        {'id': 'chain:early', 'tool': 'early source', 'args': {'note': 'earlier observation'},
         'response': 'observation recorded'},
        {'id': 'chain:mid', 'tool': 'middle decision', 'args': {'rationale': 'used earlier observation'},
         'response': 'decision made'},
        {'id': 'chain:final', 'tool': 'final evaluation', 'args': {'method': 'evaluate decision'},
         'response': 'terminal output'},
    ]
    analysis = {'traceId': 'supporting-chain', 'taskDescription': 'trace the final outcome', 'calls': calls,
                'resultAnchors': [calls[2]['id']], 'workflow': {'eventLinks': [
                    {'source': calls[0]['id'], 'target': calls[1]['id'], 'relation': 'used_shared_evidence'},
                    {'source': calls[1]['id'], 'target': calls[2]['id'], 'relation': 'used_local_evidence'}]}}
    requests = []
    payloads = []

    async def infer(prompt, **_kwargs):
        requests.append(prompt)
        payloads.append(json.loads(prompt.rsplit('\n', 1)[-1]))
        return answer(prompt, decision='continue' if len(requests) < 3 else 'stop')

    monkeypatch.setattr(ws, 'infer_json', infer)
    run = asyncio.run(ws.assess_workflow([analysis]))['runs'][0]
    assert len(requests) == 2
    assert all(run['events'][call['id']]['level'] == 'supporting' for call in calls)
    assert run['retrievalMetrics']['coverage'] == {'assessed': 3, 'total': 3}
    assert run['retrievalMetrics']['stopReason'] == 'no_new_evidence'
    assert payloads[1]['retrievedContexts'] == []


def test_high_fan_in_stays_within_three_bounded_requests(cache, monkeypatch):
    target = {'id': 'fan:result', 'tool': 'evaluate', 'args': {'result': 'complete'}, 'response': 'done'}
    parents = [{'id': f'fan:input:{index}', 'tool': 'recorded input',
                'args': {'observation': f'observation {index}'}, 'response': 'input recorded'}
               for index in range(120)]
    analysis = {'traceId': 'fan', 'calls': [*parents, target], 'resultAnchors': [target['id']],
                'workflow': {'eventLinks': [{'source': parent['id'], 'target': target['id'],
                                             'relation': 'used_shared_evidence'} for parent in parents]}}
    prompts = []

    async def infer(prompt, **_kwargs):
        prompts.append(prompt)
        return answer(prompt, decision='continue')

    monkeypatch.setattr(ws, 'infer_json', infer)
    result = asyncio.run(ws.assess_workflow([analysis]))['runs'][0]
    payloads = [json.loads(prompt.rsplit('\n', 1)[-1]) for prompt in prompts]
    assert len(prompts) == ws.MAX_ROUNDS
    assert all(len(payload['events']) <= ws.MAX_EVENTS for payload in payloads)
    assert all(len(prompt) <= ws.MAX_PROMPT_CHARS for prompt in prompts)
    assert result['retrievalMetrics']['stopReason'] == 'round_limit'
    assert result['retrievalMetrics']['remainingFrontier'] > 0
    assert result['retrievalMetrics']['rounds'] == ws.MAX_ROUNDS
    assert result['retrievalMetrics']['assessedEvents'] + result['retrievalMetrics']['unassessedEvents'] == len(parents) + 1
    assert set(result['events']) == {call['id'] for call in [*parents, target]}


def test_oversized_target_batch_is_split_across_bounded_rounds(cache, monkeypatch):
    monkeypatch.setattr(ws, 'MAX_ROUNDS', 3)
    parents = [{'id': f'large:input:{index}', 'tool': 'recorded input',
                'args': {'a': f'parent-{index}-' + 'x' * 380}, 'response': f'parent-result-{index}-' + 'y' * 380}
               for index in range(24)]
    targets = [{'id': f'large:result:{index}', 'tool': 'final output',
                'args': {'a': f'target-{index}-' + 'x' * 380}, 'response': f'target-result-{index}-' + 'y' * 380}
               for index in range(24)]
    analysis = {'traceId': 'large-batch', 'calls': [*parents, *targets],
                'resultAnchors': [target['id'] for target in targets],
                'workflow': {'eventLinks': [{'source': parents[index]['id'], 'target': targets[index]['id'],
                                             'relation': 'used_shared_evidence'} for index in range(24)]}}
    prepared = ws._prepare_uncached(analysis)
    target_ids = [target['id'] for target in targets]
    event_ids = [call['id'] for call in [*targets, *parents]]
    links = ws._context_links(prepared, target_ids, event_ids)
    cards = {cid: ws._event_card(prepared, cid, '') for cid in event_ids}
    oversized = ws._prompt_payload(prepared, '', target_ids, event_ids, links, (), cards)
    assert len(ws.PROMPT) + len(json.dumps(oversized, ensure_ascii=False, separators=(',', ':'))) > ws.MAX_PROMPT_CHARS
    prompts = []

    async def infer(prompt, **_kwargs):
        prompts.append(prompt)
        return answer(prompt, decision='continue')

    monkeypatch.setattr(ws, 'infer_json', infer)
    result = asyncio.run(ws.assess_workflow([analysis]))['runs'][0]
    payloads = [json.loads(prompt.rsplit('\n', 1)[-1]) for prompt in prompts]
    assert len(prompts) > 1
    assert len(prompts) <= ws.MAX_ROUNDS
    assert all(len(payload['events']) <= ws.MAX_EVENTS for payload in payloads)
    assert all(len(prompt) <= ws.MAX_PROMPT_CHARS for prompt in prompts)
    assert result['retrievalMetrics']['stopReason'] != 'prompt_budget'
    assert result['retrievalMetrics']['assessedEvents'] >= len(targets)


def test_missing_and_unknown_link_judgments_are_reported(cache, monkeypatch):
    calls = [
        {'id': 'link:unknown', 'tool': 'first input', 'args': {'note': 'one'}, 'response': 'recorded'},
        {'id': 'link:missing', 'tool': 'second input', 'args': {'note': 'two'}, 'response': 'recorded'},
        {'id': 'link:result', 'tool': 'final output', 'args': {'result': 'complete'}, 'response': 'done'},
    ]
    analysis = {'traceId': 'link-review', 'calls': calls, 'resultAnchors': [calls[2]['id']],
                'workflow': {'eventLinks': [
                    {'source': calls[0]['id'], 'target': calls[2]['id'], 'relation': 'used_shared_evidence'},
                    {'source': calls[1]['id'], 'target': calls[2]['id'], 'relation': 'used_local_evidence'}]}}

    async def infer(prompt, **_kwargs):
        raw = answer(prompt, decision='continue')
        payload = json.loads(prompt.rsplit('\n', 1)[-1])
        raw['linkAssessments'] = [{'link': payload['links'][0]['ref'], 'relevance': 'unknown',
                                   'reason': 'Insufficient evidence.'}]
        return raw

    monkeypatch.setattr(ws, 'infer_json', infer)
    metrics = asyncio.run(ws.assess_workflow([analysis]))['runs'][0]['retrievalMetrics']
    assert metrics['unknownLinks'] == 1
    assert metrics['unassessedLinks'] == 1
    assert metrics['stopReason'] == 'link_judgments_incomplete'


def test_missing_default_is_saved_as_invalid_and_fake_citation_raises(cache, monkeypatch, tmp_path):
    async def incomplete(prompt, **_kwargs):
        return {'assessments': [], 'keyParents': [], 'searchQueries': [], 'jointGroups': []}

    monkeypatch.setattr(ws, 'infer_json', incomplete)
    with pytest.raises(ModelResponseError, match='defaultLevel unknown and sparse assessments'):
        asyncio.run(ws.assess_workflow([make_analysis()]))
    invalid = list((tmp_path / 'workflow-assessments' / 'invalid-responses').glob('*.json'))
    assert len(invalid) == 1
    stored = json.loads(invalid[0].read_text())
    assert all(ref.startswith('e') for ref in stored['eventRefs'])

    async def sparse_unknown(prompt, **_kwargs):
        return {'defaultLevel': 'unknown', 'backtrace': {'decision': 'stop', 'reason': 'No further evidence.'},
                'assessments': [], 'keyParents': [], 'searchQueries': [],
                'jointGroups': []}

    monkeypatch.setattr(ws, 'infer_json', sparse_unknown)
    single = make_analysis()
    single['calls'] = [single['calls'][1]]
    single['workflow']['eventLinks'] = []
    single['resultAnchors'] = [single['calls'][0]['id']]
    result = asyncio.run(ws.assess_workflow([single]))['runs'][0]['events'][single['calls'][0]['id']]
    assert result['level'] == 'unknown' and result['status'] == 'assessed'
    assert result['reason'] == 'The model did not establish this activity’s importance.'

    async def fake_citation(prompt, **_kwargs):
        payload = json.loads(prompt.rsplit('\n', 1)[-1])
        raw = answer(prompt, key_events={event['ref'] for event in payload['events']
                                          if event['type'] == 'experiment'})
        for item in raw['assessments']:
            if item['level'] == 'key':
                item['evidence'] = ['not-supplied']
        return raw

    monkeypatch.setattr(ws, 'infer_json', fake_citation)
    with pytest.raises(ModelResponseError, match='unavailable evidence'):
        asyncio.run(ws.assess_workflow([make_analysis()]))


def test_any_explicit_link_can_select_a_key_parent_but_parent_must_be_key():
    source = make_analysis()
    prepared = ws._prepare_uncached(source)
    parent, target = source['calls'][1]['id'], source['calls'][2]['id']
    link_rows = ws._context_links(prepared, [target], [parent, target])
    assert any(row['relation'] == 'publishes' for row in link_rows)
    payload = ws._prompt_payload(prepared, '', [target], [parent, target], link_rows)
    parent_ref, target_ref = prepared['idToRef'][parent], prepared['idToRef'][target]
    parent_quote = next(iter(payload['events'][0]['evidence']))
    raw = {'defaultLevel': 'unknown', 'backtrace': {'decision': 'stop', 'reason': 'Reviewed supplied inputs.'},
        'assessments': [
        {'event': parent_ref, 'level': 'key', 'label': 'Produced finding', 'reason': 'Recorded input.',
         'evidence': [parent_quote]},
        {'event': target_ref, 'level': 'supporting', 'label': 'Work', 'reason': 'Context.', 'evidence': []}],
        'keyParents': [parent_ref]}
    normalized = ws._normalize_response(raw, prepared, payload, [parent, target], link_rows)
    assert normalized[2] == [parent]

    raw['assessments'][0]['level'] = 'supporting'
    raw['assessments'][0]['evidence'] = []
    normalized = ws._normalize_response(raw, prepared, payload, [parent, target], link_rows)
    assert normalized[2] == []
    assert normalized[6][0]['kind'] == 'key_parent'


def test_direct_final_anchor_without_context_keeps_other_events_unknown(cache, monkeypatch):
    source = make_analysis()
    source['workflow']['eventLinks'] = []
    source['workflow']['outcomes'] = []
    source.pop('resultAnchors')

    async def infer(prompt, **_kwargs):
        return answer(prompt, decision='stop')

    monkeypatch.setattr(ws, 'infer_json', infer)
    result = asyncio.run(ws.assess_workflow([source]))['runs'][0]
    assert all(item['level'] == 'unknown' and item['status'] == 'not_assessed'
               for item in result['events'].values())


def test_sparse_later_round_does_not_erase_an_earlier_explicit_judgment(cache, monkeypatch):
    source = make_analysis()
    source['workflow']['roundLabel'] = 'Round'
    source['workflow']['eventLinks'] = [source['workflow']['eventLinks'][0]]
    responses = []

    async def infer(prompt, **_kwargs):
        payload = json.loads(prompt.rsplit('\n', 1)[-1])
        responses.append(payload)
        if len(responses) > 1:
            return {'defaultLevel': 'unknown', 'backtrace': {'decision': 'stop', 'reason': 'No further evidence.'},
                    'assessments': [], 'keyParents': [], 'searchQueries': []}
        parent = next(event for event in payload['events'] if event['ref'] == 'e0')
        return {'defaultLevel': 'unknown', 'backtrace': {'decision': 'continue', 'reason': 'Inspect the recorded input.'},
                'assessments': [
            {'event': 'e0', 'level': 'key', 'label': 'Useful shared condition',
             'reason': 'This recorded input informs the result.', 'evidence': parent['evidence'][:1]}],
            'keyParents': ['e0'], 'searchQueries': []}

    monkeypatch.setattr(ws, 'infer_json', infer)
    result = asyncio.run(ws.assess_workflow([source]))['runs'][0]
    assert len(responses) == 1
    assert result['events']['trace-private:rx']['level'] == 'key'
    assert result['events']['trace-private:rx']['evidence']


def test_outcome_context_is_compact_while_reviewed_event_keeps_full_evidence():
    source = make_analysis()
    source['calls'][1]['args'].update(protocol={'steps': 4},
        historical_context=[{'insight': 'Earlier protocol used a distinct catalyst.'}])
    prepared = ws._prepare_uncached(source)
    outcome_id = source['calls'][1]['id']
    other_id = source['calls'][0]['id']
    full = ws._event_card(prepared, outcome_id, '')
    assert len(full['evidence']) >= 4

    payload = ws._prompt_payload(prepared, '', [other_id], [other_id], [])
    context, = payload['finalOutcomeContext']
    assert len(context['evidence']) == 2
    assert [payload['evidence'][ref]['field'] for ref in context['evidence']] == ['response', 'args']
    assert all(payload['evidence'][ref]['path'].count('/') <= 1 for ref in context['evidence'])
    assert len(payload['evidence']) < len(set(full['evidence'] + payload['events'][0]['evidence']))

    reviewed = ws._prompt_payload(prepared, '', [outcome_id], [outcome_id], [])
    assert set(reviewed['events'][0]['evidence']) == set(full['evidence'])
    assert set(full['evidence']) <= set(reviewed['evidence'])


def test_cited_key_input_is_expanded_when_model_omits_keyparents(cache, monkeypatch):
    source = make_analysis()
    source['workflow']['roundLabel'] = 'Round'
    source['workflow']['eventLinks'] = [source['workflow']['eventLinks'][0]]
    prompts = []

    async def infer(prompt, **_kwargs):
        prompts.append(prompt)
        payload = json.loads(prompt.rsplit('\n', 1)[-1])
        raw = answer(prompt, key_events={'e0'}, decision='continue' if len(prompts) == 1 else 'stop')
        raw['keyParents'] = []
        raw['linkAssessments'] = []
        return raw

    monkeypatch.setattr(ws, 'infer_json', infer)
    result = asyncio.run(ws.assess_workflow([source]))['runs'][0]
    assert [json.loads(prompt.rsplit('\n', 1)[-1])['targetEvents'] for prompt in prompts] == [['e1']]
    assert result['events']['trace-private:rx']['level'] == 'key'


def reviewed_input_analysis():
    source = make_analysis()
    source['flow'] = []
    source['inputEvidence'] = {'links': [{'source': source['calls'][0]['id'], 'target': source['calls'][1]['id'],
        'relation': 'semantic_context', 'inferred': True, 'reason': 'The earlier observation explains the chosen condition.',
        'evidence': [
            {'callId': source['calls'][0]['id'], 'field': 'response', 'path': '', 'quote': 'condition Q was useful'},
            {'callId': source['calls'][1]['id'], 'field': 'args', 'path': '/rationale', 'quote': 'test the shared condition'}]}]}
    return source


def test_reuses_dual_evidence_before_backtrace_without_reclassifying_transport(cache, monkeypatch):
    source = reviewed_input_analysis()
    prompts = []

    async def infer(prompt, **kwargs):
        prompts.append(prompt)
        payload = json.loads(prompt.rsplit('\n', 1)[-1])
        assert len(payload['reviewedInputs']) == 1
        match = payload['reviewedInputs'][0]
        assert {payload['evidence'][ref]['field'] for ref in match['evidence']} == {'response', 'args'}
        assert any(row['source'] == 'e0' and row['target'] == 'e1' and row['inferred'] for row in payload['links'])
        raw = answer(prompt, decision='continue')
        # An inferred input match must never become a recorded joint-use group.
        raw['jointGroups'] = [{'target': 'e1', 'sources': ['e0', 'e3'], 'label': 'Unsupported grouping',
                               'reason': 'Unsupported joint use.', 'evidence': match['evidence']}]
        return raw

    monkeypatch.setattr(ws, 'infer_json', infer)
    run = asyncio.run(ws.assess_workflow([source]))['runs'][0]
    assert len(prompts) == 1
    assert run['retrievalMetrics']['reusedInputLinks'] == 1
    assert run['links'][0]['inferred'] is True
    assert run['jointGroups'] == []
    assert any(issue['kind'] == 'joint_sources' for issue in run['retrievalMetrics']['validationIssues'])
    assert {item['field'] for item in run['links'][0]['evidence']} == {'response', 'args'}
    assert source['flow'] == []
    assert run['events']['trace-private:routine']['level'] == 'unknown'


def test_prepared_cache_tracks_reviewed_input_evidence():
    source = reviewed_input_analysis()
    source['analysisKey'] = 'same-source-analysis-key'
    first = ws._prepare(source)
    source['inputEvidence'] = {'links': []}
    second = ws._prepare(source)
    assert first is not second
    assert len(first['links']) == 1 and second['links'] == []


def test_reviewed_excerpt_outside_normal_card_survives(cache, monkeypatch):
    source = reviewed_input_analysis()
    quote = 'Distinctive observation from a later output chunk.'
    source['calls'][0]['response'] = 'Routine preamble. ' * 100 + quote
    source['inputEvidence']['links'][0]['evidence'][0]['quote'] = quote

    async def infer(prompt, **kwargs):
        payload = json.loads(prompt.rsplit('\n', 1)[-1])
        assert quote in {payload['evidence'][ref]['quote'] for ref in payload['reviewedInputs'][0]['evidence']}
        return answer(prompt)

    monkeypatch.setattr(ws, 'infer_json', infer)
    run = asyncio.run(ws.assess_workflow([source]))['runs'][0]
    assert quote in {e['quote'] for e in run['links'][0]['evidence']}
