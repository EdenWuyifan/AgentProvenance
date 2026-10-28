"""Typed actions with exact task-text and prior-output references."""

from copy import deepcopy
import re

import jsonschema


class BindingReferenceError(ValueError):
    """A prior-output reference could not be resolved or type-checked."""

    def __init__(self, message, bindings=()):
        super().__init__(message)
        self.bindings = tuple(bindings)


def task_literal_sources(contexts):
    """Index quoted spans; selecting a span does not infer its semantic role."""
    pattern = re.compile(r'"((?:\\.|[^"\\])*)"|“([^”]*)”|`([^`]*)`|(?<!\w)\'([^\']*)\'(?!\w)', re.S)
    sources = []
    for context in contexts:
        for match in pattern.finditer(context['text']):
            group = next(index for index in range(1, 5) if match.group(index) is not None)
            start, end = match.span(group)
            sources.append({'id': f'q{len(sources)}', 'contextId': context['id'],
                            'start': start, 'end': end, 'text': context['text'][start:end]})
    return sources


def _strict(schema):
    result = deepcopy(schema)
    result.pop('default', None)
    if result.get('type') == 'object':
        result['additionalProperties'] = False
        result['required'] = list(result.get('properties', {}))
        result['properties'] = {key: _strict(value)
                                for key, value in result.get('properties', {}).items()}
    if 'items' in result:
        result['items'] = _strict(result['items'])
    if 'anyOf' in result:
        result['anyOf'] = [_strict(value) for value in result['anyOf']]
    return result


def action_schema(tools, task_literals):
    variants = []
    for tool in tools:
        function = tool['function']
        bindings = []
        for name, value in function['parameters'].get('properties', {}).items():
            name_schema = {'type': 'string', 'enum': [name]}
            if task_literals:
                bindings.append({'type': 'object', 'additionalProperties': False,
                    'required': ['name', 'fromTask'], 'properties': {
                        'name': name_schema, 'fromTask': {'type': 'string',
                            'enum': [row['id'] for row in task_literals]}}})
            bindings.extend([
                {'type': 'object', 'additionalProperties': False,
                 'required': ['name', 'value'], 'properties': {
                     'name': name_schema, 'value': _strict(value)}},
                {'type': 'object', 'additionalProperties': False,
                 'required': ['name', 'from'], 'properties': {
                     'name': name_schema, 'from': {
                         'type': 'object', 'additionalProperties': False,
                         'required': ['callId', 'path'], 'properties': {
                             'callId': {'type': 'string'}, 'path': {'type': 'string'}}}}}
            ])
        parameters = {'type': 'array', 'items': {'anyOf': bindings}} if bindings else {
            'type': 'array', 'maxItems': 0, 'items': {'type': 'string'}}
        variants.append({'type': 'object', 'additionalProperties': False,
            'description': function.get('description', ''),
            'required': ['kind', 'tool', 'arguments'], 'properties': {
                'kind': {'type': 'string', 'enum': ['tool']},
                'tool': {'type': 'string', 'enum': [function['name']]},
                'arguments': parameters}})
    variants.append({'type': 'object', 'additionalProperties': False,
        'required': ['kind', 'finalText'], 'properties': {
            'kind': {'type': 'string', 'enum': ['final']}, 'finalText': {'type': 'string'}}})
    return {'type': 'object', 'additionalProperties': False, 'required': ['action'],
            'properties': {'action': {'anyOf': variants}}}


def _pointer_value(document, path):
    if path == '':
        return document
    if not path.startswith('/'):
        raise BindingReferenceError('Reference path must be a JSON Pointer.')
    value = document
    for token in path[1:].split('/'):
        if re.search(r'~(?![01])', token):
            raise BindingReferenceError('Reference path has an invalid JSON Pointer escape.')
        token = token.replace('~1', '/').replace('~0', '~')
        if isinstance(value, dict):
            if token not in value:
                raise BindingReferenceError('Reference path does not exist.')
            value = value[token]
        elif isinstance(value, list):
            if not re.fullmatch(r'0|[1-9][0-9]*', token):
                raise BindingReferenceError('Reference array index does not exist.')
            index = int(token)
            if index >= len(value):
                raise BindingReferenceError('Reference array index does not exist.')
            value = value[index]
        else:
            raise BindingReferenceError('Reference path does not exist.')
    return value


