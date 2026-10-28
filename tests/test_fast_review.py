"""Single-pass review preserves original evidence and never searches future outputs."""
import asyncio
import json

import pytest
from jsonschema import ValidationError, validate

import fast_review as review
import semantics
from models import ModelResponseError


def trace():
    a = {'traceId': 'private-run', 'taskDescription': 'Investigate ALPHA and BETA.',
            'score': 991234567, 'finalOutput': 'ALPHA and BETA were observed together.',
            'calls': [
                {'id': 'source-a', 'tool': 'inspect', 'args': {'question': 'initial'},
                 'response': {'finding': 'ALPHA and BETA were observed together.'}, 'timeIndex': 0},
                {'id': 'source-b', 'tool': 'measure', 'args': {'question': 'initial'},
                 'response': {'finding': 'BETA is a candidate alongside ALPHA.'}, 'timeIndex': 1},
                {'id': 'consumer', 'tool': 'lookup', 'args': {'query': 'ALPHA BETA'},
                 'response': {'note': 'later observation'}, 'timeIndex': 2}], 'flow': []}
    for c in a['calls']:
        c['status'] = 'ok'
    return a


def empty(prepared):
    return {'events': [], 'links': [], 'contextUses': [], 'results': [], 'claims': [{'id': c['id'], 'links': []}
                                               for c in prepared['payload']['claims']]}


def test_candidate_pairs_cite_both_endpoints_and_allow_multiple_earlier_sources():
    a = trace()
    p = review.prepare(a)
    pairs = [v for v in p['pairs'].values() if v['target'] == 'consumer']
    assert {v['source'] for v in pairs} == {'source-a', 'source-b'}
    order = {c['id']: c['timeIndex'] for c in a['calls']}
    for pair in p['pairs'].values():
        assert pair['basis'] == 'output_use'
        assert order[pair['source']] < order[pair['target']]
        refs = [p['evidence'][r] for r in pair['evidence']]
        assert any(e['callId'] == pair['source'] and e['field'] == 'response' for e in refs)
        assert any(e['callId'] == pair['target'] and e['field'] == 'args' for e in refs)
        assert not any(e['callId'] == pair['target'] and e['field'] == 'response' for e in refs)
    raw = empty(p)
    raw['links'] = [{'sourceEvidence': [v['sourceEvidence'][0]], 'inputRole': 'selection', 'missingInputs': [],
                     'consumerEvidence': v['consumerEvidence'][0],
                     'reason': 'Specific earlier candidates explain the query.'} for v in pairs]
    result = review.interpret(a, p, raw)
    assert len(result['links']) == 2 and all(l['inferred'] for l in result['links'])


def test_value_role_requires_exact_consumer_value_in_every_cited_producer():
    a = trace()
    a['calls'][0]['response'] = {'amount': 12, 'finding': 'ALPHA and BETA'}
    a['calls'][1]['response'] = {'amount': 13, 'finding': 'ALPHA and BETA'}
    a['calls'][2]['args'] = {'amount': 12}
    prepared = review.prepare(a)
    pairs = {pair['source']: pair for pair in prepared['pairs'].values()
             if pair['target'] == 'consumer'}
    assert {'source-a', 'source-b'} <= pairs.keys()
    raw = empty(prepared)
    raw['links'] = [{'sourceEvidence': [next(ref for ref in pairs[source]['sourceEvidence']
            if prepared['evidence'][ref]['field'] == 'response'
            and prepared['evidence'][ref]['path'] in {'/amount', ''})
            for source in ('source-a', 'source-b')],
        'consumerEvidence': next(ref for ref in pairs['source-a']['consumerEvidence']
                                 if prepared['evidence'][ref]['path'] == '/amount'),
        'inputRole': 'value', 'missingInputs': [], 'reason': 'The earlier amounts supply this value.'}]

    result = review.interpret(a, prepared, raw)

    assert not [link for link in result['links'] if link.get('inputRole') == 'value']
    assert len(result['rejectedInputLinks']) == 1
    assert 'exact complete consumer value' in result['rejectedInputLinks'][0]['rejectionReason']
    assert a['calls'][2]['args'] == {'amount': 12}


def test_value_role_accepts_exact_leaf_or_complete_container_and_distinguishes_boolean_numbers():
    for response, consumer_value, expected in [
        ({'amount': 12, 'finding': 'ALPHA'}, 12, True),
        ({'payload': {'amount': 12}, 'finding': 'ALPHA'}, 12, True),
        ({'amount': 1, 'finding': 'ALPHA'}, True, False),
    ]:
        a = trace()
        a['calls'][0]['response'] = response
        a['calls'][2]['args'] = {'amount': consumer_value, 'query': 'ALPHA'}
        prepared = review.prepare(a)
        pair = next(pair for pair in prepared['pairs'].values()
                    if pair['source'] == 'source-a' and pair['target'] == 'consumer')
        source = next(ref for ref in pair['sourceEvidence']
                      if prepared['evidence'][ref]['field'] == 'response'
                      and prepared['evidence'][ref]['complete'] is True
                      and (prepared['evidence'][ref]['path'] == '/amount'
                           or prepared['evidence'][ref]['path'] == ''))
        consumer = next(ref for ref in pair['consumerEvidence']
                        if prepared['evidence'][ref]['path'] == '/amount')
        raw = empty(prepared)
        raw['links'] = [{'sourceEvidence': [source], 'consumerEvidence': consumer,
                         'inputRole': 'value', 'missingInputs': [],
                         'reason': 'The prior output supplied this exact argument value.'}]

        result = review.interpret(a, prepared, raw)

        accepted = [link for link in result['links'] if link.get('inputRole') == 'value']
        assert bool(accepted) is expected
        assert bool(result['rejectedInputLinks']) is not expected


