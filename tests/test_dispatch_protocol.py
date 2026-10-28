"""Typed literals and prior-output references work for arbitrary tools."""

import jsonschema
import pytest
from dispatch_protocol import (BindingReferenceError, action_schema,
                               decode_action, task_literal_sources,
                               reference_repair_schema, merge_reference_repair)


def tools():
    return [{'function': {'name': 'arbitrary__update', 'parameters': {
        'type': 'object', 'properties': {
            'text': {'type': 'string'}, 'enabled': {'type': 'boolean'},
            'count': {'type': 'integer'}, 'values': {'type': 'array', 'items': {'type': 'string'}},
            'nullable': {'anyOf': [{'type': 'string'}, {'type': 'null'}]},
            'object_value': {'type': 'object'}}}}}]


def action(bindings, tool='arbitrary__update'):
    return {'action': {'kind': 'tool', 'tool': tool, 'arguments': bindings}}


def literal(name, value):
    return {'name': name, 'value': value}


def reference(name, call_id, path):
    return {'name': name, 'from': {'callId': call_id, 'path': path}}


def history(response, call_id='3'):
    return [{'id': call_id, 'response': response}]


def test_typed_literal_values_preserve_quotes_newlines_falsy_and_null():
    values = [literal('text', 'a "quote"\nand \\ path'), literal('enabled', False),
              literal('count', 0), literal('values', []), literal('nullable', None)]
    decision = action(values)
    jsonschema.validate(decision, action_schema(tools(), []))
    decoded = decode_action(decision, [], tools(), [])
    assert decoded['arguments'] == {
        'text': 'a "quote"\nand \\ path', 'enabled': False,
        'count': 0, 'values': [], 'nullable': None}
    assert decoded['argumentSources'] == []


def test_references_preserve_scalar_array_object_falsy_and_null_values():
    response = {'value': {
        'access_token': 'opaque-value', 'flags': [False, 0, None],
        'record': {'name': 'Ada', 'active': False}, 'nullable': None}}
    available = [
        {'name': 'text', 'from': {'callId': '3', 'path': '/value/access_token'}},
        {'name': 'enabled', 'from': {'callId': '3', 'path': '/value/flags/0'}},
        {'name': 'count', 'from': {'callId': '3', 'path': '/value/flags/1'}},
        {'name': 'nullable', 'from': {'callId': '3', 'path': '/value/nullable'}},
        {'name': 'object_value', 'from': {'callId': '3', 'path': '/value/record'}}]
    decision = action(available)
    jsonschema.validate(decision, action_schema(tools(), []))
    decoded = decode_action(decision, history(response), tools(), [])
    assert decoded['arguments'] == {
        'text': 'opaque-value', 'enabled': False, 'count': 0,
        'nullable': None, 'object_value': {'name': 'Ada', 'active': False}}
    assert decoded['argumentSources'] == [
        {'name': 'text', 'callId': '3', 'path': '/value/access_token'},
        {'name': 'enabled', 'callId': '3', 'path': '/value/flags/0'},
        {'name': 'count', 'callId': '3', 'path': '/value/flags/1'},
        {'name': 'nullable', 'callId': '3', 'path': '/value/nullable'},
        {'name': 'object_value', 'callId': '3', 'path': '/value/record'}]


def test_json_pointer_root_and_escaped_keys_resolve_relative_to_response():
    response = {'value': {'a/b~c': {'x': 1}}}
    root_tool = [{'function': {'name': 'arbitrary__root', 'parameters': {
        'type': 'object', 'properties': {'response': {'type': 'object'}}}}}]
    root_decision = action([reference('response', '3', '')], 'arbitrary__root')
    assert decode_action(root_decision, history(response), root_tool, [])['arguments'] == {
        'response': response}

    escaped_tool = [{'function': {'name': 'arbitrary__escaped', 'parameters': {
        'type': 'object', 'properties': {'count': {'type': 'integer'}}}}}]
    escaped_decision = action([reference('count', '3', '/value/a~1b~0c/x')],
                              'arbitrary__escaped')
    decoded = decode_action(escaped_decision, history(response), escaped_tool, [])
    assert decoded['arguments'] == {'count': 1}


