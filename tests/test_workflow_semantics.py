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


def answer(prompt, *, key_events=()):
    payload = json.loads(prompt.rsplit('\n', 1)[-1])
    assessments = []
    for event in payload['events']:
        is_key = event['ref'] in key_events
        response_refs = [ref for ref in event['evidence'] if payload['evidence'][ref]['field'] == 'response']
        assessments.append({'event': event['ref'], 'level': 'key' if is_key else 'supporting',
                            'label': 'Measured result' if is_key else 'Recorded activity',
                            'reason': 'This output records the selected result.' if is_key else 'Provides task context.',
                            'evidence': response_refs[:1] or event['evidence'][:1] if is_key else []})
    links = [{'link': item['ref'], 'relevance': 'relevant', 'reason': 'Explicit recorded evidence use.'}
             for item in payload['links'] if item['relation'].startswith('used_')]
    return {'defaultLevel': 'unknown', 'assessments': assessments, 'keyParents': [], 'searchQueries': [],
            'linkAssessments': links, 'jointGroups': []}


def test_result_seed_and_explicit_parents_are_assessed_with_citations(cache, monkeypatch):
    prompts = []

    async def infer(prompt):
        prompts.append(prompt)
        payload = json.loads(prompt.rsplit('\n', 1)[-1])
        return answer(prompt, key_events={event['ref'] for event in payload['events']
                                           if event['type'] == 'experiment'})

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
    assert result['retrievalMetrics']['requestCount'] == 2


def test_source_output_plaintext_and_actual_paths_are_in_prompt(cache, monkeypatch):
    prompts = []

    async def infer(prompt):
        prompts.append(prompt)
        return answer(prompt)

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


def test_exact_context_cache_and_focus_variation(cache, monkeypatch):
    prompts = []

    async def infer(prompt):
        prompts.append(prompt)
        return answer(prompt)

    monkeypatch.setattr(ws, 'infer_json', infer)
    source = make_analysis()
    first = asyncio.run(ws.assess_workflow([source], focus='result A'))
    second = asyncio.run(ws.assess_workflow([source], focus='result A'))
    assert second['cached'] is True
    assert first['runs'][0]['events'] == second['runs'][0]['events']
    asyncio.run(ws.assess_workflow([source], focus='result B'))
    assert len(prompts) == 4


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

    async def infer(prompt):
        prompts.append(prompt)
        response = answer(prompt)
        response['searchQueries'] = ['rare keyword']
        return response

    monkeypatch.setattr(ws, 'infer_json', infer)
    asyncio.run(ws.assess_workflow([source], focus='rare keyword'))
    payloads = [json.loads(prompt.rsplit('\n', 1)[-1]) for prompt in prompts]
    assert seen_allowlists
    assert any(payload['retrievedContexts'] for payload in payloads)
    future_index = 3
    assert all(source['calls'][future_index]['id'] not in allow for allow in seen_allowlists)
    assert any(source['calls'][0]['id'] in allow for allow in seen_allowlists)


def test_task_and_result_terms_do_not_trigger_generic_retrieval(cache, monkeypatch):
    source = make_analysis()
    calls = []
    original = ws.BM25Retriever.search

    def track(self, query, limit=5, allowed_call_ids=None):
        calls.append(query)
        return original(self, query, limit, allowed_call_ids)

    monkeypatch.setattr(ws.BM25Retriever, 'search', track)

    async def infer(prompt):
        return answer(prompt)

    monkeypatch.setattr(ws, 'infer_json', infer)
    asyncio.run(ws.assess_workflow([source], focus='rare task words'))
    assert calls == []


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
        {'eventId': source['calls'][1]['id'], 'kind': 'milestone', 'scope': 'system', 'name': 'last recorded'},
    ]
    prepared = ws._prepare_uncached(source)
    assert prepared['seeds'] == [source['calls'][1]['id']]
    assert prepared['finalContext'][0]['name'] == 'last recorded'