def test_long_history_retrieves_sources_outside_the_initial_activity_sample():
    calls = [{'id': str(i), 'tool': 'observe', 'timeIndex': i, 'args': {},
              'response': {'note': 'Unrelated routine observation.'}} for i in range(81)]
    calls[2]['response'] = {'finding': 'ALPHAZETA and BETAZETA explain the requested investigation.'}
    calls[-1].update(tool='lookup', args={'query': 'ALPHAZETA BETAZETA'})
    a = {'traceId': 'long', 'calls': calls, 'flow': [], 'targetCallIds': ['80']}
    p = review.prepare(a)
    assert any(pair['source'] == '2' and pair['target'] == '80' for pair in p['pairs'].values())
    assert '2' in p['eventRefs'].values()
    assert len(p['payload']['events']) <= review.MAX_EVENTS
    assert len(p['embeddingDocuments']) <= review.MAX_EMBEDDING_DOCUMENTS
    assert p['promptCharacters'] <= review.MAX_PROMPT_CHARS


def test_exact_reference_parent_does_not_block_complementary_unexplained_input():
    a = trace()
    a['flow'] = [{'source': 'source-a', 'target': 'consumer', 'inferred': False,
                  'evidence': [{'kind': 'reference', 'sourcePath': '/id'}]}]
    p = review.prepare(a)
    pairs = [v for v in p['pairs'].values() if v['target'] == 'consumer']
    assert {v['source'] for v in pairs} == {'source-a', 'source-b'}
    result = review.interpret(a, p, empty(p))
    assert any(link['sourceCallId'] == 'source-a' and link['targetCallId'] == 'consumer'
               and not link['inferred'] for link in result['links'])
    a['flow'][0]['evidence'] = [{'kind': 'recorded', 'relation': 'delivered_to'}]
    assert any(v['source'] == 'source-a' and v['target'] == 'consumer'
               for v in review.prepare(a)['pairs'].values())


def test_opaque_reference_retrieves_selection_context_from_its_bound_record():
    a = {'traceId': 'bound', 'flow': [{'source': 'records', 'target': 'consume',
        'evidence': [{'kind': 'reference', 'sourcePath': '/rows/0/item_id', 'targetPath': '/item_id'}]}],
        'calls': [
            {'id': 'records', 'tool': 'list_records', 'timeIndex': 0, 'args': {},
             'response': {'rows': [{'item_id': 17, 'subject': 'ALPHAZETA', 'token': 'KEEP_SECRET'}]}},
            {'id': 'criteria', 'tool': 'lookup_criteria', 'timeIndex': 1,
             'args': {'category': 'eligible'}, 'response': {'subject': 'ALPHAZETA', 'eligible': True}},
            {'id': 'consume', 'tool': 'apply', 'timeIndex': 2, 'args': {'item_id': 17},
             'response': 'FUTURE_CONSUMER_OUTPUT'},
            {'id': 'future', 'tool': 'inspect', 'timeIndex': 3, 'args': {},
             'response': {'subject': 'ALPHAZETA'}}]}
    for call in a['calls']:
        call['status'] = 'success'
    p = review.prepare(a)
    pairs = [pair for pair in p['pairs'].values() if pair['target'] == 'consume']
    assert {'criteria', 'records'} <= {pair['source'] for pair in pairs}
    pair = pairs[0]
    assert pair['boundInputs']
    bound = pair['boundInputs'][0]
    assert p['evidence'][bound['inputEvidence']]['callId'] == 'consume'
    assert p['evidence'][bound['inputEvidence']]['path'] == '/item_id'
    assert all(p['evidence'][ref]['callId'] == 'records' for ref in bound['recordEvidence'])
    assert all(p['evidence'][ref]['field'] == 'response' for ref in bound['recordEvidence'])
    assert 'KEEP_SECRET' not in json.dumps(p['payload'])
    assert all('FUTURE_CONSUMER_OUTPUT' not in p['evidence'][ref]['quote'] for ref in pair['evidence'])
    assert review.interpret(a, p, empty(p))['links'][0]['inferred'] is False


def test_bound_record_does_not_hydrate_a_different_reference_value():
    a = trace()
    a['calls'][0]['response'] = {'rows': [{'item_id': 17, 'subject': 'ALPHAZETA'}]}
    a['calls'][2]['args'] = {'item_id': 18}
    a['flow'] = [{'source': 'source-a', 'target': 'consumer', 'evidence': [
        {'kind': 'reference', 'sourcePath': '/rows/0/item_id', 'targetPath': '/item_id'}]}]
    p = review.prepare(a)
    assert not any(pair['boundInputs'] for pair in p['pairs'].values() if pair['target'] == 'consumer')


def test_another_record_with_the_same_subject_exposes_its_different_identifier():
    a = trace()
    a['calls'][0]['response'] = {'rows': [{'item_id': 17, 'subject': 'ALPHAZETA'}]}
    a['calls'][1]['response'] = {'rows': [{'item_id': 99, 'subject': 'ALPHAZETA'}]}
    a['calls'][2]['args'] = {'item_id': 17}
    a['flow'] = [{'source': 'source-a', 'target': 'consumer', 'evidence': [
        {'kind': 'reference', 'sourcePath': '/rows/0/item_id', 'targetPath': '/item_id'}]}]
    p = review.prepare(a)
    pair = next(pair for pair in p['pairs'].values() if pair['target'] == 'consumer' and pair['source'] == 'source-b')
    comparison = pair['bindingComparisons'][0]
    assert comparison['sameRecordIdentifier'] is False
    assert p['evidence'][comparison['sourceEvidence']]['quote'] == '99'
    assert p['evidence'][comparison['consumerEvidence']]['quote'] == '17'


