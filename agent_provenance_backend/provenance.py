"""One evidence graph builder for cleaned tool calls and participant activities."""

from __future__ import annotations

from urllib.parse import quote
from typing import Any
from collections import defaultdict, deque
import re

PARENT_KEYS = ("parent_call_id", "parentCallId", "parent_call_ids", "parentCallIds")
RESOURCE_KEYS = {"id", "path", "url", "uri", "artifact_id", "file_id"}
CONTEXT_FIELDS = ('eventType', 'agentId', 'role', 'round', 'phase', 'source', 'diagnostics', 'patterns')
_NUMERIC_ID = re.compile(r'[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?')
_RESOURCE_ARGUMENT = re.compile(r'(?:^|[_-])(?:ids?|path|url|uri)$|(?:Id|ID|Ids|IDs)$')


def normalize_calls(raw_calls: Any, trace_id: Any) -> list[dict[str, Any]]:
    calls, used = [], set()
    for index, raw in enumerate(raw_calls if isinstance(raw_calls, list) else []):
        if not isinstance(raw, dict):
            continue
        tool = raw.get("tool", raw.get("name"))
        if not isinstance(tool, str) or not tool:
            continue
        source_id = raw.get("id")
        identifier = str(source_id) if source_id is not None else str(index)
        unique_id, suffix = identifier, 1
        while unique_id in used:
            unique_id, suffix = f"{identifier}#{suffix}", suffix + 1
        used.add(unique_id)
        calls.append({"id": unique_id, "sourceId": source_id, "tool": tool,
                      "args": raw.get("args"), "response": raw.get("response"),
                      "status": raw.get("status"), "timeIndex": index,
                      "traceId": str(trace_id), "parentCallIds": _parents(raw)})
        for field in ('eventType', 'agentId', 'role', 'round', 'phase', 'source', 'diagnostics', 'patterns',
                      'timestamp', 'startedAt', 'endedAt', 'sequence'):
            if field in raw:
                calls[-1][field] = raw[field]
    return calls


def _parents(call: dict[str, Any]) -> list[str]:
    result = []
    for key in PARENT_KEYS:
        value = call.get(key)
        for item in value if isinstance(value, list) else [value]:
            if item is not None and str(item) not in result:
                result.append(str(item))
    return result


