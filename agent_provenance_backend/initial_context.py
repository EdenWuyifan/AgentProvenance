"""Normalize source-provided context messages for trace analysis."""

import json


def _content(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    if isinstance(value, (dict, list, int, float, bool)) or value is None:
        return value
    raise ValueError('Initial context content must be text or JSON data.')


def normalize_initial_context(entry):
    context = []
    canonical = entry.get('initialContext', [])
    messages = entry.get('initialMessages', [])
    if not isinstance(canonical, list) or not isinstance(messages, list):
        raise ValueError('initialContext and initialMessages must be lists.')

    for item in canonical:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not item['id'] or 'content' not in item:
            raise ValueError('Each initialContext item needs a nonempty string id.')
        role = item.get('role')
        if not isinstance(role, str) or not role:
            raise ValueError('Each initialContext item needs a nonempty string role.')
        row = {'id': item['id'], 'role': role, 'content': _content(item.get('content'))}
        if item.get('agentId') is not None:
            if not isinstance(item['agentId'], str) or not item['agentId']:
                raise ValueError('initialContext agentId must be a nonempty string.')
            row['agentId'] = item['agentId']
        context.append(row)

    for index, item in enumerate(messages):
        if not isinstance(item, dict) or not isinstance(item.get('sender'), str) or not item['sender'] or 'content' not in item:
            raise ValueError('Each initialMessages item needs sender and content.')
        recipient = item.get('recipient')
        role = item['sender'] if recipient is None else f"{item['sender']} -> {recipient}"
        row = {'id': item.get('id') or f'initialMessages:{index}', 'role': role,
               'content': _content(item['content'])}
        if not isinstance(row['id'], str) or not row['id']:
            raise ValueError('initialMessages id must be a nonempty string.')
        if item.get('agentId') is not None:
            if not isinstance(item['agentId'], str) or not item['agentId']:
                raise ValueError('initialMessages agentId must be a nonempty string.')
            row['agentId'] = item['agentId']
        context.append(row)

    if entry.get('taskDescription') and not any(
            row['role'] == 'task' and row['content'] == entry['taskDescription'] for row in context):
        context.append({'id': 'taskDescription', 'role': 'task', 'content': entry['taskDescription']})

    ids = [row['id'] for row in context]
    if len(ids) != len(set(ids)):
        raise ValueError('Initial context IDs must be unique.')
    return context