def test_named_lexical_evidence_survives_dense_topic_distractors():
    a = trace()
    a['calls'].insert(2, {'id': 'topic', 'tool': 'inspect', 'timeIndex': 1.5,
                          'args': {}, 'response': {'note': 'General related topic without named findings.'}})
    scores = {(source, 'consumer'): value for source, value in
              [('topic', .99), ('source-a', .7), ('source-b', .7)]}
    p = review.prepare(a, dense_scores=scores)
    pairs = [v for v in p['pairs'].values() if v['target'] == 'consumer']
    assert pairs[0]['source'] in {'source-a', 'source-b'}
    assert {'source-a', 'source-b'} <= {v['source'] for v in pairs}


def test_received_context_search_recovers_multiple_earlier_inputs_but_not_unseen_peers():
    calls = [{'id': str(i), 'tool': 'observe', 'timeIndex': i, 'args': {},
              'response': {'note': 'Routine unrelated result.'}, 'agentId': 'a', 'round': i}
             for i in range(81)]
    for index, term in ((2, 'ALPHAZETA'), (4, 'BETAZETA')):
        calls[index].update(tool='receive', args={'insight': term}, response=None)
    calls[3].update(agentId='unseen', response='ALPHAZETA BETAZETA')
    calls[-1].update(tool='choose', args={'rationale': 'Combine ALPHAZETA and BETAZETA.'})
    a = {'traceId': 'long', 'calls': calls, 'flow': [], 'targetCallIds': ['80'],
         'workflow': {'roundLabel': 'Round'}}
    pairs = [pair for pair in review.prepare(a)['pairs'].values() if pair['target'] == '80']
    assert {'2', '4'} <= {pair['source'] for pair in pairs}
    assert all(pair['source'] != '3' for pair in pairs)
    assert all(pair['basis'] == 'activity_context' for pair in pairs if pair['source'] in {'2', '4'})


def test_foreign_actor_and_same_round_are_not_inferred_exposure():
    a = trace()
    for i, c in enumerate(a['calls']):
        c.update(agentId='actor-a' if i < 2 else 'actor-b', round=i)
    a['workflow'] = {'roundLabel': 'Round'}
    assert not review.prepare(a)['pairs']
    a['calls'][2]['agentId'] = 'actor-a'
    a['calls'][2]['round'] = 1
    p = review.prepare(a)
    assert all(v['source'] != 'source-b' for v in p['pairs'].values() if v['target'] == 'consumer')


def test_shared_fields_are_candidates_but_do_not_create_inferred_dependencies():
    a = trace()
    a['finalOutput'] = ''
    a['calls'][0].update(tool='arbitrary_schema_reader', response={'schema': {'fields': ['spectral signature', 'other']}})
    a['calls'][1]['response'] = {'rows': [{'unrelated_dimension': 'UNRELATED'}]}
    a['calls'][2].update(tool='arbitrary_join_tool', args={'chosen_dimension': 'spectral signature'})
    prepared = review.prepare(a)
    candidates = [p for p in prepared['pairs'].values() if p['target'] == 'consumer']
    assert {p['source'] for p in candidates} == {'source-a'}

    result = review.interpret(a, prepared, empty(prepared))
    assert not [link for link in result['links'] if link['inferred'] and link['targetCallId'] == 'consumer']


def test_recorded_links_and_unreviewed_calls_survive_empty_judgment():
    a = trace()
    a['flow'] = [{'source': 'source-a', 'target': 'consumer', 'relation': 'explicit', 'inferred': False}]
    p = review.prepare(a)
    result = review.interpret(a, p, empty(p))
    assert set(result['events']) == {c['id'] for c in a['calls']}
    assert all(e['level'] == 'unknown' for e in result['events'].values())
    assert result['links'][0]['inferred'] is False
    assert result['links'][0]['relation'] == 'explicit'
    assert result['reviewedActivities'] == 0


def test_wrong_activity_evidence_and_invented_pair_are_rejected():
    a, p = trace(), review.prepare(trace())
    raw = empty(p)
    event, other = p['payload']['events'][:2]
    raw['events'] = [{'id': event['id'], 'level': 'key', 'reason': 'Critical finding', 'evidence': other['evidence']}]
    with pytest.raises(ModelResponseError, match='own supplied evidence'):
        review.interpret(a, p, raw)
    raw = empty(p)
    raw['links'] = [{'consumerEvidence': 'invented', 'sourceEvidence': ['v0'], 'reason': 'No candidate.'}]
    with pytest.raises(ModelResponseError, match='consumer argument citation'):
        review.interpret(a, p, raw)


