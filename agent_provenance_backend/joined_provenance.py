import math
import re
from collections import Counter, defaultdict
from itertools import combinations
from typing import Any


DEFAULT_THRESHOLD = 0.75
URL_RE = re.compile(r"^https?://", re.IGNORECASE)
PATH_RE = re.compile(r"(^/|^[A-Za-z]:\\|[/\\][^/\\]+|[\w.-]+\.[A-Za-z0-9]{1,8}$)")
IMAGE_EXT_RE = re.compile(r"\.(png|jpe?g|gif|webp|svg|tiff?|bmp)$", re.IGNORECASE)
CODE_RE = re.compile(r"\b(def|class|function|const|let|var|import|SELECT|FROM)\b|[{};]\s*$")
TYPE_KEYS = ("null", "boolean", "number", "string", "array", "object")
TOOL_CALL_KEYS = ("toolCalls", "tool_calls", "calls", "steps")


def build_joined_provenance_graph(
    graph_entries: list[dict[str, Any]],
    threshold: float = DEFAULT_THRESHOLD,
) -> dict[str, Any]:
    traces = normalize_traces(graph_entries)
    analyses = [analyze_trace(trace) for trace in traces]
    score_groups = trace_score_groups(traces)
    capsules = [capsule for analysis in analyses for capsule in analysis["capsules"]]
    clusters = cluster_capsules(capsules, threshold)
    joined_nodes, capsule_cluster_ids = build_joined_nodes(clusters, analyses, score_groups)
    root_nodes, root_node_ids = build_root_nodes(analyses, score_groups)
    joined_edges, trace_edges = build_joined_edges(
        analyses,
        capsule_cluster_ids,
        root_node_ids,
        score_groups,
    )

    return {
        "nodes": [*root_nodes, *joined_nodes],
        "edges": joined_edges,
        "motifs": mine_pathlets(trace_edges, traces),
        "threshold": threshold,
        "rootDefinitionsByTrace": {
            analysis["traceId"]: analysis["roots"] for analysis in analyses
        },
        "scoreSummary": score_groups["summary"],
    }


