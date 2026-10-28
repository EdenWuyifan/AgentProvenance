import sys
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / 'agent_provenance_backend'))

from evidence_records import EvidenceAliases, RecordEvidence, containing_record


def test_render_aliases_redact_without_building_copy_indexes():
    aliases = EvidenceAliases()
    safe = aliases._safe({'email': 'Alex@example.com', 'access_token': 'private-token'})
    assert safe == {'email': '<email_1>', 'access_token': '<secret_token_1>'}
    assert not hasattr(aliases, '_copy_index')


def test_arguments_keep_complementary_numeric_inputs_separate():
    index = RecordEvidence({'calls': []})
    evidence = index.arguments({'args': {'temperature': 21, 'humidity': 48}})
    assert [(item['path'], item['quote']) for item in evidence] == [
        ('/temperature', '21'), ('/humidity', '48')]


def test_email_alias_is_stable_between_outputs_arguments_and_copy_candidates():
    analysis = {'calls': [
        {'id': 'source', 'response': {'value': {'recipient_email': 'alex@example.com'}}},
        {'id': 'send', 'args': {'recipient': 'alex@example.com'}},
    ]}
    index = RecordEvidence(analysis)
    source = index.outputs(analysis['calls'][0])[0]
    consumer = index.arguments(analysis['calls'][1])[0]
    assert 'alex@example.com' not in source['quote'] + consumer['quote']
    assert '<email_1>' in source['quote'] and '<email_1>' in consumer['quote']
    candidates = index.copies(analysis['calls'][1], {'source'})
    assert candidates == [{'sourceCallId': 'source', 'sourcePath': '/value/recipient_email',
                           'targetPath': '/recipient', 'quote': '<email_1>'}]


def test_message_record_keeps_sender_and_request_content_together():
    index = RecordEvidence({'calls': []})
    records = index.outputs({'response': [{'sender': 'Morgan', 'content': 'Please review the draft.'}]})
    assert len(records) == 1
    assert records[0]['complete'] is True
    assert records[0]['collectionLength'] == 1
    assert 'Morgan' in records[0]['quote'] and 'Please review the draft.' in records[0]['quote']
    assert containing_record(records, '/0/content') is records[0]


def test_large_collections_keep_cardinality_and_opaque_secret_fields():
    index = RecordEvidence({'calls': []})
    records = index.outputs({'response': {'results': [
        {'id': 'r1', 'value': 'first'}, {'id': 'r2', 'value': 'second'}],
        'access_token': 'do-not-expose', 'author': 'Casey'}})
    result_records = [record for record in records if record.get('collectionPath')]
    assert len(result_records) == 2
    assert all(record['collectionPath'] == '/results' for record in result_records)
    assert all(record['collectionLength'] == 2 for record in result_records)
    assert any(record['path'] == '/author' and 'Casey' in record['quote'] for record in records)
    quotes = ''.join(record['quote'] for record in records)
    assert 'access_token' in quotes and '<secret_token_1>' in quotes
    assert 'do-not-expose' not in quotes
    assert any(record['path'] == '/author' and 'Casey' in record['quote'] for record in records)


def test_long_scalar_is_explicitly_partial():
    records = RecordEvidence({'calls': []}).outputs({'response': 'x' * 2500})
    assert [len(record['quote']) for record in records] == [2400, 100]
    assert all(not record['complete'] for record in records)
    assert [(record['start'], record['end']) for record in records] == [(0, 2400), (2400, 2500)]


def test_compact_conditions_argument_is_kept_as_one_complete_container():
    records = RecordEvidence({'calls': []}).arguments({'args': {
        'conditions': [{'field': 'status', 'operator': 'equals', 'value': 'open'}]}})
    assert len(records) == 1
    assert records[0]['path'] == '/conditions'
    assert records[0]['complete'] is True
    assert 'status' in records[0]['quote'] and 'equals' in records[0]['quote']


def test_nested_sender_and_request_stay_in_one_output_record():
    records = RecordEvidence({'calls': []}).outputs({'response': {
        'sender': {'name': 'Morgan', 'email': 'morgan@example.com'},
        'request': {'message': 'Review this draft.'}}})
    assert len(records) == 1
    assert records[0]['complete'] is True
    assert 'Morgan' in records[0]['quote'] and 'Review this draft.' in records[0]['quote']
    assert 'morgan@example.com' not in records[0]['quote']
    assert containing_record(records, '/request/message') is records[0]


def test_copies_use_exact_case_sensitive_url_identity_and_do_not_mutate_trace():
    analysis = {'calls': [
        {'id': 'source', 'response': {'url': 'https://example.test/Case'}},
        {'id': 'consumer', 'args': {'url': 'https://example.test/Case'}},
    ]}
    original = deepcopy(analysis)
    index = RecordEvidence(analysis)
    result = index.copies({'args': {'url': 'https://example.test/Case',
                                    'other_url': 'https://example.test/case'}}, {'source'})
    assert result == [{'sourceCallId': 'source', 'sourcePath': '/url', 'targetPath': '/url',
                       'quote': '<url_1>'}]
    assert 'https://example.test/Case' not in result[0]['quote']
    assert analysis == original


def test_numeric_copy_candidates_require_identifier_context():
    analysis = {'calls': [
        {'id': 'source', 'response': {'count': 42, 'resource_id': 42}},
    ]}
    index = RecordEvidence(analysis)
    assert index.copies({'args': {'amount': 42}}, {'source'}) == []
    candidates = index.copies({'args': {'resource_id': 42}}, {'source'})
    assert candidates == [{'sourceCallId': 'source', 'sourcePath': '/resource_id',
                           'targetPath': '/resource_id', 'quote': '42'}]