def test_compact_schema_bounds_supplied_event_cards_and_leaves_citations_to_runtime():
    a = trace()
    prepared = review.prepare(a)
    payload = prepared['payload']
    visible_refs = {row['id'] for row in payload['evidence']}
    for pair in payload['pairs']:
        assert set(pair['sourceEvidence'] + pair['consumerEvidence']) <= visible_refs
        assert all(set(row['recordEvidence']) <= visible_refs for row in pair['boundInputs'])
    schema = review.schema_for_payload(payload)
    variants = schema['properties']['links']['items']['anyOf']
    assert len(variants) == len({ref for pair in payload['pairs'] for ref in pair['consumerEvidence']})
    assert len(json.dumps(schema)) < 6000
    assert schema['properties']['events']['minItems'] == len(payload['events'])
    assert schema['properties']['events']['maxItems'] == len(payload['events'])
    raw = empty(prepared)
    raw['events'] = [{'id': event['id'], 'level': 'unknown', 'reason': 'No specific judgment.',
                      'evidence': event['evidence'][:1]} for event in payload['events']]
    validate(raw, schema)
    foreign = {**raw, 'events': [dict(raw['events'][0], evidence=['not-owned'])] + raw['events'][1:]}
    with pytest.raises(ModelResponseError, match='own supplied evidence'):
        review.interpret(a, prepared, foreign)


def test_context_use_must_cite_its_own_event_argument_and_visible_context():
    a = trace()
    prepared = review.prepare(a)
    first, second = prepared['payload']['events'][:2]
    raw = empty(prepared)
    raw['contextUses'] = [{'event': first['id'], 'consumerEvidence': second['inputEvidence'][0],
                           'contextEvidence': first['contextEvidence'][:1],
                           'reason': 'This cites another activity argument.'}]
    with pytest.raises(ModelResponseError, match='exact consumer argument'):
        review.interpret(a, prepared, raw)


def test_claim_evidence_is_exact_and_is_not_a_recorded_dependency():
    a, p = trace(), review.prepare(trace())
    raw = empty(p)
    card = p['payload']['claims'][0]
    raw['claims'] = [{'id': card['id'], 'links': [{'evidenceIds': card['outputs'],
        'relation': 'supports', 'reason': 'The observation contains both candidates.'}]}]
    result = review.interpret(a, p, raw)
    assert result['links'] == []
    assert result['resultEvidence']['claims'][0]['assessed']
    for link in result['resultEvidence']['claims'][0]['links']:
        call = next(c for c in a['calls'] if c['id'] == link['callId'])
        assert all(e['quote'] in json.dumps(call['response']) for e in link['evidence'])


def test_one_request_per_trace_cache_and_privacy(monkeypatch, tmp_path):
    monkeypatch.setattr(semantics, 'CACHE_DIR', tmp_path)
    prompts = []
    embedding_tasks = []

    async def infer(prompt, **kwargs):
        prompts.append(prompt)
        assert '991234567' not in prompt and 'private-run' not in prompt
        payload = json.loads(prompt.rsplit('\n', 1)[-1])
        assert len(prompt) <= review.MAX_PROMPT_CHARS
        assert len(payload['events']) <= review.MAX_EVENTS
        assert kwargs['settings'] == {'reasoning_effort': 'low'}
        return {'events': [], 'links': [], 'contextUses': [], 'results': [], 'claims': [{'id': c['id'], 'links': []} for c in payload['claims']]}

    monkeypatch.setattr(review, 'infer_json', infer)
    async def embeddings(texts, task, metrics):
        embedding_tasks.append(task)
        metrics['embeddingRequests'] += 1
        assert all(len(text) <= 1200 for text in texts)
        return {text: [1., 0.] for text in texts}
    monkeypatch.setattr(review, 'embed', embeddings)
    first = asyncio.run(review.review_traces([trace()]))
    second = asyncio.run(review.review_traces([trace()]))
    assert len(prompts) == 1 and not first['cached'] and second['cached']
    assert sorted(embedding_tasks) == ['RETRIEVAL_DOCUMENT', 'RETRIEVAL_QUERY']
    assert first['runs'][0]['dependencySearch']['embeddingRequests'] == 2
    assert first['runs'][0]['events'] == second['runs'][0]['events']


def test_large_trace_is_bounded_without_discarding_original_calls():
    a = trace()
    a['calls'] = [{**a['calls'][0], 'id': str(i), 'timeIndex': i} for i in range(120)]
    a['targetCallIds'] = ['119']
    p = review.prepare(a)
    assert len(p['payload']['events']) <= review.MAX_EVENTS
    assert '119' in {p['eventRefs'][e['id']] for e in p['payload']['events']}
    result = review.interpret(a, p, empty(p))
    assert len(result['events']) == 120
    assert len(review.PROMPT + json.dumps(p['payload'], ensure_ascii=False, separators=(',', ':'))) <= review.MAX_PROMPT_CHARS


def test_full_query_list_and_later_output_rows_are_retrieved():
    a = trace()
    a['finalOutput'] = ''
    genes = ['DKK4', 'WIF1', 'CTNNB1', 'AXIN1', 'LEF1']
    a['calls'][0]['response'] = {'columns': ['gene_name', 'statistic'],
                               'rows': json.dumps([{'term': 'Wnt', 'leading_genes': genes}])}
    a['calls'][1]['response'] = {'note': 'Unrelated sample inspection.'}
    a['calls'][2]['args'] = {'genes': genes}
    p = review.prepare(a)
    pair = next(v for v in p['pairs'].values() if v['source'] == 'source-a' and v['target'] == 'consumer')
    refs = [p['evidence'][r] for r in pair['evidence']]
    assert any(e['field'] == 'response' and 'LEF1' in e['quote'] for e in refs)
    assert any(e['field'] == 'args' and all(g in e['quote'] for g in genes) for e in refs)