def normalize_traces(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    traces = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        dag = entry.get("dag") or entry.get("graph") or entry
        if not isinstance(dag, dict):
            continue
        nodes = [node for node in dag.get("nodes", []) if valid_node(node)]
        node_ids = {node["id"] for node in nodes}
        edges = [
            edge
            for edge in dag.get("edges", [])
            if valid_edge(edge) and edge["source"] in node_ids and edge["target"] in node_ids
        ]
        traces.append(
            {
                "traceId": str(entry.get("traceId") or entry.get("id") or f"trace_{index}"),
                "score": entry.get("score"),
                "nodes": nodes,
                "edges": edges,
                "toolCallsById": tool_calls_by_id(entry),
            }
        )
    return traces


def tool_calls_by_id(entry: dict[str, Any]) -> dict[str, dict[str, Any]]:
    calls = next(
        (
            entry[key]
            for key in TOOL_CALL_KEYS
            if isinstance(entry.get(key), list)
        ),
        [],
    )
    by_id: dict[str, dict[str, Any]] = {}

    for index, call in enumerate(calls):
        normalized = normalize_tool_call(call, index)
        if not normalized:
            continue
        for key in {normalized["id"], str(index)}:
            by_id[str(key)] = normalized

    return by_id


def normalize_tool_call(call: Any, index: int) -> dict[str, Any] | None:
    if isinstance(call, str):
        return {
            "id": str(index),
            "name": call,
            "args": None,
            "response": None,
            "raw": call,
        }
    if not isinstance(call, dict):
        return None

    call_id = first_present(call, ("id", "toolCallId", "tool_call_id")) or index
    function = call.get("function")
    name = first_present(call, ("name", "tool", "tool_name", "toolName", "function", "type")) or ""
    if isinstance(function, dict):
        name = function.get("name") or name

    return {
        "id": str(call_id),
        "name": str(name),
        "args": first_present(call, ("args", "arguments", "input")),
        "response": first_present(call, ("response", "output", "result")),
        "raw": call,
    }


def first_present(value: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if key in value:
            return value[key]
    return None


def valid_node(value: Any) -> bool:
    return isinstance(value, dict) and isinstance(value.get("id"), str)


def valid_edge(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("source"), str)
        and isinstance(value.get("target"), str)
    )


def analyze_trace(trace: dict[str, Any]) -> dict[str, Any]:
    nodes = {node["id"]: node for node in trace["nodes"]}
    edges = trace["edges"]
    incoming = grouped_edges(edges, "target")
    outgoing = grouped_edges(edges, "source")
    order = topological_order(nodes, edges)
    depth = node_depths(order, outgoing)
    roots = trace_roots(trace["traceId"], nodes, incoming, outgoing, order)
    root_sets = propagate_root_sets(roots, nodes, order, outgoing)
    entity_generators = entity_activity_links(nodes, incoming, "source")
    entity_consumers = entity_activity_links(nodes, outgoing, "target")

    capsules = [
        build_capsule(
            trace["traceId"],
            node,
            nodes,
            incoming,
            outgoing,
            depth,
            roots,
            root_sets,
            entity_generators,
            entity_consumers,
            trace["toolCallsById"],
        )
        for node in trace["nodes"]
        if node.get("kind") == "Activity"
    ]

    return {
        **trace,
        "nodeMap": nodes,
        "incoming": incoming,
        "outgoing": outgoing,
        "depth": depth,
        "roots": roots,
        "rootSets": root_sets,
        "entityGenerators": entity_generators,
        "capsules": capsules,
    }


def grouped_edges(edges: list[dict[str, Any]], key: str) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for edge in edges:
        result[edge[key]].append(edge)
    return result


def topological_order(
    nodes: dict[str, dict[str, Any]],
    edges: list[dict[str, Any]],
) -> list[str]:
    original_index = {node_id: index for index, node_id in enumerate(nodes)}
    incoming_count = {node_id: 0 for node_id in nodes}
    outgoing: dict[str, list[str]] = defaultdict(list)
    for edge in edges:
        incoming_count[edge["target"]] += 1
        outgoing[edge["source"]].append(edge["target"])

    ready = [node_id for node_id, count in incoming_count.items() if count == 0]
    ready.sort(key=lambda node_id: original_index[node_id])
    order = []

    while ready:
        node_id = ready.pop(0)
        order.append(node_id)
        for target in outgoing[node_id]:
            incoming_count[target] -= 1
            if incoming_count[target] == 0:
                ready.append(target)
                ready.sort(key=lambda item: original_index[item])

    ordered = set(order)
    remaining = [node_id for node_id in nodes if node_id not in ordered]
    return [*order, *remaining]


def node_depths(
    order: list[str],
    outgoing: dict[str, list[dict[str, Any]]],
) -> dict[str, int]:
    depth = {node_id: 0 for node_id in order}
    for node_id in order:
        for edge in outgoing.get(node_id, []):
            depth[edge["target"]] = max(depth.get(edge["target"], 0), depth[node_id] + 1)
    return depth


def trace_roots(
    trace_id: str,
    nodes: dict[str, dict[str, Any]],
    incoming: dict[str, list[dict[str, Any]]],
    outgoing: dict[str, list[dict[str, Any]]],
    order: list[str],
) -> list[dict[str, Any]]:
    roots = []
    seen: set[str] = set()

    for node_id in order:
        if not incoming.get(node_id):
            roots.append(root_record(trace_id, len(roots), node_id, nodes[node_id]))
            seen.add(node_id)

    for node_id in order:
        node = nodes[node_id]
        if node_id in seen or node.get("kind") != "Entity" or not outgoing.get(node_id):
            continue
        has_activity_generator = any(
            nodes.get(edge["source"], {}).get("kind") == "Activity"
            and edge.get("relation") == "generatedBy"
            for edge in incoming.get(node_id, [])
        )
        if not has_activity_generator:
            roots.append(root_record(trace_id, len(roots), node_id, node))
            seen.add(node_id)

    return roots


def root_record(
    trace_id: str,
    index: int,
    node_id: str,
    node: dict[str, Any],
) -> dict[str, Any]:
    return {
        "rootId": f"root_{index}",
        "traceId": trace_id,
        "nodeId": node_id,
        "kind": node.get("kind") or "unknown",
        "artifactKind": infer_node_artifact_kind(node),
    }


def propagate_root_sets(
    roots: list[dict[str, Any]],
    nodes: dict[str, dict[str, Any]],
    order: list[str],
    outgoing: dict[str, list[dict[str, Any]]],
) -> dict[str, set[str]]:
    root_sets = {node_id: set() for node_id in nodes}
    for root in roots:
        root_sets[root["nodeId"]].add(root["rootId"])

    for node_id in order:
        for edge in outgoing.get(node_id, []):
            root_sets[edge["target"]].update(root_sets[node_id])

    return root_sets


def entity_activity_links(
    nodes: dict[str, dict[str, Any]],
    edges_by_entity: dict[str, list[dict[str, Any]]],
    activity_endpoint: str,
) -> dict[str, set[str]]:
    return {
        node_id: {
            edge[activity_endpoint]
            for edge in edges_by_entity.get(node_id, [])
            if nodes.get(edge[activity_endpoint], {}).get("kind") == "Activity"
        }
        for node_id, node in nodes.items()
        if node.get("kind") == "Entity"
    }


def connected_node_ids(
    edges: list[dict[str, Any]],
    nodes: dict[str, dict[str, Any]],
    endpoint: str,
    kind: str,
) -> list[str]:
    return [
        edge[endpoint]
        for edge in edges
        if nodes.get(edge[endpoint], {}).get("kind") == kind
    ]


def build_capsule(
    trace_id: str,
    activity: dict[str, Any],
    nodes: dict[str, dict[str, Any]],
    incoming: dict[str, list[dict[str, Any]]],
    outgoing: dict[str, list[dict[str, Any]]],
    depth: dict[str, int],
    roots: list[dict[str, Any]],
    root_sets: dict[str, set[str]],
    entity_generators: dict[str, set[str]],
    entity_consumers: dict[str, set[str]],
    tool_calls: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    node_id = activity["id"]
    tool_call = tool_call_for_activity(activity, tool_calls)
    args = tool_call.get("args") if tool_call else activity.get("args")
    output = tool_call.get("response") if tool_call else activity.get("response", activity.get("output"))
    incoming_edges = incoming.get(node_id, [])
    outgoing_edges = outgoing.get(node_id, [])
    input_entities = connected_node_ids(incoming_edges, nodes, "source", "Entity")
    output_entities = connected_node_ids(outgoing_edges, nodes, "target", "Entity")
    parent_activities = set(connected_node_ids(incoming_edges, nodes, "source", "Activity"))
    child_activities = set(connected_node_ids(outgoing_edges, nodes, "target", "Activity"))
    parent_activities.update(
        activity_id
        for entity_id in input_entities
        for activity_id in entity_generators.get(entity_id, set())
    )
    child_activities.update(
        activity_id
        for entity_id in output_entities
        for activity_id in entity_consumers.get(entity_id, set())
    )

    root_set = sorted(root_sets.get(node_id, set()))
    root_kinds = {
        root["rootId"]: root["artifactKind"]
        for root in roots
        if root["rootId"] in root_set
    }

    return {
        "id": f"{trace_id}:{node_id}",
        "traceId": trace_id,
        "nodeId": node_id,
        "tool": str(
            activity.get("tool")
            or activity.get("label")
            or (tool_call or {}).get("name")
            or ""
        ),
        "rawNode": activity,
        "rawToolCall": (tool_call or {}).get("raw"),
        "input": {"entityIds": input_entities, "args": args},
        "activity": {"node": activity, "toolCall": (tool_call or {}).get("raw")},
        "output": {"entityIds": output_entities, "response": output},
        "inputEntityIds": input_entities,
        "outputEntityIds": output_entities,
        "rootSet": root_set,
        "inputParamShapeSignature": input_signature(args, input_entities, nodes),
        "outputParamShapeSignature": output_signature(output, output_entities, nodes),
        "graphContextSignature": graph_context_signature(
            node_id,
            incoming,
            outgoing,
            depth,
            {root["nodeId"] for root in roots},
        ),
        "rootPatternSignature": root_pattern_signature(root_set, root_kinds),
        "parentActivities": sorted(parent_activities),
        "childActivities": sorted(child_activities),
        "depth": depth.get(node_id, 0),
    }


def tool_call_for_activity(
    activity: dict[str, Any],
    tool_calls: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    candidates = [
        activity.get("toolCallId"),
        activity.get("tool_call_id"),
        activity.get("id", "").removeprefix("act:"),
        activity.get("timeIndex"),
    ]
    return next(
        (
            tool_calls[str(candidate)]
            for candidate in candidates
            if candidate is not None and str(candidate) in tool_calls
        ),
        None,
    )


def input_signature(
    args: Any,
    input_entities: list[str],
    nodes: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    entity_kinds = [infer_node_artifact_kind(nodes[entity_id]) for entity_id in input_entities]
    arg_kind = infer_artifact_kind(args)
    kinds = sorted({kind for kind in [*entity_kinds, arg_kind] if kind != "unknown"})

    return {
        "artifactKinds": kinds or ["unknown"],
        "paramKeys": top_level_keys(args),
        "valueTypeHistogram": value_type_histogram(args),
    }


def output_signature(
    output: Any,
    output_entities: list[str],
    nodes: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    entity_values = [nodes[entity_id] for entity_id in output_entities]
    entity_kinds = [infer_node_artifact_kind(node) for node in entity_values]
    output_kind = infer_artifact_kind(output)
    kinds = sorted({kind for kind in [*entity_kinds, output_kind] if kind != "unknown"})
    keys = set(top_level_keys(output))
    histogram = Counter(value_type_histogram(output))

    for entity in entity_values:
        value = entity.get("response", entity.get("keys", entity.get("label")))
        keys.update(top_level_keys(value))
        histogram.update(value_type_histogram(value))

    return {
        "artifactKinds": kinds or ["unknown"],
        "paramKeys": sorted(keys),
        "valueTypeHistogram": dict(sorted(histogram.items())),
    }


def graph_context_signature(
    node_id: str,
    incoming: dict[str, list[dict[str, Any]]],
    outgoing: dict[str, list[dict[str, Any]]],
    depth: dict[str, int],
    root_node_ids: set[str],
) -> dict[str, Any]:
    in_edges = incoming.get(node_id, [])
    out_edges = outgoing.get(node_id, [])
    fan_in = len(in_edges)
    fan_out = len(out_edges)

    return {
        "depthBucket": depth_bucket(depth.get(node_id, 0)),
        "fanIn": fan_in,
        "fanOut": fan_out,
        "isRootAdjacent": fan_in == 0 or any(edge["source"] in root_node_ids for edge in in_edges),
        "isLeafAdjacent": fan_out == 0 or any(not outgoing.get(edge["target"]) for edge in out_edges),
        "isMergePoint": fan_in > 1,
        "isBranchPoint": fan_out > 1,
        "incomingRelationTypes": sorted({str(edge.get("relation") or "edge") for edge in in_edges}),
        "outgoingRelationTypes": sorted({str(edge.get("relation") or "edge") for edge in out_edges}),
    }


def root_pattern_signature(
    root_set: list[str],
    root_kinds: dict[str, str],
) -> dict[str, Any]:
    return {
        "rootSetSize": len(root_set),
        "rootCountBucket": count_bucket(len(root_set)),
        "isMultiRoot": len(root_set) > 1,
        "rootKindPattern": sorted(root_kinds.values()) or ["unknown"],
    }


def depth_bucket(depth: int) -> str:
    if depth <= 0:
        return "d0"
    if depth <= 5:
        return "d1_2" if depth <= 2 else "d3_5"
    return "d6_plus"


def count_bucket(count: int) -> str:
    return "0" if count <= 0 else str(count) if count <= 2 else "3_plus"


def infer_node_artifact_kind(node: dict[str, Any]) -> str:
    for key in ("response", "keys", "label", "entityType", "id"):
        kind = infer_artifact_kind(node.get(key))
        if kind != "unknown":
            return kind
    return "unknown"


def infer_artifact_kind(value: Any) -> str:
    if value is None or isinstance(value, (bool, int, float)):
        return "unknown"
    if isinstance(value, str):
        return string_artifact_kind(value)
    if isinstance(value, list):
        if homogeneous_objects(value):
            return "table"
        item_kinds = {infer_artifact_kind(item) for item in value[:8]}
        for kind in ("image", "url", "file", "code", "error", "table", "json"):
            if kind in item_kinds:
                return kind
        if any(isinstance(item, (dict, list)) for item in value):
            return "json"
        return "text" if any(isinstance(item, str) and item.strip() for item in value) else "unknown"
    if isinstance(value, dict):
        keys = {str(key).lower() for key in value}
        values = list(value.values())
        if keys & {"error", "errors", "exception", "traceback", "stack"}:
            return "error"
        if "rows" in keys and "columns" in keys:
            return "table"
        if keys & {"width", "height", "pixels"} and image_evidence(values):
            return "image"
        if image_evidence(values):
            return "image"
        if keys & {"path", "filename", "file", "mime", "mime_type", "content_type"}:
            return "url" if any(is_url_string(item) for item in values) else "file"
        if any(infer_artifact_kind(item) == "table" for item in values):
            return "table"
        return "json" if value else "unknown"
    return "unknown"


def string_artifact_kind(text: str) -> str:
    value = text.strip()
    if not value:
        return "unknown"
    if is_url_string(value):
        return "url"
    if IMAGE_EXT_RE.search(value) or value.lower().startswith("image/"):
        return "image"
    if CODE_RE.search(value):
        return "code"
    if PATH_RE.search(value) or "/" in value:
        return "file"
    return "text" if len(value) > 24 or any(char.isspace() for char in value) else "unknown"


def is_url_string(value: Any) -> bool:
    return isinstance(value, str) and bool(URL_RE.match(value.strip()))


def image_evidence(values: list[Any]) -> bool:
    return any(
        isinstance(value, str)
        and (IMAGE_EXT_RE.search(value) or value.lower().startswith("image/"))
        for value in values
    )


def homogeneous_objects(values: list[Any]) -> bool:
    objects = [value for value in values[:16] if isinstance(value, dict)]
    if len(objects) < 2:
        return False
    first_keys = set(objects[0])
    return bool(first_keys) and all(set(item) == first_keys for item in objects[1:])


def top_level_keys(value: Any) -> list[str]:
    if isinstance(value, dict):
        return sorted(str(key) for key in value.keys())[:24]
    if isinstance(value, list):
        keys = {
            str(key)
            for item in value[:16]
            if isinstance(item, dict)
            for key in item.keys()
        }
        return sorted(keys)[:24]
    return []


def value_type_histogram(value: Any) -> dict[str, int]:
    counter: Counter[str] = Counter()
    if isinstance(value, dict):
        counter.update(value_type(item) for item in value.values())
    elif isinstance(value, list):
        counter.update(value_type(item) for item in value[:32])
    else:
        counter.update([value_type(value)])
    return {key: counter[key] for key in TYPE_KEYS if counter[key]}


def value_type(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "string"


def cluster_capsules(capsules: list[dict[str, Any]], threshold: float) -> list[list[dict[str, Any]]]:
    if not capsules:
        return []

    parents = list(range(len(capsules)))
    members = {index: [index] for index in range(len(capsules))}
    pairs = [
        (similarity(capsules[left], capsules[right]), left, right)
        for left, right in candidate_pairs(capsules)
    ]

    for score, left, right in sorted(pairs, reverse=True):
        if score < threshold:
            continue
        left_root = find_parent(parents, left)
        right_root = find_parent(parents, right)
        if left_root == right_root:
            continue
        if clusters_compatible(members[left_root], members[right_root], capsules):
            parents[right_root] = left_root
            members[left_root].extend(members.pop(right_root))

    clusters = [[capsules[index] for index in cluster] for cluster in members.values()]
    return sorted(clusters, key=cluster_sort_key)


def candidate_pairs(capsules: list[dict[str, Any]]) -> set[tuple[int, int]]:
    blocks: dict[str, list[int]] = defaultdict(list)
    for index, capsule in enumerate(capsules):
        for key in blocking_keys(capsule):
            blocks[key].append(index)

    pairs: set[tuple[int, int]] = set()
    for indexes in blocks.values():
        for left, right in combinations(indexes, 2):
            pairs.add((min(left, right), max(left, right)))

    return pairs or set(combinations(range(len(capsules)), 2))


def blocking_keys(capsule: dict[str, Any]) -> list[str]:
    input_kinds = ",".join(capsule["inputParamShapeSignature"]["artifactKinds"])
    output_kinds = ",".join(capsule["outputParamShapeSignature"]["artifactKinds"])
    context = capsule["graphContextSignature"]
    tool_tokens = sorted(tokens(capsule["tool"]))
    tool_token = tool_tokens[0] if tool_tokens else ""

    return [
        f"shape:{input_kinds}->{output_kinds}",
        f"context:{context['depthBucket']}:{count_bucket(context['fanIn'])}:{count_bucket(context['fanOut'])}",
        f"role:{context['isMergePoint']}:{context['isBranchPoint']}:{output_kinds}",
        f"tool:{tool_token}" if tool_token else "tool:",
    ]


def find_parent(parents: list[int], index: int) -> int:
    while parents[index] != index:
        parents[index] = parents[parents[index]]
        index = parents[index]
    return index


def clusters_compatible(
    left: list[int],
    right: list[int],
    capsules: list[dict[str, Any]],
) -> bool:
    return all(
        pair_compatible(capsules[left_index], capsules[right_index])
        for left_index in left
        for right_index in right
    )


def pair_compatible(a: dict[str, Any], b: dict[str, Any]) -> bool:
    if a["traceId"] != b["traceId"]:
        return True
    if a["rootSet"] != b["rootSet"]:
        return False
    if a["depth"] == b["depth"] and (
        set(a["parentActivities"]) & set(b["parentActivities"])
        or set(a["childActivities"]) & set(b["childActivities"])
    ):
        return False
    return True


def cluster_sort_key(cluster: list[dict[str, Any]]) -> tuple[float, str]:
    return (
        sum(capsule["depth"] for capsule in cluster) / max(len(cluster), 1),
        min(capsule["id"] for capsule in cluster),
    )


def similarity(a: dict[str, Any], b: dict[str, Any]) -> float:
    score = (
        0.20 * token_similarity(a["tool"], b["tool"])
        + 0.30
        * side_signature_similarity(
            a["inputParamShapeSignature"],
            b["inputParamShapeSignature"],
        )
        + 0.30
        * side_signature_similarity(
            a["outputParamShapeSignature"],
            b["outputParamShapeSignature"],
        )
        + 0.20
        * graph_context_similarity(
            a["graphContextSignature"],
            b["graphContextSignature"],
        )
    )
    return round(score, 4)


def token_similarity(a: str, b: str) -> float:
    return jaccard(tokens(a), tokens(b))


def tokens(value: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[A-Za-z0-9]+", value.lower())
        if len(token) > 1
    }


def side_signature_similarity(a: dict[str, Any], b: dict[str, Any]) -> float:
    return (
        0.45 * jaccard(set(a["artifactKinds"]), set(b["artifactKinds"]))
        + 0.35 * jaccard(set(a["paramKeys"]), set(b["paramKeys"]))
        + 0.20 * histogram_similarity(a["valueTypeHistogram"], b["valueTypeHistogram"])
    )


def graph_context_similarity(a: dict[str, Any], b: dict[str, Any]) -> float:
    boolean_keys = ("isRootAdjacent", "isLeafAdjacent", "isMergePoint", "isBranchPoint")
    bool_score = sum(a[key] == b[key] for key in boolean_keys) / len(boolean_keys)
    relation_score = (
        jaccard(set(a["incomingRelationTypes"]), set(b["incomingRelationTypes"]))
        + jaccard(set(a["outgoingRelationTypes"]), set(b["outgoingRelationTypes"]))
    ) / 2

    return (
        0.25 * (1 if a["depthBucket"] == b["depthBucket"] else 0)
        + 0.20 * count_similarity(a["fanIn"], b["fanIn"])
        + 0.20 * count_similarity(a["fanOut"], b["fanOut"])
        + 0.20 * bool_score
        + 0.15 * relation_score
    )


def count_similarity(a: int, b: int) -> float:
    return 1 - abs(a - b) / max(a, b, 1)


def jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1
    return len(a & b) / len(a | b)


def histogram_similarity(a: dict[str, int], b: dict[str, int]) -> float:
    keys = set(a) | set(b)
    if not keys:
        return 1
    dot = sum(a.get(key, 0) * b.get(key, 0) for key in keys)
    a_norm = math.sqrt(sum(value * value for value in a.values()))
    b_norm = math.sqrt(sum(value * value for value in b.values()))
    return dot / (a_norm * b_norm) if a_norm and b_norm else 0


def trace_score_groups(traces: list[dict[str, Any]]) -> dict[str, Any]:
    scores = {
        trace["traceId"]: float(trace["score"])
        for trace in traces
        if isinstance(trace.get("score"), (int, float))
    }
    if not scores:
        return {"scores": {}, "high": set(), "low": set(), "summary": None}

    values = sorted(scores.values())
    median = values[len(values) // 2]
    high = {trace_id for trace_id, score in scores.items() if score >= median}
    low = set(scores) - high

    return {
        "scores": scores,
        "high": high,
        "low": low,
        "summary": {
            "min": round(values[0], 3),
            "max": round(values[-1], 3),
            "median": round(median, 3),
        },
    }


def support_score_summary(
    support_traces: set[str],
    score_groups: dict[str, Any],
    trace_count: int,
) -> dict[str, Any]:
    scores = score_groups["scores"]
    values = [scores[trace_id] for trace_id in support_traces if trace_id in scores]

    return {
        "highScoreTraces": sorted(support_traces & score_groups["high"]),
        "lowScoreTraces": sorted(support_traces & score_groups["low"]),
        "averageScore": round(sum(values) / len(values), 3) if values else None,
        "isAnomaly": trace_count > 1 and len(support_traces) == 1,
    }


def support_fields(
    items: list[dict[str, Any]],
    score_groups: dict[str, Any],
    trace_count: int,
) -> dict[str, Any]:
    trace_ids = {item["traceId"] for item in items}

    return {
        "supportTraces": sorted(trace_ids),
        "supportCount": len(trace_ids),
        "multiplicityByTrace": dict(
            sorted(Counter(item["traceId"] for item in items).items())
        ),
        "supportRatio": round(len(trace_ids) / max(trace_count, 1), 3),
        "scoreSummary": support_score_summary(trace_ids, score_groups, trace_count),
    }


def build_joined_nodes(
    clusters: list[list[dict[str, Any]]],
    analyses: list[dict[str, Any]],
    score_groups: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    trace_count = len(analyses)
    nodes = []
    capsule_cluster_ids = {}

    for index, cluster in enumerate(clusters, start=1):
        cluster_id = f"C{index}"
        for capsule in cluster:
            capsule_cluster_ids[capsule["id"]] = cluster_id
        nodes.append(
            {
                "id": cluster_id,
                "kind": "JoinedActivity",
                "label": cluster_label(cluster),
                **support_fields(cluster, score_groups, trace_count),
                "members": [member_record(capsule) for capsule in cluster],
                "representativeSignature": representative_signature(cluster),
                "rootSetsByTrace": root_sets_by_trace(cluster),
                "confidence": cluster_confidence(cluster),
            }
        )

    return nodes, capsule_cluster_ids


def cluster_label(cluster: list[dict[str, Any]]) -> str:
    tool_counts = Counter(capsule["tool"] for capsule in cluster if capsule["tool"])
    tools = [tool for tool, _ in tool_counts.most_common(2)]
    return " / ".join(tools) if tools else "joined_tool"


def member_record(capsule: dict[str, Any]) -> dict[str, Any]:
    return {
        "traceId": capsule["traceId"],
        "nodeId": capsule["nodeId"],
        "tool": capsule["tool"],
        "rootSet": capsule["rootSet"],
        "inputEntityIds": capsule["inputEntityIds"],
        "outputEntityIds": capsule["outputEntityIds"],
        "input": capsule["input"],
        "activity": capsule["activity"],
        "output": capsule["output"],
        "rawNode": capsule["rawNode"],
        "rawToolCall": capsule["rawToolCall"],
        "signatures": {
            "inputParamShapeSignature": capsule["inputParamShapeSignature"],
            "outputParamShapeSignature": capsule["outputParamShapeSignature"],
            "graphContextSignature": capsule["graphContextSignature"],
            "rootPatternSignature": capsule["rootPatternSignature"],
        },
    }


def representative_signature(cluster: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "toolLabels": top_counts(capsule["tool"] for capsule in cluster if capsule["tool"]),
        "inputParamShapeSignature": common_side_signature(
            capsule["inputParamShapeSignature"] for capsule in cluster
        ),
        "outputParamShapeSignature": common_side_signature(
            capsule["outputParamShapeSignature"] for capsule in cluster
        ),
        "graphContextSignature": {
            "depthBuckets": top_counts(
                capsule["graphContextSignature"]["depthBucket"] for capsule in cluster
            ),
            "mergeCount": sum(capsule["graphContextSignature"]["isMergePoint"] for capsule in cluster),
            "branchCount": sum(capsule["graphContextSignature"]["isBranchPoint"] for capsule in cluster),
        },
        "rootPatternSignature": {
            "rootCounts": top_counts(
                capsule["rootPatternSignature"]["rootCountBucket"] for capsule in cluster
            ),
            "rootKinds": top_counts(
                kind
                for capsule in cluster
                for kind in capsule["rootPatternSignature"]["rootKindPattern"]
            ),
        },
    }


def common_side_signature(signatures: Any) -> dict[str, Any]:
    items = list(signatures)
    histogram = Counter()
    for signature in items:
        histogram.update(signature["valueTypeHistogram"])

    return {
        "artifactKinds": top_counts(
            kind for signature in items for kind in signature["artifactKinds"]
        ),
        "paramKeys": top_counts(key for signature in items for key in signature["paramKeys"]),
        "valueTypeHistogram": dict(sorted(histogram.items())),
    }


def top_counts(values: Any) -> dict[str, int]:
    return dict(Counter(str(value) for value in values).most_common(12))


def root_sets_by_trace(cluster: list[dict[str, Any]]) -> dict[str, list[list[str]]]:
    result: dict[str, list[list[str]]] = defaultdict(list)
    for capsule in cluster:
        if capsule["rootSet"] not in result[capsule["traceId"]]:
            result[capsule["traceId"]].append(capsule["rootSet"])
    return dict(sorted(result.items()))


def cluster_confidence(cluster: list[dict[str, Any]]) -> float:
    if len(cluster) == 1:
        return 1
    scores = [
        similarity(left, right)
        for left, right in combinations(cluster, 2)
        if left["traceId"] != right["traceId"]
    ]
    return round(sum(scores) / len(scores), 3) if scores else 1


def build_root_nodes(
    analyses: list[dict[str, Any]],
    score_groups: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[tuple[str, str], str]]:
    by_root_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
    root_node_ids = {}
    trace_count = len(analyses)

    for analysis in analyses:
        for root in analysis["roots"]:
            if root["kind"] == "Activity":
                continue
            by_root_id[root["rootId"]].append(root)
            root_node_ids[(analysis["traceId"], root["nodeId"])] = root["rootId"]

    nodes = [
        {
            "id": root_id,
            "kind": "Root",
            "label": root_label(root_id, roots),
            **support_fields(roots, score_groups, trace_count),
            "members": roots,
            "representativeSignature": {
                "artifactKinds": top_counts(root["artifactKind"] for root in roots),
            },
            "rootSetsByTrace": {
                trace_id: [[root_id]]
                for trace_id in sorted({root["traceId"] for root in roots})
            },
            "confidence": 1,
        }
        for root_id, roots in sorted(by_root_id.items())
    ]

    return nodes, root_node_ids


def root_label(root_id: str, roots: list[dict[str, Any]]) -> str:
    kinds = Counter(root["artifactKind"] for root in roots if root["artifactKind"] != "unknown")
    return f"Root {kinds.most_common(1)[0][0]}" if kinds else root_id.replace("_", " ").title()


def build_joined_edges(
    analyses: list[dict[str, Any]],
    capsule_cluster_ids: dict[str, str],
    root_node_ids: dict[tuple[str, str], str],
    score_groups: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, set[tuple[str, str]]]]:
    edge_groups: dict[tuple[str, str], dict[str, Any]] = {}
    trace_edges: dict[str, set[tuple[str, str]]] = defaultdict(set)

    for analysis in analyses:
        trace_id = analysis["traceId"]
        for edge in analysis["edges"]:
            source = joined_id_for_node(
                trace_id,
                edge["source"],
                analysis,
                capsule_cluster_ids,
                root_node_ids,
            )
            target = joined_id_for_node(
                trace_id,
                edge["target"],
                analysis,
                capsule_cluster_ids,
                root_node_ids,
            )
            if not source or not target or source == target:
                continue

            key = (source, target)
            group = edge_groups.setdefault(
                key,
                {
                    "source": source,
                    "target": target,
                    "supportTraces": set(),
                    "relationTypes": set(),
                    "rawEdges": [],
                },
            )
            group["supportTraces"].add(trace_id)
            group["relationTypes"].add(str(edge.get("relation") or "edge"))
            group["rawEdges"].append(
                {
                    "traceId": trace_id,
                    "source": edge["source"],
                    "target": edge["target"],
                    "relation": str(edge.get("relation") or "edge"),
                }
            )
            trace_edges[trace_id].add(key)

    edges = []
    for index, group in enumerate(edge_groups.values(), start=1):
        support_traces = sorted(group["supportTraces"])
        edges.append(
            {
                "id": f"E{index}",
                "source": group["source"],
                "target": group["target"],
                "supportTraces": support_traces,
                "supportCount": len(support_traces),
                "relationTypes": sorted(group["relationTypes"]),
                "rawEdges": group["rawEdges"],
                "count": len(group["rawEdges"]),
                "scoreSummary": support_score_summary(
                    set(support_traces),
                    score_groups,
                    len(analyses),
                ),
            }
        )

    return edges, trace_edges


def joined_id_for_node(
    trace_id: str,
    node_id: str,
    analysis: dict[str, Any],
    capsule_cluster_ids: dict[str, str],
    root_node_ids: dict[tuple[str, str], str],
) -> str | None:
    node = analysis["nodeMap"].get(node_id)
    if not node:
        return None
    if node.get("kind") == "Activity":
        return capsule_cluster_ids.get(f"{trace_id}:{node_id}")
    if (trace_id, node_id) in root_node_ids:
        return root_node_ids[(trace_id, node_id)]

    generators = analysis["entityGenerators"].get(node_id, set())
    for generator_id in sorted(generators):
        joined_id = capsule_cluster_ids.get(f"{trace_id}:{generator_id}")
        if joined_id:
            return joined_id
    return None


def mine_pathlets(
    trace_edges: dict[str, set[tuple[str, str]]],
    traces: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    motif_traces: dict[tuple[str, ...], set[str]] = defaultdict(set)
    scores = {
        trace["traceId"]: trace.get("score")
        for trace in traces
        if isinstance(trace.get("score"), (int, float))
    }

    for trace_id, edges in trace_edges.items():
        adjacency: dict[str, set[str]] = defaultdict(set)
        for source, target in edges:
            adjacency[source].add(target)
        for path in trace_pathlets(adjacency):
            motif_traces[path].add(trace_id)

    motifs = []
    for path, support_traces in motif_traces.items():
        motif = {
            "path": list(path),
            "supportTraces": sorted(support_traces),
            "supportCount": len(support_traces),
        }
        if scores:
            motif.update(score_split(support_traces, scores))
        motifs.append(motif)

    return sorted(
        motifs,
        key=lambda motif: (-motif["supportCount"], -len(motif["path"]), motif["path"]),
    )[:24]


def trace_pathlets(adjacency: dict[str, set[str]]) -> set[tuple[str, ...]]:
    paths: set[tuple[str, ...]] = set()

    def walk(path: list[str]) -> None:
        if 2 <= len(path) <= 4:
            paths.add(tuple(path))
        if len(path) == 4:
            return
        for target in sorted(adjacency.get(path[-1], set())):
            if target not in path:
                walk([*path, target])

    for source in sorted(adjacency):
        walk([source])

    return paths


def score_split(
    support_traces: set[str],
    scores: dict[str, float],
) -> dict[str, Any]:
    values = sorted(scores.values())
    median = values[len(values) // 2]
    high_traces = {trace_id for trace_id, score in scores.items() if score >= median}
    low_traces = set(scores) - high_traces
    high_support = len(support_traces & high_traces)
    low_support = len(support_traces & low_traces)

    return {
        "highScoreSupport": high_support,
        "lowScoreSupport": low_support,
        "scoreLift": round(
            high_support / max(len(high_traces), 1)
            - low_support / max(len(low_traces), 1),
            3,
        ),
    }