def test_secret_handles_match_exact_same_kind_without_exposing_values():
    analysis = {'calls': [
        {'id': 'login_a', 'response': {'access_token': 'token-A-private'}},
        {'id': 'login_b', 'response': {'access_token': 'token-B-private'}},
        {'id': 'protected', 'args': {'access_token': 'token-A-private',
                                     'api_key': 'token-A-private'}},
    ]}
    index = RecordEvidence(analysis)
    outputs = index.outputs(analysis['calls'][0]) + index.outputs(analysis['calls'][1])
    args = index.arguments(analysis['calls'][2])
    candidates = index.copies(analysis['calls'][2], {'login_a', 'login_b'})
    visible = ''.join(record['quote'] for record in outputs + args + [
        {'quote': candidate['quote']} for candidate in candidates])

    assert 'token-A-private' not in visible and 'token-B-private' not in visible
    assert '<secret_token_1>' in visible and '<secret_token_2>' in visible
    assert all(item['sensitivity'] == 'secret' for item in candidates)
    assert {item['sourceCallId'] for item in candidates} == {'login_a'}
    assert {item['sourcePath'] for item in candidates} == {'/access_token'}
    assert all(item['quote'] == '<secret_token_1>' for item in candidates)


def test_secret_handles_are_trace_local_and_do_not_become_public_candidates():
    first = RecordEvidence({'calls': [{'id': 'one', 'response': {'api_key': 'shared-private'}}]})
    second = RecordEvidence({'calls': [{'id': 'two', 'response': {'api_key': 'shared-private'}}]})
    assert first.outputs({'response': {'api_key': 'shared-private'}})[0]['quote'] == '{"api_key":"<secret_auth_1>"}'
    assert second.outputs({'response': {'api_key': 'shared-private'}})[0]['quote'] == '{"api_key":"<secret_auth_1>"}'
    # A secret value must not be equated to a task-facing public string with the same contents.
    mixed = RecordEvidence({'calls': [
        {'id': 'secret', 'response': {'access_token': 'same-value'}},
        {'id': 'public', 'response': {'name': 'same-value'}},
    ]})
    assert mixed.copies({'args': {'name': 'same-value'}}, {'secret'}) == []
    assert mixed.copies({'args': {'access_token': 'same-value'}}, {'public'}) == []


def test_nested_secret_values_are_opaque_units_and_never_public_copy_candidates():
    credentials = {'profile': {'name': 'Nested Private Name', 'resource_id': 'nested-id-private'},
                   'recipients': [{'email': 'nested@example.test'}]}
    token_bundle = ['token-part-one-private', {'resource_id': 'nested-id-private'}]
    analysis = {'calls': [
        {'id': 'source', 'response': {
            'credentials': credentials, 'token_bundle': token_bundle,
            'author': 'Visible Author', 'resource_id': 'public-resource-7'}},
        {'id': 'consumer', 'args': {
            'credentials': credentials, 'token_bundle': token_bundle,
            'resource_id': 'public-resource-7'}},
    ]}
    index = RecordEvidence(analysis)
    source_records = index.outputs(analysis['calls'][0])
    consumer_records = index.arguments(analysis['calls'][1])
    visible = ''.join(record['quote'] for record in source_records + consumer_records)
    assert all(secret not in visible for secret in (
        'Nested Private Name', 'nested-id-private', 'nested@example.test',
        'token-part-one-private'))
    assert '<secret_credential_1>' in visible
    assert '<secret_token_1>' in visible
    assert any('Visible Author' in record['quote'] for record in source_records)

    candidates = index.copies(analysis['calls'][1], {'source'})
    assert {(item['sourcePath'], item['targetPath'], item['sensitivity'])
            for item in candidates if item.get('sensitivity') == 'secret'} == {
                ('/credentials', '/credentials', 'secret'),
                ('/token_bundle', '/token_bundle', 'secret'),
            }
    assert all(item['sourcePath'] not in {
        '/credentials/profile/name', '/credentials/profile/resource_id',
        '/credentials/recipients/0/email', '/token_bundle/0',
        '/token_bundle/1/resource_id'} for item in candidates)
    assert any(item['sourcePath'] == '/resource_id' and item['quote'] == 'public-resource-7'
               for item in candidates)


def test_empty_collection_is_observed_evidence_at_its_exact_scope():
    records = RecordEvidence({'calls': []}).outputs({'response': {
        'value': [], 'page': 3, 'has_more': True}})
    empty = next(record for record in records if record['path'] == '/value')
    assert empty == {'path': '/value', 'quote': '[]', 'complete': True,
                     'collectionPath': '/value', 'collectionLength': 0}
    assert any(record['path'] == '/has_more' and record['quote'] == 'true' for record in records)
    assert RecordEvidence({'calls': []}).outputs({'response': []})[0]['path'] == ''


def test_state_only_producers_are_separate_from_data_with_sensitive_metadata():
    analysis = {'calls': [
        {'id': 'credentials', 'tool': 'read_accounts', 'response': [
            {'account_name': 'sample', 'password': 'hidden'}]},
        {'id': 'data', 'tool': 'read_records', 'response': {
            'content': 'Observed task data', 'metadata': {'access_token': 'hidden'}}}]}
    assert RecordEvidence(analysis).private_sources == {'credentials'}
