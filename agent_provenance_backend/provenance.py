"""Recorded evidence graph construction for tool-call traces."""

from __future__ import annotations

from urllib.parse import quote
from typing import Any

PARENT_KEYS = ("parent_call_id", "parentCallId", "parent_call_ids", "parentCallIds")
RESOURCE_KEYS = {"id", "path", "url", "uri", "artifact_id", "file_id"}


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
        for field in ('eventType', 'agentId', 'role', 'round', 'phase', 'source', 'diagnostics', 'patterns'):
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


def _contains_exact(value: Any, needle: str) -> bool:
    if isinstance(value, dict):
        return any(_contains_exact(child, needle) for child in value.values())
    if isinstance(value, list):
        return any(_contains_exact(child, needle) for child in value)
    return isinstance(value, (str, int, float)) and not isinstance(value, bool) and str(value) == needle


def build_recorded_graph(calls: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    trace = str(calls[0].get("traceId", "trace")) if calls else "trace"
    namespace = quote(trace, safe="")
    nodes, edges, occurrences = [], [], []
    by_id: dict[str, list[int]] = {}
    latest_resources: dict[str, tuple[str, str]] = {}
    for position, call in enumerate(calls):
        call_id = str(call.get("id", position))
        occurrence = f"{position}:{quote(call_id, safe='')}"
        activity_id, entity_id = f"act:{namespace}:{occurrence}", f"ent:{namespace}:{occurrence}"
        occurrences.append((activity_id, entity_id))
        by_id.setdefault(call_id, []).append(position)
        source_id = call.get("sourceId")
        if source_id is not None and str(source_id) != call_id:
            by_id.setdefault(str(source_id), []).append(position)
        nodes.extend([
            {"id": activity_id, "kind": "Activity", "toolCallId": call_id,
             "tool": call.get("tool"), "timeIndex": position, "args": call.get("args"),
             "status": call.get("status"), "traceId": trace},
            {"id": entity_id, "kind": "Entity", "entityType": "tool_output",
             "response": call.get("response"), "traceId": trace},
        ])
        edges.append({"source": activity_id, "target": entity_id, "relation": "generatedBy",
                      "inferred": False, "evidence": [{"kind": "recorded"}]})

    for position, call in enumerate(calls):
        target_activity = occurrences[position][0]
        for parent in call.get("parentCallIds", []):
            prior = [i for i in by_id.get(str(parent), []) if i < position]
            if prior:
                parent_position = prior[-1]
                edges.append({"source": occurrences[parent_position][1], "target": target_activity,
                              "relation": "usedBy", "inferred": False,
                              "evidence": [{"kind": "recorded", "reference": str(parent)}]})
        for value, (source_entity, path) in latest_resources.items():
            if _contains_exact(call.get("args"), value):
                edges.append({"source": source_entity, "target": target_activity,
                              "relation": "usedBy", "inferred": False,
                              "evidence": [{"kind": "reference", "sourcePath": path, "value": value}]})
        entity_id = occurrences[position][1]
        for path, value in _resource_values(call.get("response")):
            latest_resources[value] = (entity_id, path)
    return {"nodes": nodes, "edges": edges}


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
    return result