def test_key_parent_is_expanded_backwards_across_multiple_rounds(cache, monkeypatch):
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

    async def infer(prompt):
        payload = json.loads(prompt.rsplit('\n', 1)[-1])
        target_rounds.append(payload['targetEvents'])
        raw = answer(prompt)
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
    assert len(target_rounds) == 3
    assert target_rounds == [['e2'], ['e1'], ['e0']]
    assert all(result['events'][call['id']]['status'] == 'assessed' for call in calls)


def test_assessment_stops_after_one_call_without_model_expansion(cache, monkeypatch):
    call = {'id': 'single:event', 'tool': 'final output', 'args': {'result': 'complete'},
            'response': 'done'}
    analysis = {'traceId': 'single', 'calls': [call], 'resultAnchors': [call['id']]}
    prompts = []

    async def infer(prompt):
        prompts.append(prompt)
        response = answer(prompt)
        response['searchQueries'] = ['shared_warmup', 'system_best_yield', 'offline_dataset_replay']
        return response

    monkeypatch.setattr(ws, 'infer_json', infer)
    result = asyncio.run(ws.assess_workflow([analysis]))
    assert len(prompts) == 1
    assert result['retrievalMetrics']['requestCount'] == 1
    assert result['runs'][0]['retrievalMetrics']['stopReason'] == 'result_has_no_predecessors'
    assert result['runs'][0]['retrievalMetrics']['coverage'] == {'assessed': 1, 'total': 1}


def test_relevant_supporting_input_is_followed_to_its_recorded_input(cache, monkeypatch):
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

    async def infer(prompt):
        requests.append(prompt)
        payloads.append(json.loads(prompt.rsplit('\n', 1)[-1]))
        return answer(prompt)

    monkeypatch.setattr(ws, 'infer_json', infer)
    run = asyncio.run(ws.assess_workflow([analysis]))['runs'][0]
    assert len(requests) == 3
    assert all(run['events'][call['id']]['level'] == 'supporting' for call in calls)
    assert run['retrievalMetrics']['coverage'] == {'assessed': 3, 'total': 3}
    assert run['retrievalMetrics']['stopReason'] == 'frontier_exhausted'
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

    async def infer(prompt):
        prompts.append(prompt)
        return answer(prompt)

    monkeypatch.setattr(ws, 'infer_json', infer)
    result = asyncio.run(ws.assess_workflow([analysis]))['runs'][0]
    payloads = [json.loads(prompt.rsplit('\n', 1)[-1]) for prompt in prompts]
    assert len(prompts) <= ws.MAX_ROUNDS
    assert all(len(payload['events']) <= ws.MAX_EVENTS for payload in payloads)
    assert all(len(prompt) <= ws.MAX_PROMPT_CHARS for prompt in prompts)
    assert result['retrievalMetrics']['stopReason'] == 'round_limit'
    assert result['retrievalMetrics']['remainingFrontier'] > 0