def test_referenced_values_are_deep_copied():
    response = {'value': {'record': {'tags': ['original']}}}
    decision = action([reference('object_value', '3', '/value/record')])
    decoded = decode_action(decision, history(response), tools(), [])
    decoded['arguments']['object_value']['tags'].append('changed')
    assert response == {'value': {'record': {'tags': ['original']}}}


def test_mixed_literal_and_reference_bindings():
    tools_ = tools()
    decision = action([literal('text', 'caller supplied'),
                       reference('enabled', '3', '/value/active')])
    jsonschema.validate(decision, action_schema(tools_, []))
    decoded = decode_action(decision, history({'value': {'active': True}}), tools_, [])
    assert decoded['arguments'] == {'text': 'caller supplied', 'enabled': True}
    assert decoded['argumentSources'] == [
        {'name': 'enabled', 'callId': '3', 'path': '/value/active'}]


@pytest.mark.parametrize('call_id', ['missing', 'future-call'])
def test_unknown_or_future_call_reference_is_rejected(call_id):
    decision = action([reference('text', call_id, '/value/text')])
    with pytest.raises(BindingReferenceError, match='not in prior observations'):
        decode_action(decision, history({'value': {'text': 'secret'}}), tools(), [])


@pytest.mark.parametrize('path', ['/value/missing', 'value/text', '/value/bad~2escape'])
def test_missing_or_invalid_json_pointer_is_rejected(path):
    decision = action([reference('text', '3', path)])
    with pytest.raises(BindingReferenceError):
        decode_action(decision, history({'value': {'text': 'secret'}}), tools(), [])


def test_reference_type_mismatch_is_rejected_without_echoing_value():
    secret = 'SENSITIVE-VALUE'
    decision = action([reference('count', '3', '/value/text')])
    with pytest.raises(BindingReferenceError) as error:
        decode_action(decision, history({'value': {'text': secret}}), tools(), [])
    assert secret not in str(error.value)


def test_unknown_argument_and_duplicate_binding_are_rejected():
    with pytest.raises(ValueError, match='not present'):
        decode_action(action([literal('unknown', 1)]), [], tools(), [])
    with pytest.raises(ValueError, match='more than once'):
        decode_action(action([literal('text', 'first'), literal('text', 'second')]), [], tools(), [])


def test_reference_schema_requires_exact_shape_and_rejects_both_forms():
    schema = action_schema(tools(), [])
    invalid = action([{'name': 'text', 'from': {'callId': '3'}}])
    both = action([{'name': 'text', 'value': 'literal',
                    'from': {'callId': '3', 'path': '/value/text'}}])
    for decision in [invalid, both]:
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(decision, schema)


def test_argument_schema_rejects_reference_with_wrong_type_and_does_not_mutate_history():
    response = {'value': {'record': {'name': 'Ada', 'active': False}}}
    decision = action([reference('text', '3', '/value/record')])
    with pytest.raises(BindingReferenceError) as error:
        decode_action(decision, history(response), tools(), [])
    assert 'Ada' not in str(error.value)
    assert response == {'value': {'record': {'name': 'Ada', 'active': False}}}


def test_empty_parameter_list_and_final_response_are_valid():
    empty = [{'function': {'name': 'arbitrary__empty', 'parameters': {
        'type': 'object', 'properties': {}}}}]
    for decision in [
        {'action': {'kind': 'final', 'finalText': 'Done.'}},
        action([], 'arbitrary__empty')]:
        jsonschema.validate(decision, action_schema(empty, []))
        decoded = decode_action(decision, [], empty, [])
        assert decoded['kind'] == decision['action']['kind']


def test_literal_arguments_are_validated_against_discovered_tool_schema():
    with pytest.raises(ValueError, match='Tool arguments do not match'):
        decode_action(action([literal('enabled', 'false')]), [], tools(), [])