def test_dense_paraphrase_is_only_a_candidate_and_respects_availability():
    a = trace()
    a['finalOutput'] = ''
    a['calls'][0]['response'] = {'finding': 'Thermal decomposition accelerates above boiling.'}
    a['calls'][1]['response'] = {'finding': 'Mechanical damage affects the vessel.'}
    a['calls'][2]['args'] = {'query': 'Investigate heat induced breakdown.'}
    assert not review.prepare(a)['pairs']
    p = review.prepare(a, dense_scores={('source-a', 'consumer'): .72, ('source-b', 'consumer'): .34,
                                        ('consumer', 'source-a'): .99})
    assert {(v['source'], v['target']) for v in p['pairs'].values()} == {('source-a', 'consumer')}
    assert not review.interpret(a, p, empty(p))['links']
    a['calls'][0]['agentId'], a['calls'][2]['agentId'] = 'other', 'self'
    assert not review.prepare(a, dense_scores={('source-a', 'consumer'): .99})['pairs']


def test_scalar_parameter_copy_is_searchable_without_becoming_a_recorded_link():
    a = trace()
    a['finalOutput'] = ''
    a['calls'][0].update(tool='observe', args={}, response=1792767838.650602)
    a['calls'][1].update(tool='unrelated', response={'note': 'An unrelated observation.'})
    a['calls'][2].update(tool='convert', args={'observed_time': 1792767838.650602})
    prepared = review.prepare(a)
    pair = next(pair for pair in prepared['pairs'].values()
                if pair['source'] == 'source-a' and pair['target'] == 'consumer')
    source_quotes = [prepared['evidence'][ref] for ref in pair['evidence']
                     if prepared['evidence'][ref]['field'] == 'response']
    assert any(e['quote'] == '1792767838.650602' for e in source_quotes)
    assert prepared['embeddingQueries']['consumer'].startswith('convert ')
    assert not review.interpret(a, prepared, empty(prepared))['links']


def test_lexical_retrieval_prefers_content_match_over_numbers_and_omits_tool_hint():
    a = trace()
    a['finalOutput'] = ''
    a['calls'] = [
        {'id': 'numeric', 'tool': 'observe', 'args': {},
         'response': {'page_limit': 20, 'page_index': 0}, 'timeIndex': 0},
        {'id': 'match', 'tool': 'read_note', 'args': {},
         'response': {'content': 'Sandra owes $19 for dinner.'}, 'timeIndex': 1},
        {'id': 'tool-name-only', 'tool': 'observe', 'args': {},
         'response': {'content': 'lookup'}, 'timeIndex': 2},
        {'id': 'consumer', 'tool': 'lookup', 'args': {
            'query': 'Sandra', 'page_index': 0, 'page_limit': 20},
         'response': {'ok': True}, 'timeIndex': 3},
    ]
    a['flow'] = []
    prepared = review.prepare(a)
    pairs = [p for p in prepared['pairs'].values() if p['target'] == 'consumer']
    assert pairs[0]['source'] == 'match'
    assert 'numeric' in {p['source'] for p in pairs}
    assert 'tool-name-only' not in {p['source'] for p in pairs}
    assert prepared['embeddingQueries']['consumer'].startswith('lookup ')


def test_empty_return_exposes_prior_activity_args_status_and_null_response_as_candidate():
    a = trace()
    a['finalOutput'] = ''
    a['calls'] = [
        {'id': 'setup', 'tool': 'set_network', 'args': {'enabled': True, 'network': 'guest'},
         'response': None, 'status': 'ok', 'timeIndex': 0},
        {'id': 'next', 'tool': 'list_holidays', 'args': {'region': 'Vienna'},
         'response': {'count': 1}, 'status': 'ok', 'timeIndex': 1},
    ]
    a['flow'] = []
    prepared = review.prepare(a)
    pair = next(p for p in prepared['pairs'].values() if p['source'] == 'setup' and p['target'] == 'next')
    assert pair['basis'] == 'activity_context'
    cited = [prepared['evidence'][ref] for ref in pair['evidence']]
    cited_rows = {(row['callId'], row['field'], row['path'], row['quote']) for row in cited}
    assert {('setup', 'args', '/enabled', 'true'), ('setup', 'args', '/network', 'guest'),
            ('setup', 'response', '', 'null')} <= cited_rows
    assert any(row['callId'] == 'next' and row['field'] == 'args' for row in cited)
    assert any(row['callId'] == 'next' and row['field'] == 'response' for row in cited)
    raw = empty(prepared)
    result = review.interpret(a, prepared, raw)
    assert not [link for link in result['links'] if link['sourceCallId'] == 'setup']
    raw['links'] = [{'sourceEvidence': [pair['sourceEvidence'][0]], 'inputRole': 'enabling', 'missingInputs': [],
                     'consumerEvidence': pair['consumerEvidence'][0],
                     'reason': 'The earlier action context supports this use.'}]
    judged = review.interpret(a, prepared, raw)
    selected = next(link for link in judged['links'] if link['sourceCallId'] == 'setup')
    assert selected['inferred'] and selected['relation'] == 'semantic_context'
    assert any(item['field'] == 'args' for item in selected['evidence'])
    assert any(item['callId'] == 'next' and item['field'] == 'response'
               for item in selected['activityContext'])