def test_oversized_target_batch_is_split_across_bounded_rounds(cache, monkeypatch):
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

    async def infer(prompt):
        prompts.append(prompt)
        return answer(prompt)

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

    async def infer(prompt):
        raw = answer(prompt)
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
    async def incomplete(prompt):
        return {'assessments': [], 'keyParents': [], 'searchQueries': [], 'jointGroups': []}

    monkeypatch.setattr(ws, 'infer_json', incomplete)
    with pytest.raises(ModelResponseError, match='defaultLevel unknown and sparse assessments'):
        asyncio.run(ws.assess_workflow([make_analysis()]))
    invalid = list((tmp_path / 'workflow-assessments' / 'invalid-responses').glob('*.json'))
    assert len(invalid) == 1
    stored = json.loads(invalid[0].read_text())
    assert all(ref.startswith('e') for ref in stored['eventRefs'])

    async def sparse_unknown(prompt):
        return {'defaultLevel': 'unknown', 'assessments': [], 'keyParents': [], 'searchQueries': [],
                'jointGroups': []}

    monkeypatch.setattr(ws, 'infer_json', sparse_unknown)
    single = make_analysis()
    single['calls'] = [single['calls'][1]]
    single['workflow']['eventLinks'] = []
    single['resultAnchors'] = [single['calls'][0]['id']]
    result = asyncio.run(ws.assess_workflow([single]))['runs'][0]['events'][single['calls'][0]['id']]
    assert result['level'] == 'unknown' and result['status'] == 'assessed'
    assert result['reason'] == 'The model did not establish this activity’s importance.'

    async def fake_citation(prompt):
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
    parent, target = source['calls'][2]['id'], source['calls'][1]['id']
    link_rows = ws._context_links(prepared, [target], [parent, target])
    assert any(row['relation'] == 'publishes' for row in link_rows)
    payload = ws._prompt_payload(prepared, '', [target], [parent, target], link_rows)
    parent_ref, target_ref = prepared['idToRef'][parent], prepared['idToRef'][target]
    parent_quote = next(iter(payload['events'][0]['evidence']))
    raw = {'defaultLevel': 'unknown', 'assessments': [
        {'event': parent_ref, 'level': 'key', 'label': 'Published input', 'reason': 'Recorded input.',
         'evidence': [parent_quote]},
        {'event': target_ref, 'level': 'supporting', 'label': 'Work', 'reason': 'Context.', 'evidence': []}],
        'keyParents': [parent_ref]}
    normalized = ws._normalize_response(raw, prepared, payload, [parent, target], link_rows)
    assert normalized[2] == [parent]

    raw['assessments'][0]['level'] = 'supporting'
    raw['assessments'][0]['evidence'] = []
    with pytest.raises(ModelResponseError, match='assessed as key'):
        ws._normalize_response(raw, prepared, payload, [parent, target], link_rows)


def test_direct_final_anchor_without_context_keeps_other_events_unknown(cache, monkeypatch):
    source = make_analysis()
    source['workflow']['eventLinks'] = []
    source['workflow']['outcomes'] = []
    source.pop('resultAnchors')

    async def infer(prompt):
        return answer(prompt)

    monkeypatch.setattr(ws, 'infer_json', infer)
    result = asyncio.run(ws.assess_workflow([source]))['runs'][0]
    assert all(item['level'] == 'unknown' and item['status'] == 'not_assessed'
               for item in result['events'].values())


def test_sparse_later_round_does_not_erase_an_earlier_explicit_judgment(cache, monkeypatch):
    source = make_analysis()
    source['workflow']['roundLabel'] = 'Round'
    source['workflow']['eventLinks'] = [source['workflow']['eventLinks'][0]]
    responses = []

    async def infer(prompt):
        payload = json.loads(prompt.rsplit('\n', 1)[-1])
        responses.append(payload)
        if len(responses) > 1:
            return {'defaultLevel': 'unknown', 'assessments': [], 'keyParents': [], 'searchQueries': []}
        parent = next(event for event in payload['events'] if event['ref'] == 'e0')
        return {'defaultLevel': 'unknown', 'assessments': [
            {'event': 'e0', 'level': 'key', 'label': 'Useful shared condition',
             'reason': 'This recorded input informs the result.', 'evidence': parent['evidence'][:1]}],
            'keyParents': ['e0'], 'searchQueries': []}

    monkeypatch.setattr(ws, 'infer_json', infer)
    result = asyncio.run(ws.assess_workflow([source]))['runs'][0]
    assert len(responses) == 2
    assert result['events']['trace-private:rx']['level'] == 'key'
    assert result['events']['trace-private:rx']['evidence']


def test_cited_key_input_is_expanded_when_model_omits_keyparents(cache, monkeypatch):
    source = make_analysis()
    source['workflow']['roundLabel'] = 'Round'
    source['workflow']['eventLinks'] = [source['workflow']['eventLinks'][0]]
    prompts = []

    async def infer(prompt):
        prompts.append(prompt)
        payload = json.loads(prompt.rsplit('\n', 1)[-1])
        raw = answer(prompt, key_events={'e0'})
        raw['keyParents'] = []
        raw['linkAssessments'] = []
        return raw

    monkeypatch.setattr(ws, 'infer_json', infer)
    result = asyncio.run(ws.assess_workflow([source]))['runs'][0]
    assert [json.loads(prompt.rsplit('\n', 1)[-1])['targetEvents'] for prompt in prompts] == [['e1'], ['e0']]
    assert result['events']['trace-private:rx']['level'] == 'key'