def test_task_spans_copy_unicode_punctuation_whitespace_and_newlines_exactly():
    text = 'Use "  α.\nβ!  ", label “雪☃.”, code `x\\y`, and \'KEEP?\'. Don\'t rewrite.'
    sources = task_literal_sources([{'id': 'request', 'text': text}])
    assert [row['text'] for row in sources] == ['  α.\nβ!  ', '雪☃.', 'x\\y', 'KEEP?']
    for row in sources:
        assert text[row['start']:row['end']] == row['text']
        decision = action([{'name': 'text', 'fromTask': row['id']}])
        jsonschema.validate(decision, action_schema(tools(), sources))
        decoded = decode_action(decision, [], tools(), sources)
        assert decoded['arguments']['text'] == row['text']
        assert decoded['argumentSources'] == [{'name': 'text', 'taskLiteralId': row['id'],
            'contextId': 'request', 'start': row['start'], 'end': row['end']}]


def test_empty_task_literal_is_not_confused_with_missing_source():
    sources = task_literal_sources([{'id': 'request', 'text': 'Set it to "".'}])
    assert decode_action(action([{'name': 'text', 'fromTask': 'q0'}]), [], tools(), sources)['arguments'] == {'text': ''}


def test_task_references_are_not_available_without_a_source_and_never_coerce_types():
    decision = action([{'name': 'text', 'fromTask': 'q0'}])
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(decision, action_schema(tools(), []))
    with pytest.raises(BindingReferenceError) as error:
        decode_action(decision, [], tools(), [])
    assert error.value.bindings == ('text',)
    sources = task_literal_sources([{'id': 'request', 'text': 'Use "0".'}])
    with pytest.raises(BindingReferenceError, match='does not match'):
        decode_action(action([{'name': 'count', 'fromTask': 'q0'}]), [], tools(), sources)


def test_computed_text_is_not_silently_replaced_by_a_similar_task_literal():
    sources = task_literal_sources([{'id': 'request', 'text': 'Source "Alpha.".'}])
    decision = action([literal('text', 'Alpha')])
    assert decode_action(decision, [], tools(), sources)['arguments']['text'] == 'Alpha'


def test_reference_repair_preserves_valid_text_while_correcting_multiple_bad_inputs():
    original = action([literal('text', 'α.\nKEEP!'),
        reference('count', '3', '/response/value/count'),
        reference('enabled', 'missing', '/value/enabled')])
    observations = history({'value': {'count': 0, 'enabled': False}})
    with pytest.raises(BindingReferenceError) as error:
        decode_action(original, observations, tools(), [])
    assert error.value.bindings == ('count', 'enabled')
    correction = action([reference('count', '3', '/value/count'), reference('enabled', '3', '/value/enabled')])
    jsonschema.validate(correction, reference_repair_schema(original, error.value.bindings, tools(), []))
    merged = merge_reference_repair(original, correction, error.value.bindings)
    assert merged['action']['arguments'][0] == original['action']['arguments'][0]
    assert decode_action(merged, observations, tools(), [])['arguments'] == {
        'text': 'α.\nKEEP!', 'count': 0, 'enabled': False}
    assert original['action']['arguments'][1]['from']['path'] == '/response/value/count'


@pytest.mark.parametrize('bad', [
    action([literal('count', 1), literal('text', 'changed')]),
    action([literal('count', 1), literal('count', 2)]),
    action([]),
    action([literal('enabled', True)]),
    action([literal('count', 1)], 'another__tool'),
    {'action': {'kind': 'final', 'finalText': 'Done.'}},
])
def test_reference_repair_cannot_change_tool_valid_fields_or_omit_rejected_field(bad):
    original = action([literal('text', 'KEEP.'), reference('count', 'bad', '')])
    with pytest.raises(ValueError):
        merge_reference_repair(original, bad, ['count'])
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(bad, reference_repair_schema(original, ['count'], tools(), []))