def test_empty_return_context_respects_actor_visibility_and_strict_past_only():
    a = trace()
    a['finalOutput'] = ''
    a['calls'] = [
        {'id': 'other-actor', 'tool': 'set_network', 'args': {'network': 'guest'},
         'response': None, 'status': 'ok', 'timeIndex': 0, 'agentId': 'other', 'round': 0},
        {'id': 'consumer', 'tool': 'list_holidays', 'args': {'region': 'Vienna'},
         'response': {}, 'status': 'ok', 'timeIndex': 1, 'agentId': 'self', 'round': 1},
        {'id': 'future', 'tool': 'set_network', 'args': {'network': 'future'},
         'response': None, 'status': 'ok', 'timeIndex': 2, 'agentId': 'self', 'round': 2},
    ]
    a['flow'] = []
    a['workflow'] = {'roundLabel': 'Round'}
    assert not [p for p in review.prepare(a)['pairs'].values()
                if p['target'] == 'consumer' and p['source'] == 'other-actor']
    a['calls'][0]['agentId'] = 'self'
    prepared = review.prepare(a)
    assert any(p['target'] == 'consumer' and p['source'] == 'other-actor'
               for p in prepared['pairs'].values())
    assert all(p['source'] != 'future' for p in prepared['pairs'].values())




def test_falsy_public_results_are_substantive_outputs():
    for value in (False, 0, 0.0):
        assert review._substantive_response(
            {'response': {'value': value, 'executionStatus': 'success'}}, 'trace')


def test_private_state_can_enable_calls_without_exposing_values_or_becoming_results():
    for response in (
        {'access_token': 'DO_NOT_EXPOSE'},
        {'value': {'access_token': 'DO_NOT_EXPOSE'}, 'executionStatus': 'success'},
    ):
        a = {'traceId': 'private-output', 'taskDescription': 'Check credential access.',
             'calls': [
                 {'id': 'private-source', 'tool': 'inspect', 'args': {'query': 'credential access'},
                  'response': response, 'timeIndex': 0, 'status': 'success'},
                 {'id': 'consumer', 'tool': 'check',
                  'args': {'query': 'credential access', 'access_token': 'DO_NOT_EXPOSE'},
                  'response': {'ok': True}, 'timeIndex': 1},
             ], 'flow': [], 'finalOutput': ''}
        prepared = review.prepare(a)
        pair = next(pair for pair in prepared['pairs'].values()
                    if pair['source'] == 'private-source' and pair['target'] == 'consumer')
        assert pair['basis'] == 'activity_context'
        assert not review._substantive_response(a['calls'][0], a['traceId'])
        assert 'DO_NOT_EXPOSE' not in json.dumps(prepared['payload'])
        assert '<secret_token_1>' in json.dumps(prepared['payload'])
        consumer = next(ref for ref in pair['consumerEvidence']
                        if prepared['evidence'][ref]['path'] == '/access_token')
        source = next(ref for ref in pair['sourceEvidence']
                      if prepared['evidence'][ref].get('sensitivity') == 'secret')
        raw = empty(prepared)
        raw['events'] = [{'id': event['id'], 'level': 'supporting',
                          'reason': 'Recorded execution state.', 'evidence': event['evidence'][:1]}
                         for event in prepared['payload']['events']]
        raw['links'] = [{'sourceEvidence': [source], 'consumerEvidence': consumer,
                         'inputRole': 'enabling', 'missingInputs': [],
                         'reason': 'Earlier opaque state is reused to authorize the consumer.'}]
        validate(raw, review.schema_for_payload(prepared['payload']))
        result = review.interpret(a, prepared, raw)
        assert result['links'][0]['inputRole'] == 'enabling'
        assert result['links'][0]['inferred']
        raw['links'][0]['inputRole'] = 'value'
        rejected = review.interpret(a, prepared, raw)
        assert not rejected['links']
        assert len(rejected['rejectedInputLinks']) == 1
        with pytest.raises(ValidationError):
            validate(raw, review.schema_for_payload(prepared['payload']))
        raw['links'][0]['inputRole'] = 'enabling'
        raw['links'][0]['sourceEvidence'].append(next(ref for ref in pair['sourceEvidence']
            if prepared['evidence'][ref]['field'] == 'args'))
        with pytest.raises(ValidationError):
            validate(raw, review.schema_for_payload(prepared['payload']))
        assert len(review.interpret(a, prepared, raw)['rejectedInputLinks']) == 1


def test_extra_state_candidate_survives_six_ranked_output_candidates():
    calls = [{'id': f'read-{i}', 'tool': 'inspect', 'timeIndex': i,
              'args': {'query': 'ALPHA'}, 'response': {'content': 'ALPHA'}}
             for i in range(6)]
    calls += [
        {'id': 'enable', 'tool': 'configure', 'timeIndex': 6,
         'args': {'enabled': True}, 'response': None, 'status': 'success'},
        {'id': 'use', 'tool': 'inspect', 'timeIndex': 7,
         'args': {'query': 'ALPHA'}, 'response': {'content': 'ALPHA'}}]
    prepared = review.prepare({'traceId': 'state', 'calls': calls, 'flow': []})
    pairs = [pair for pair in prepared['pairs'].values() if pair['target'] == 'use']
    assert len(pairs) == 7
    assert any(pair['source'] == 'enable' and pair['basis'] == 'activity_context' for pair in pairs)