def _resource_values(value: Any, path: str = "") -> list[tuple[str, str]]:
    found = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}/{_pointer_part(str(key))}"
            if key in RESOURCE_KEYS and isinstance(child, (str, int, float)) and not isinstance(child, bool):
                found.append((child_path, str(child)))
            found.extend(_resource_values(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found.extend(_resource_values(child, f"{path}/{index}"))
    return found


def _pointer_part(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


def _contains_exact(value: Any, needle: str, key: str = '') -> bool:
    if isinstance(value, dict):
        return any(_contains_exact(child, needle, str(name)) for name, child in value.items())
    if isinstance(value, list):
        return any(_contains_exact(child, needle, key) for child in value)
    return (isinstance(value, (str, int, float)) and not isinstance(value, bool) and str(value) == needle
            and (not _NUMERIC_ID.fullmatch(needle) or bool(_RESOURCE_ARGUMENT.search(key))))


def _pointer_value(value, path):
    """Resolve an exact JSON pointer declared by the input's cleaning schema."""
    if path and not path.startswith('/'):
        raise ValueError('Reference paths must be JSON pointers.')
    for part in path.split('/')[1:] if path else []:
        part = part.replace('~1', '/').replace('~0', '~')
        if value is None or isinstance(value, dict) and part not in value:
            return None
        if isinstance(value, list):
            if not part.isdecimal():
                return None
            index = int(part)
            if index < 0 or index >= len(value):
                return None
            value = value[index]
        elif isinstance(value, dict):
            value = value[part]
        else:
            return None
    if value is None:
        return None
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        raise ValueError('A declared resource reference must identify a scalar value.')
    return str(value)


def declared_resources(call, schema, side):
    """Yield typed references; tool names and field paths belong to data, not code."""
    field = 'response' if side == 'outputs' else 'args'
    for kind, rule in schema.items():
        scope = rule.get('scope', 'trace')
        if scope not in {'trace', 'actor'}:
            raise ValueError('Reference scope must be trace or actor.')
        paths = rule.get(side, {}).get(call['tool'], [])
        for path in paths:
            value = _pointer_value(call.get(field), path)
            if value is None:
                continue
            identity = (kind, call.get('agentId') if scope == 'actor' else None, value)
            yield identity, path, value


def output_resources(call, schema=None):
    if schema is None:
        return _resource_values(call.get('response'))
    return [(path, value) for _, path, value in declared_resources(call, schema, 'outputs')]


def assert_acyclic(node_ids, links):
    outgoing, incoming = defaultdict(list), dict.fromkeys(node_ids, 0)
    for link in links:
        outgoing[link['source']].append(link['target'])
        incoming[link['target']] += 1
    queue = deque(cid for cid, count in incoming.items() if count == 0)
    visited = 0
    while queue:
        visited += 1
        for target in outgoing[queue.popleft()]:
            incoming[target] -= 1
            if incoming[target] == 0:
                queue.append(target)
    if visited != len(incoming):
        raise ValueError('Recorded dependencies must be acyclic.')


def build_recorded_graph(calls, links=None, reference_schema=None):
    """Preserve declared links and optional schema-directed resource references.

    Cleaned event links are authoritative. The conventional tool-output schema
    is used for tool transcripts without declared links; arbitrary formats can
    provide typed JSON-pointer mappings through reference_schema.
    """
    trace = str(calls[0].get("traceId", "trace")) if calls else "trace"
    namespace = quote(trace, safe="")
    nodes, edges, occurrences = [], [], []
    by_id: dict[str, list[int]] = {}
    latest_resources = {}
    for position, call in enumerate(calls):
        call_id = str(call.get("id", position))
        occurrence = quote(call_id, safe='') if call.get('eventType') else f"{position}:{quote(call_id, safe='')}"
        activity_id, entity_id = f"act:{namespace}:{occurrence}", f"ent:{namespace}:{occurrence}"
        occurrences.append((activity_id, entity_id))
        by_id.setdefault(call_id, []).append(position)
        source_id = call.get("sourceId")
        if source_id is not None and str(source_id) != call_id:
            by_id.setdefault(str(source_id), []).append(position)
        nodes.extend([
            {"id": activity_id, "kind": "Activity", "toolCallId": call_id,
             "tool": call.get("tool"), "timeIndex": position, "args": call.get("args"),
             "status": call.get("status"), "traceId": trace,
             **{key: call[key] for key in CONTEXT_FIELDS if key in call}},
            {"id": entity_id, "kind": "Entity", "entityType": call.get('eventType', 'tool_output'),
             "response": call.get("response"), "traceId": trace,
             **({'source': call.get('source')} if call.get('eventType') else {})},
        ])
        edges.append({"source": activity_id, "target": entity_id, "relation": "generatedBy",
                      "inferred": False, "evidence": [{"kind": "recorded",
                          **({'source': call.get('source')} if call.get('eventType') else {})}]})

    positions = {call['id']: i for i, call in enumerate(calls)}
    declared_pairs = set()
    for link in links or []:
        if link['source'] not in positions or link['target'] not in positions:
            raise ValueError('Evidence links must reference existing activities.')
        source, target = positions[link['source']], positions[link['target']]
        if ('round' in calls[source] and 'round' in calls[target]
                and calls[source]['round'] > calls[target]['round']):
            raise ValueError('Evidence cannot flow to an earlier round.')
        declared_pairs.add((link['source'], link['target']))
        relation = link.get('relation')
        details = {'kind': 'semantic' if link.get('inferred') else 'recorded',
                   'details': link.get('evidence', [])}
        if relation is not None:
            details['relation'] = relation
        if link.get('evidenceLevel') is not None:
            details['evidenceLevel'] = link['evidenceLevel']
        edges.append({'source': occurrences[source][1], 'target': occurrences[target][0],
                      'relation': 'usedBy', 'inferred': bool(link.get('inferred')),
                      'evidence': [details],
                      **({'eventRelation': relation} if relation is not None else {}),
                      **({'evidenceLevel': link['evidenceLevel']} if link.get('evidenceLevel') is not None else {}),
                      **({'evidenceRole': link['evidenceRole']} if 'evidenceRole' in link else {})})

    for position, call in enumerate(calls):
        target_activity = occurrences[position][0]
        for parent in call.get("parentCallIds", []):
            if (parent, call['id']) in declared_pairs:
                continue
            matches = by_id.get(str(parent), [])
            # Explicit occurrence references do not depend on serialization order.
            # Repeated source IDs are ambiguous until a unique occurrence is named.
            if len(matches) == 1:
                parent_position = matches[0]
                edges.append({"source": occurrences[parent_position][1], "target": target_activity,
                              "relation": "usedBy", "inferred": False,
                              "evidence": [{"kind": "recorded", "reference": str(parent)}]})
        if reference_schema is not None:
            for identity, target_path, value in declared_resources(call, reference_schema, 'inputs'):
                if identity not in latest_resources:
                    continue
                source_entity, source_path = latest_resources[identity]
                edges.append({'source': source_entity, 'target': target_activity,
                              'relation': 'usedBy', 'inferred': False,
                              'evidence': [{'kind': 'reference', 'sourcePath': source_path,
                                            'targetPath': target_path, 'resourceKind': identity[0], 'value': value}]})
        elif links is None:
            for value, (source_entity, path) in latest_resources.items():
                if not _contains_exact(call.get("args"), value):
                    continue
                edges.append({"source": source_entity, "target": target_activity,
                              "relation": "usedBy", "inferred": False,
                              "evidence": [{"kind": "reference", "sourcePath": path, "value": value}]})
        entity_id = occurrences[position][1]
        if reference_schema is not None:
            for identity, path, _ in declared_resources(call, reference_schema, 'outputs'):
                latest_resources[identity] = (entity_id, path)
        elif links is None:
            for path, value in output_resources(call):
                latest_resources[value] = (entity_id, path)
    graph = {"nodes": nodes, "edges": edges}
    assert_acyclic([call['id'] for call in calls], call_flow(graph))
    return graph


def project_dependencies(analysis):
    """Project dependencies and reviewed context into inspectable provenance edges."""
    from evidence_context import display_links
    return build_recorded_graph(
        analysis.get('calls', []),
        links=display_links(analysis),
        reference_schema=analysis.get('referenceSchema'),
    )


def call_flow(graph: dict[str, Any]) -> list[dict[str, Any]]:
    nodes = {node["id"]: node for node in graph.get("nodes", [])}
    activity_by_entity = {edge["target"]: nodes[edge["source"]].get("toolCallId")
                          for edge in graph.get("edges", [])
                          if edge.get("relation") == "generatedBy" and edge.get("source") in nodes}
    result = []
    for edge in graph.get("edges", []):
        if edge.get("relation") == "usedBy":
            result.append({"source": activity_by_entity.get(edge.get("source")),
                           "target": nodes.get(edge.get("target"), {}).get("toolCallId"),
                           "inferred": edge.get("inferred", False),
                           "evidence": edge.get("evidence")})
            if edge.get('eventRelation'):
                result[-1]['relation'] = edge['eventRelation']
            for field in ('evidenceLevel', 'evidenceRole'):
                if edge.get(field) is not None:
                    result[-1][field] = edge[field]
    return result