def _tool_function(tools, name):
    for tool in tools:
        if tool['function']['name'] == name:
            return tool['function']
    raise ValueError('Tool is not present in the discovered tool list.')


def decode_action(decision, history, tools, task_literals):
    action = decision['action']
    if action['kind'] == 'final':
        return action

    function = _tool_function(tools, action['tool'])
    properties = function['parameters'].get('properties', {})
    history_by_id = {call['id']: call for call in history}
    task_by_id = {row['id']: row for row in task_literals}
    arguments = {}
    argument_sources = []
    seen = set()
    errors = []
    for binding in action['arguments']:
        name = binding['name']
        if name in seen:
            raise ValueError('Argument name is bound more than once.')
        seen.add(name)
        if name not in properties:
            raise ValueError('Argument name is not present in the discovered tool schema.')
        if 'value' in binding:
            value = binding['value']
        else:
            try:
                if 'fromTask' in binding:
                    source = task_by_id.get(binding['fromTask'])
                    if source is None:
                        raise BindingReferenceError('Task literal source is not present.')
                    value = source['text']
                    provenance = {'name': name, 'taskLiteralId': source['id'],
                        'contextId': source['contextId'], 'start': source['start'], 'end': source['end']}
                else:
                    source = binding['from']
                    call = history_by_id.get(source['callId'])
                    if call is None:
                        raise BindingReferenceError('Reference call is not in prior observations.')
                    value = deepcopy(_pointer_value(call['response'], source['path']))
                    provenance = {'name': name, 'callId': source['callId'], 'path': source['path']}
                jsonschema.validate(value, properties[name])
            except jsonschema.ValidationError:
                errors.append((name, 'Referenced value does not match the argument schema.'))
                continue
            except BindingReferenceError as error:
                errors.append((name, str(error)))
                continue
            argument_sources.append(provenance)
        arguments[name] = value

    if errors:
        raise BindingReferenceError('; '.join(f'{name}: {message}' for name, message in errors),
                                    [name for name, _ in errors])

    try:
        jsonschema.validate(arguments, function['parameters'])
    except jsonschema.ValidationError:
        raise ValueError('Tool arguments do not match the discovered tool schema.') from None
    return {'kind': 'tool', 'tool': action['tool'], 'arguments': arguments,
            'argumentSources': argument_sources}


def reference_repair_schema(decision, invalid_bindings, tools, task_literals):
    """The correction can mention only invalid fields on the original tool."""
    function = deepcopy(_tool_function(tools, decision['action']['tool']))
    function['parameters']['properties'] = {name: schema for name, schema in
        function['parameters']['properties'].items() if name in invalid_bindings}
    function['parameters']['required'] = list(invalid_bindings)
    schema = action_schema([{'function': function}], task_literals)
    variants = schema['properties']['action']['anyOf']
    del variants[1:]
    arguments = variants[0]['properties']['arguments']
    arguments['minItems'] = arguments['maxItems'] = len(invalid_bindings)
    return schema


def merge_reference_repair(original, correction, invalid_bindings):
    """Keep all valid bindings byte-for-byte; replace the rejected bindings only."""
    before, after = original['action'], correction['action']
    if after['kind'] != 'tool' or after['tool'] != before['tool']:
        raise ValueError('Reference repair must keep the original tool.')
    replacements = {binding['name']: binding for binding in after['arguments']}
    if (len(replacements) != len(after['arguments'])
            or set(replacements) != set(invalid_bindings)):
        raise ValueError('Reference repair must replace each invalid binding exactly once.')
    result = deepcopy(original)
    result['action']['arguments'] = [deepcopy(replacements[binding['name']])
        if binding['name'] in replacements else binding for binding in result['action']['arguments']]
    return result