def test_source_selection_condition_after_third_parameter_is_citable():
    analysis = {'traceId': 'source-parameters', 'flow': [], 'calls': [
        {'id': 'source', 'tool': 'search', 'timeIndex': 0,
         'args': {'page': 0, 'limit': 20, 'sort': 'ascending',
                  'where': {'category': 'eligible', 'min_date': '2030-02-01'}},
         'response': {'id': 'chosen', 'name': 'ALPHA'}},
        {'id': 'consumer', 'tool': 'inspect', 'timeIndex': 1,
         'args': {'resource_id': 'chosen'}, 'response': {'finding': 'ALPHA'}}]}
    prepared = review.prepare(analysis)
    pair = next(pair for pair in prepared['pairs'].values() if pair['target'] == 'consumer')
    condition = next(ref for ref in pair['sourceEvidence']
                     if prepared['evidence'][ref]['field'] == 'args'
                     and prepared['evidence'][ref]['path'] == '/where')
    raw = empty(prepared)
    raw['events'] = [{'id': event['id'], 'level': 'supporting', 'reason': 'Recorded selection.',
                      'evidence': event['evidence'][:1]} for event in prepared['payload']['events']]
    raw['links'] = [{'sourceEvidence': [condition], 'consumerEvidence': pair['consumerEvidence'][0],
                     'inputRole': 'selection', 'missingInputs': [],
                     'reason': 'Earlier query constrains the selected record category and date.'}]
    validate(raw, review.schema_for_payload(prepared['payload']))
    result = review.interpret(analysis, prepared, raw)
    assert result['inputBindings'][0]['parents'][0]['inputRole'] == 'selection'


def test_budget_keeps_consumer_parameters_and_branch_before_optional_source_context(monkeypatch):
    analysis = {'traceId': 'bounded-context', 'flow': [], 'calls': [
        {'id': 'source', 'tool': 'search', 'timeIndex': 0,
         'args': {'where': {'category': 'eligible'}},
         'response': {'id': 'selected', 'category': 'eligible'}},
        {'id': 'consumer', 'tool': 'inspect', 'timeIndex': 1,
         'args': {'resource_id': 'selected', 'conditions': [{'category': 'eligible'}]},
         'response': {'finding': 'Observed'}}]}
    limit = review.prepare(analysis)['promptCharacters'] + 1200
    analysis['calls'][0]['args']['context'] = 'long context ' * 1000
    monkeypatch.setattr(review, 'MAX_PROMPT_CHARS', limit)
    prepared = review.prepare(analysis)
    assert prepared['promptCharacters'] <= limit
    pair = next(pair for pair in prepared['pairs'].values() if pair['target'] == 'consumer')
    exposed = {row['id']: row for row in prepared['payload']['evidence']}
    assert {exposed[ref]['path'] for ref in pair['consumerEvidence']} == {'/resource_id', '/conditions'}
    assert all(exposed[ref]['complete'] for ref in pair['consumerEvidence'])
    assert any(exposed[ref]['path'] == '/where' for ref in pair['sourceEvidence'])
    assert prepared['omittedSourceArguments']
    assert all(row['callId'] == 'source' and row['path'] == '/context'
               for row in prepared['omittedSourceArguments'])
    assert set(pair['sourceEvidence'] + pair['consumerEvidence']) <= exposed.keys()


def test_pair_budget_covers_each_consumer_with_late_and_result_consumers_prioritized():
    marker_list = ' '.join(f'marker{chr(97 + index)}' for index in range(9))
    calls = [{'id': f'source-{i}', 'tool': 'read', 'args': {},
              'response': {'content': marker_list}, 'timeIndex': i} for i in range(9)]
    calls.extend({'id': f'consumer-{i}', 'tool': 'lookup', 'args': {'query': f'marker{chr(97 + i)}'},
                  'response': {'ok': True}, 'timeIndex': 9 + i} for i in range(9))
    a = {'traceId': 'many-consumers', 'taskDescription': 'Look up listed markers.',
         'calls': calls, 'flow': [], 'finalOutput': '', 'targetCallIds': ['consumer-0']}
    prepared = review.prepare(a)
    counts = {}
    for pair in prepared['pairs'].values():
        counts[pair['target']] = counts.get(pair['target'], 0) + 1
    assert 0 < len(prepared['pairs']) <= review.MAX_PAIRS
    assert len(counts) == 9
    assert all(count >= 2 for count in counts.values())
    assert prepared['retainedPairConsumers'] == 9


def test_pair_candidates_survive_prompt_budget_before_redundant_activity_refs(monkeypatch):
    monkeypatch.setattr(review, 'MAX_PROMPT_CHARS', 16000)
    calls = [{'id': 'source', 'tool': 'read_note', 'args': {},
              'response': {'content': 'markerneedle is present in the source note.'}, 'timeIndex': 0}]
    calls.extend({'id': f'padding-{i}', 'tool': 'inspect',
                  'args': {'text': f'padding{i} ' * 70},
                  'response': {'receipt': f'operation{i}'}, 'timeIndex': i + 1}
                 for i in range(1, 30))
    calls.append({'id': 'consumer', 'tool': 'lookup', 'args': {'query': 'markerneedle'},
                  'response': {'ok': True}, 'timeIndex': 30})
    a = {'traceId': 'large-review', 'taskDescription': 'Find the marker.', 'calls': calls,
         'flow': [], 'finalOutput': '', 'targetCallIds': ['consumer']}
    prepared = review.prepare(a)
    assert any(pair['source'] == 'source' and pair['target'] == 'consumer'
               for pair in prepared['pairs'].values())
    assert prepared['trimmedEventRefs'] > 0
    assert prepared['promptCharacters'] <= prepared['promptCharacterLimit']




def test_goal_retrieval_keeps_complementary_collections_for_text_argument():
    calls = [
        {'id': 'bad', 'tool': 'inspect_available_stock', 'args': {},
         'response': {'error': 'unavailable'}, 'status': 'error', 'timeIndex': 0},
        {'id': 'stock', 'tool': 'inspect_available_stock', 'args': {},
         'response': [{'item': 'zeta', 'batch': 11}], 'status': 'success', 'timeIndex': 1},
        {'id': 'reserved', 'tool': 'inspect_reserved_stock', 'args': {},
         'response': [], 'status': 'success', 'timeIndex': 2},
        {'id': 'consumer', 'tool': 'write_note', 'args': {'text': 'zeta'},
         'response': {'ok': True}, 'status': 'success', 'timeIndex': 3},
    ]
    analysis = {'traceId': 'generic-inventory', 'taskDescription':
        'Select available stock excluding reserved stock.', 'calls': calls, 'flow': []}
    prepared = review.prepare(analysis)
    pairs = {pair['source']: pair for pair in prepared['pairs'].values() if pair['target'] == 'consumer'}
    assert {'stock', 'reserved'} <= pairs.keys()
    assert 'bad' not in pairs
    assert any(prepared['evidence'][ref]['quote'] == '[]'
               for ref in pairs['reserved']['sourceEvidence'])
    assert not review.interpret(analysis, prepared, empty(prepared))['links']


def test_pair_budget_preserves_a_result_consumers_full_input_bundle(monkeypatch):
    monkeypatch.setattr(review, 'MAX_PAIRS', 12)
    calls = [{'id': f'source-{i}', 'tool': 'observe', 'args': {},
              'response': {'content': 'sharedneedle'}, 'timeIndex': i} for i in range(6)]
    calls.extend({'id': f'consumer-{i}', 'tool': 'lookup', 'args': {'query': 'sharedneedle'},
                  'response': {'ok': True}, 'timeIndex': i + 6} for i in range(6))
    a = {'traceId': 'bundle-budget', 'calls': calls, 'flow': [], 'targetCallIds': ['consumer-0']}
    p = review.prepare(a)
    counts = {}
    for pair in p['pairs'].values():
        counts[pair['target']] = counts.get(pair['target'], 0) + 1
    assert len(p['pairs']) == 12
    assert len(counts) == 6
    assert counts['consumer-0'] == 6


def test_private_source_argument_cannot_explain_an_unrelated_public_consumer():
    a = trace()
    a['calls'][1]['args'] = {'access_token': 'private-state-value'}
    p = review.prepare(a)
    pair = next(pair for pair in p['pairs'].values()
                if pair['source'] == 'source-b' and pair['target'] == 'consumer')
    source = next(ref for ref in pair['sourceEvidence'] if p['evidence'][ref]['path'] == '/access_token')
    raw = empty(p)
    raw['links'] = [{'sourceEvidence': [source], 'consumerEvidence': pair['consumerEvidence'][0],
        'inputRole': 'enabling', 'missingInputs': [],
        'reason': 'This token enabled an earlier producer, not the current public query.'}]
    interpreted = review.interpret(a, p, raw)
    assert not interpreted['links']
    assert len(interpreted['rejectedInputLinks']) == 1

def test_initial_context_chunks_have_unique_refs_and_never_alias_event_evidence():
    a = trace()
    a['initialContext'] = [{'id': 'long-environment', 'role': 'environment',
        'content': 'A' * 4800 + 'C' * 1200}]
    p = review.prepare(a)
    records = {row['id']: row for row in p['payload']['evidence']}
    assert len(records) == len(p['payload']['evidence'])
    for event in p['payload']['events']:
        for ref in event['contextEvidence']:
            assert records[ref]['field'] == 'initialContext'
            assert 'owner' not in records[ref]
    chunks = [row for row in records.values() if row.get('contextId') == 'long-environment']
    assert len(chunks) == 3
    assert len({row['id'] for row in chunks}) == 3
    assert all(not row['complete'] and row['end'] - row['start'] == 600 for row in chunks)


def test_private_state_sources_do_not_crowd_task_operand_goal_retrieval():
    calls = [{'id': 'state', 'tool': 'get_account_credentials', 'args': {},
        'response': {'account_name': 'sample', 'password': 'private'}, 'timeIndex': 0, 'status': 'success'}]
    calls.extend({'id': str(i), 'tool': f'get_collection_{name}', 'args': {},
        'response': [] if i == 3 else [{'item': f'opaque{i}'}], 'status': 'success', 'timeIndex': i+1}
        for i,name in enumerate(['available','reserved','approved','excluded']))
    calls.append({'id': 'consumer', 'tool': 'write', 'args': {'text': 'selected set'},
        'response': {'ok': True}, 'timeIndex': 5})
    a = {'traceId': 'generic-account', 'calls': calls, 'flow': [],
         'taskDescription': 'Select from available, reserved, approved and excluded collections in my account.'}
    p = review.prepare(a)
    candidates = {pair['source'] for pair in p['pairs'].values() if pair['target'] == 'consumer'}
    assert {'0','1','2','3'} <= candidates
    assert 'state' not in candidates

def test_private_argument_handles_stay_in_evidence_but_not_semantic_queries():
    a = trace()
    a['calls'][-1]['args']['access_token'] = 'private-state-value'
    p = review.prepare(a)
    assert '<secret' not in p['embeddingQueries']['consumer']
    assert 'private-state-value' not in p['embeddingQueries']['consumer']
    event = next(event for event in p['payload']['events'] if p['eventRefs'][event['id']] == 'consumer')
    assert any(p['evidence'][ref]['path'] == '/access_token' for ref in event['inputEvidence'])
