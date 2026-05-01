import json
import math
import os
import re
from collections import Counter
from hashlib import sha256
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse, StreamingResponse

ROOT = Path(__file__).resolve().parents[1]
REACT_DIR = ROOT / "agent_provenance_react"
CACHE_DIR = REACT_DIR / ".cache"
GRAPH_CACHE_DIR = CACHE_DIR / "generated-prov-graphs"

DEFAULT_BASE_URL = "https://ai-gateway.apps.cloud.rt.nyu.edu/v1/"
DEFAULT_MODEL = "@vertexai/gemini-3-pro-preview"
MAX_TOKEN_EDGE_CANDIDATES = 6
TOKEN_CHAMFER_THRESHOLD = 0.5
MAX_LABEL_LENGTH = 96
MAX_ARRAY_ITEMS = 12
MAX_OBJECT_KEYS = 16
MAX_STRING_LENGTH = 240
MAX_SUMMARY_DEPTH = 4
OUTPUT_METADATA_KEYS = (
    "storage_entry",
    "ora_result_metadata",
    "gsea_result_metadata",
    "gsea_plot_metadata",
)

app = FastAPI()


def load_env() -> None:
    env_path = REACT_DIR / ".env"
    if not env_path.exists():
        return

    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()


def clean_string(value: Any) -> str | None:
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    text = str(value).strip()
    return text or None


def basename(value: str) -> str:
    clean = value.split("?", 1)[0]
    return Path(clean).name or clean


def truncate(value: str, limit: int = MAX_LABEL_LENGTH) -> str:
    return value if len(value) <= limit else f"{value[: limit - 3]}..."


def safe_id(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._:-]+", "_", value)[:120]


def unique(values: list[str | None]) -> list[str]:
    result: list[str] = []
    for value in values:
        if value and value not in result:
            result.append(value)
    return result


def sanitize_value(value: Any, depth: int = 0) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return truncate(value, MAX_STRING_LENGTH)
    if depth >= MAX_SUMMARY_DEPTH:
        return "[truncated]"
    if isinstance(value, list):
        items = [sanitize_value(item, depth + 1) for item in value[:MAX_ARRAY_ITEMS]]
        if len(value) > MAX_ARRAY_ITEMS:
            items.append(f"[+{len(value) - MAX_ARRAY_ITEMS} more]")
        return items
    if isinstance(value, dict):
        entries = list(value.items())
        output = {
            key: sanitize_value(item, depth + 1)
            for key, item in entries[:MAX_OBJECT_KEYS]
        }
        if len(entries) > MAX_OBJECT_KEYS:
            output["__truncated__"] = f"{len(entries) - MAX_OBJECT_KEYS} more keys"
        return output
    return str(value)


def normalize_tool_calls(tool_calls: Any) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    used_ids: set[str] = set()

    for index, tool_call in enumerate(tool_calls if isinstance(tool_calls, list) else []):
        if not isinstance(tool_call, dict) or not clean_string(tool_call.get("name")):
            continue
        raw_id = str(tool_call.get("id", index))
        call_id = str(index) if raw_id in used_ids else raw_id
        used_ids.add(call_id)
        calls.append(
            {
                "id": call_id,
                "tool": tool_call["name"],
                "args": tool_call.get("args") or {},
                "response": tool_call.get("response") or {},
                "timeIndex": index,
            }
        )

    return calls


def get_cache_path(trace_id: Any, calls: list[dict[str, Any]]) -> tuple[Path, str]:
    safe_trace_id = re.sub(r"[^a-zA-Z0-9._-]+", "_", str(trace_id or "trace"))[:80]
    cache_key = sha256(
        json.dumps(
            {
                "schema": "prov-workflow-py-v5",
                "calls": calls,
                "tokenCandidates": MAX_TOKEN_EDGE_CANDIDATES,
                "tokenChamferThreshold": token_chamfer_threshold(),
            },
            sort_keys=True,
            default=str,
        ).encode()
    ).hexdigest()[:12]
    filename = f"{safe_trace_id or 'trace'}-{cache_key}.json"

    return GRAPH_CACHE_DIR / filename, f"/.cache/generated-prov-graphs/{filename}"


def output_metadata(response: Any) -> dict[str, str | None] | None:
    if not isinstance(response, dict):
        return None

    for key in OUTPUT_METADATA_KEYS:
        metadata = response.get(key)
        if not isinstance(metadata, dict):
            continue
        output = {
            "id": clean_string(metadata.get("id")),
            "path": clean_string(metadata.get("path")),
            "name": clean_string(metadata.get("name")),
        }
        if output["id"] or output["path"] or output["name"]:
            return output

    output = {
        "id": clean_string(response.get("id")),
        "path": clean_string(response.get("path")),
        "name": clean_string(response.get("name")),
    }
    return output if output["id"] or output["path"] or output["name"] else None


def output_entity(call: dict[str, Any]) -> dict[str, Any] | None:
    metadata = output_metadata(call["response"])
    key = metadata and (metadata["id"] or metadata["path"] or metadata["name"])

    if not metadata or not key:
        return None

    return {
        "id": f"ent:output:{safe_id(key)}",
        "kind": "Entity",
        "entityType": "tool_output",
        "response": sanitize_value(call["response"]),
    }


def output_keys(call: dict[str, Any]) -> list[str]:
    metadata = output_metadata(call["response"])
    if not metadata:
        return []
    key = metadata["id"] or metadata["path"] or metadata["name"]
    return unique([metadata["id"], metadata["path"], metadata["name"], basename(key)] if key else [])


def summarize(calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summaries = []
    for call in calls:
        summaries.append(
            {
                "call": call,
                "activity": {
                    "id": f"act:{call['id']}",
                    "kind": "Activity",
                    "toolCallId": call["id"],
                    "tool": call["tool"],
                    "timeIndex": call["timeIndex"],
                    "args": sanitize_value(call["args"]),
                },
                "output": output_entity(call),
                "outputKeys": output_keys(call),
            }
        )
    return summaries


def edge_key(edge: dict[str, str]) -> str:
    return f"{edge['source']}|{edge['target']}|{edge['relation']}"


def args_use_output(next_summary: dict[str, Any], previous: dict[str, Any]) -> bool:
    output_keys = previous.get("outputKeys") or []
    if not output_keys:
        return False
    args_text = json.dumps(next_summary["call"]["args"], default=str)
    return any(key and key in args_text for key in output_keys)


def artifact_evidence(next_summary: dict[str, Any], previous: dict[str, Any]) -> list[dict[str, Any]]:
    output_keys = previous.get("outputKeys") or []
    args_text = json.dumps(next_summary["call"]["args"], default=str)
    shared = [basename(key) for key in output_keys if key and key in args_text]
    return [{"kind": "artifact", "shared": shared[:8]}] if shared else []


def edge_from(previous: dict[str, Any], next_summary: dict[str, Any]) -> dict[str, str]:
    output = previous.get("output")
    return {
        "source": output["id"] if output else previous["activity"]["id"],
        "target": next_summary["activity"]["id"],
        "relation": "usedBy" if output else "informedBy",
    }


def exact_artifact_edges(summaries: list[dict[str, Any]]) -> list[dict[str, str]]:
    edges = []
    for index, next_summary in enumerate(summaries):
        for previous in summaries[:index]:
            if args_use_output(next_summary, previous):
                edge = edge_from(previous, next_summary)
                edge["evidence"] = artifact_evidence(next_summary, previous)
                edges.append(edge)
    return edges


def scalar_texts(value: Any) -> list[str]:
    if isinstance(value, bool) or value is None:
        return []
    if isinstance(value, (str, int, float)):
        return [str(value)]
    if isinstance(value, list):
        return [text for item in value for text in scalar_texts(item)]
    if isinstance(value, dict):
        return [text for item in value.values() for text in scalar_texts(item)]
    return []


def useful_token(value: str) -> bool:
    token = value.strip("._:-")
    return (
        len(token) >= 4
        or (len(token) >= 2 and any(char.isdigit() for char in token))
        or (len(token) >= 2 and token.isupper())
    )


def tokens_from(value: Any) -> set[str]:
    tokens: set[str] = set()
    for text in scalar_texts(value):
        for raw_token in re.findall(r"[A-Za-z0-9][A-Za-z0-9._:-]*", text):
            token = raw_token.strip("._:-")
            if useful_token(token):
                tokens.add(token.lower())
            base = basename(token)
            if base != token and useful_token(base):
                tokens.add(base.lower())
    return tokens


def token_chamfer_threshold() -> float:
    try:
        return float(os.getenv("PROVENANCE_TOKEN_CHAMFER_THRESHOLD", ""))
    except ValueError:
        return TOKEN_CHAMFER_THRESHOLD


def token_weights(output_tokens: list[set[str]]) -> dict[str, float]:
    output_count = max(len(output_tokens), 1)
    output_frequency = Counter(token for tokens in output_tokens for token in tokens)

    return {
        token: math.log((output_count + 1) / (count + 1)) + 1
        for token, count in output_frequency.items()
    }


def suggested_edges(summaries: list[dict[str, Any]]) -> list[dict[str, str]]:
    edges = {edge_key(edge): edge for edge in exact_artifact_edges(summaries)}
    input_token_sets = [tokens_from(summary["call"]["args"]) for summary in summaries]
    output_token_sets = [tokens_from(summary["call"]["response"]) for summary in summaries]
    weights = token_weights(output_token_sets)
    output_index: dict[str, list[int]] = {}
    threshold = token_chamfer_threshold()

    for index, next_summary in enumerate(summaries):
        input_tokens = input_token_sets[index]
        total_weight = sum(weights.get(token, 1.0) for token in input_tokens)
        matched_weight: dict[int, float] = {}
        matched_tokens: dict[int, set[str]] = {}

        if total_weight:
            for token in input_tokens:
                token_weight = weights.get(token, 1.0)
                for previous_index in output_index.get(token, []):
                    matched_weight[previous_index] = (
                        matched_weight.get(previous_index, 0) + token_weight
                    )
                    matched_tokens.setdefault(previous_index, set()).add(token)

            ranked = sorted(
                (
                    {
                        "previous": summaries[previous_index],
                        "score": score / total_weight,
                        "shared": matched_tokens[previous_index],
                    }
                    for previous_index, score in matched_weight.items()
                    if score / total_weight >= threshold
                ),
                key=lambda item: (
                    -item["score"],
                    -len(item["shared"]),
                    index - item["previous"]["call"]["timeIndex"],
                ),
            )

            for item in ranked[:MAX_TOKEN_EDGE_CANDIDATES]:
                edge = edge_from(item["previous"], next_summary)
                edge["evidence"] = [
                    {
                        "kind": "shared_token",
                        "score": round(item["score"], 3),
                        "shared": sorted(item["shared"])[:16],
                    }
                ]
                edges[edge_key(edge)] = edge

        for token in output_token_sets[index]:
            output_index.setdefault(token, []).append(index)

    return list(edges.values())


def build_graph(summaries: list[dict[str, Any]], selected: list[dict[str, str]]) -> dict[str, Any]:
    nodes: dict[str, dict[str, Any]] = {}
    edges: dict[str, dict[str, str]] = {}

    def add_edge(edge: dict[str, str]) -> None:
        if edge["source"].startswith("ent:") and edge["target"].startswith("ent:"):
            return
        edges[edge_key(edge)] = edge

    for summary in summaries:
        nodes[summary["activity"]["id"]] = summary["activity"]
        if summary["output"]:
            nodes[summary["output"]["id"]] = summary["output"]
            add_edge(
                {
                    "source": summary["activity"]["id"],
                    "target": summary["output"]["id"],
                    "relation": "generatedBy",
                }
            )

    for edge in selected:
        add_edge(edge)

    return {"nodes": list(nodes.values()), "edges": list(edges.values())}


def prompt(draft_graph: dict[str, Any]) -> str:
    return f"""Select direct provenance connections from ordered tool calls.

Model each call as input -> tool activity -> output.
Use Activity node args, Entity node responses, and edge evidence to refine direct tool-call dependencies.
Do not connect Entity to Entity.
Exact ids, filenames, paths, artifact names, and shared-token evidence are strong evidence.
Token-overlap edges are recommendations; reject them if the provenance logic is not direct.
Use Activity args and Entity response JSON to reason about logical reuse of genes, pathways, ranked lists, candidate sets, files, and result artifacts.
If a call has no direct predecessor, leave it as a root.
Prune redundant nodes when they do not add a distinct artifact, transformation, decision, or analysis step.
Do not use fixed tool-name assumptions. Decide from Activity args, Entity responses, edge evidence, and graph context.
Return edits as graph patch operations.
You may add semantic Entity nodes for meaningful intermediate data objects, but do not add Activity nodes.
If pruning an Activity because its output only repeats an input artifact, remove both the Activity and its generated output Entity.

ProvEdge:
{{
  "source": "node id",
  "target": "node id",
  "relation": "usedBy | generatedBy | informedBy",
  "evidence": [{{"kind":"artifact | shared_token | llm","shared":["optional"],"score":0.5}}]
}}

Return JSON:
{{"edits":[
  {{"op":"addNode","node":{{"id":"ent:semantic:candidate_genes","kind":"Entity","entityType":"gene_list","response":["CTNNB1","LEF1"]}}}},
  {{"op":"editNode","nodeId":"act:id","patch":{{"args":{{}}}}}},
  {{"op":"editNode","nodeId":"ent:id","patch":{{"entityType":"gene_list","response":[]}}}},
  {{"op":"removeNode","nodeId":"node id"}},
  {{"op":"addEdge","edge":{{"source":"node id","target":"node id","relation":"usedBy","evidence":[{{"kind":"llm","shared":["optional"]}}]}}}},
  {{"op":"removeEdge","edge":{{"source":"node id","target":"node id","relation":"usedBy"}}}},
  {{"op":"editEdge","edge":{{"source":"node id","target":"node id","relation":"informedBy"}},"nextEdge":{{"source":"node id","target":"node id","relation":"usedBy"}}}}
]}}

draftGraph:
{json.dumps(draft_graph, indent=2)}"""


def response_text(payload: dict[str, Any]) -> str:
    content = (payload.get("choices") or [{}])[0].get("message", {}).get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return ""


def parse_edge(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    source = value.get("source") if isinstance(value.get("source"), str) else ""
    target = value.get("target") if isinstance(value.get("target"), str) else ""
    relation = value.get("relation")
    if source and target and relation in {"usedBy", "generatedBy", "informedBy"}:
        edge = {"source": source, "target": target, "relation": relation}
        if isinstance(value.get("evidence"), list):
            edge["evidence"] = value["evidence"][:8]
        return edge
    return None


def parse_entity_node(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    node_id = safe_id(value.get("id", "")) if isinstance(value.get("id"), str) else ""
    entity_type = clean_string(value.get("entityType"))
    if not node_id.startswith("ent:") or value.get("kind") != "Entity" or not entity_type:
        return None
    node = {
        "id": node_id,
        "kind": "Entity",
        "entityType": entity_type,
    }
    if "response" in value:
        node["response"] = sanitize_value(value["response"])
    return node


def parse_node_patch(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    patch: dict[str, Any] = {}
    for key in ("tool", "entityType"):
        text = clean_string(value.get(key))
        if text:
            patch[key] = text
    if "args" in value:
        patch["args"] = sanitize_value(value["args"])
    if "response" in value:
        patch["response"] = sanitize_value(value["response"])
    return patch or None


def parse_llm_graph_patch(text: str) -> dict[str, Any]:
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end < start:
        return {"edits": []}

    try:
        parsed = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return {"edits": []}

    edits = []
    for edit in parsed.get("edits", []):
        if not isinstance(edit, dict):
            continue
        if edit.get("op") in {"addEdge", "removeEdge"}:
            edge = parse_edge(edit.get("edge"))
            if edge:
                edits.append({"op": edit["op"], "edge": edge})
        elif edit.get("op") == "editEdge":
            edge = parse_edge(edit.get("edge"))
            next_edge = parse_edge(edit.get("nextEdge"))
            if edge and next_edge:
                edits.append({"op": "editEdge", "edge": edge, "nextEdge": next_edge})
        elif edit.get("op") == "addNode":
            node = parse_entity_node(edit.get("node"))
            if node:
                edits.append({"op": "addNode", "node": node})
        elif edit.get("op") == "removeNode" and isinstance(edit.get("nodeId"), str):
            edits.append({"op": "removeNode", "nodeId": edit["nodeId"]})
        elif edit.get("op") == "editNode" and isinstance(edit.get("nodeId"), str):
            patch = parse_node_patch(edit.get("patch"))
            if patch:
                edits.append({"op": "editNode", "nodeId": edit["nodeId"], "patch": patch})

    return {"edits": edits}


def chat_config() -> tuple[str, str, str, dict[str, str]]:
    api_key = os.getenv("PROVENANCE_AGENT_API_KEY") or os.getenv("PORTKEY_API_KEY")
    if not api_key:
        raise RuntimeError("Missing PROVENANCE_AGENT_API_KEY.")

    base_url = (
        os.getenv("PROVENANCE_AGENT_BASE_URL")
        or os.getenv("PORTKEY_BASE_URL")
        or DEFAULT_BASE_URL
    ).rstrip("/")
    model = os.getenv("PROVENANCE_AGENT_MODEL") or os.getenv("PORTKEY_MODEL") or DEFAULT_MODEL
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    if not os.getenv("PROVENANCE_AGENT_API_KEY") and os.getenv("PORTKEY_API_KEY"):
        headers["x-portkey-api-key"] = api_key
    return base_url, model, f"{base_url}/chat/completions", headers


async def refine_graph(
    draft_graph: dict[str, Any],
) -> dict[str, Any]:
    try:
        _, model, url, headers = chat_config()
    except RuntimeError:
        return {"edits": []}

    async with httpx.AsyncClient(timeout=180) as client:
        response = await client.post(
            url,
            headers=headers,
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt(draft_graph)}],
            },
        )

    if response.is_error:
        return {"edits": []}

    return parse_llm_graph_patch(response_text(response.json()))


def patch_node(node: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    next_node = {**node}
    if node.get("kind") == "Activity":
        for key in ("tool", "args"):
            if key in patch:
                next_node[key] = patch[key]
    else:
        for key in ("entityType", "response"):
            if key in patch:
                next_node[key] = patch[key]
    return next_node


def apply_graph_patch(
    graph: dict[str, Any],
    patch: dict[str, Any],
    suggested_edges: list[dict[str, str]],
) -> dict[str, Any]:
    nodes = {node["id"]: node for node in graph["nodes"]}
    edges = {edge_key(edge): edge for edge in graph["edges"]}
    suggested = {edge_key(edge): edge for edge in suggested_edges}

    def add_edge(edge: dict[str, str]) -> None:
        source = nodes.get(edge["source"])
        target = nodes.get(edge["target"])
        if not source or not target:
            return
        if source.get("kind") == "Entity" and target.get("kind") == "Entity":
            return
        edges[edge_key(edge)] = edge

    for edit in patch.get("edits", []):
        if edit.get("op") == "addNode" and edit["node"]["id"] not in nodes:
            nodes[edit["node"]["id"]] = edit["node"]

    for edit in patch.get("edits", []):
        if edit.get("op") == "editNode":
            node = nodes.get(edit["nodeId"])
            if node:
                nodes[node["id"]] = patch_node(node, edit["patch"])
        elif edit.get("op") == "removeNode":
            nodes.pop(edit["nodeId"], None)
            edges = {
                key: edge
                for key, edge in edges.items()
                if edge["source"] != edit["nodeId"] and edge["target"] != edit["nodeId"]
            }

    for edit in patch.get("edits", []):
        if edit.get("op") == "addEdge":
            add_edge(suggested.get(edge_key(edit["edge"]), edit["edge"]))
        elif edit.get("op") == "removeEdge":
            edges.pop(edge_key(edit["edge"]), None)
        elif edit.get("op") == "editEdge":
            edges.pop(edge_key(edit["edge"]), None)
            add_edge(suggested.get(edge_key(edit["nextEdge"]), edit["nextEdge"]))

    return {
        "nodes": list(nodes.values()),
        "edges": [
            edge
            for edge in edges.values()
            if edge["source"] in nodes and edge["target"] in nodes
        ],
    }


def graph_mode(value: Any) -> str:
    return value if value in {"collapsed", "tree", "comparison"} else "tree"


def trace_score(score: Any) -> float | None:
    return round(score, 3) if isinstance(score, (int, float)) else None


def tool_sequence(trace: dict[str, Any]) -> list[str]:
    return [tool.get("name", "") for tool in trace.get("toolCalls", [])]


def shared_tools(traces: list[dict[str, Any]]) -> list[str]:
    if not traces:
        return []
    shared = set(tool_sequence(traces[0]))
    for trace in traces[1:]:
        shared &= set(tool_sequence(trace))
    return sorted(shared)


def trace_metadata(trace: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in trace.items()
        if key not in {"id", "score", "toolCalls"}
        and value is not None
        and not isinstance(value, (dict, list))
    }


def summarize_trace(trace: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": trace.get("id"),
        "score": trace_score(trace.get("score")),
        "metadata": trace_metadata(trace),
        "toolSequence": tool_sequence(trace),
        "toolCalls": [
            {
                "step": index + 1,
                "id": tool_call.get("id"),
                "name": tool_call.get("name"),
                "args": sanitize_value(tool_call.get("args")),
                "status": tool_call.get("status"),
                "response": sanitize_value(tool_call.get("response")),
            }
            for index, tool_call in enumerate(trace.get("toolCalls", []))
            if isinstance(tool_call, dict)
        ],
    }


def score_summary(traces: list[dict[str, Any]]) -> dict[str, float] | None:
    scores = [trace["score"] for trace in traces if isinstance(trace.get("score"), (int, float))]
    if not scores:
        return None
    return {
        "min": round(min(scores), 3),
        "max": round(max(scores), 3),
        "average": round(sum(scores) / len(scores), 3),
    }


def tool_frequency(traces: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts: dict[str, int] = {}
    for trace in traces:
        for name in tool_sequence(trace):
            counts[name] = counts.get(name, 0) + 1
    return [
        {"name": name, "count": count}
        for name, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ]


def build_messages(question: str, traces: list[dict[str, Any]], mode: str) -> list[dict[str, str]]:
    context = {
        "graphView": mode,
        "selectedTraceIds": [trace.get("id") for trace in traces],
        "selectedTraceCount": len(traces),
        "sharedTools": shared_tools(traces),
        "scoreSummary": score_summary(traces),
        "toolFrequency": tool_frequency(traces),
        "traces": [summarize_trace(trace) for trace in traces],
    }
    return [
        {
            "role": "system",
            "content": (
                "You are a concise assistant for AgentProvenance. "
                "Answer only from the provided provenance graph context. "
                "Focus on selected traces, ordered tool calls, tool responses, parameters, scores, similarities, differences, and likely implications. "
                "If the context is insufficient, say that plainly."
            ),
        },
        {
            "role": "user",
            "content": (
                "Current provenance graph context:\n"
                f"{json.dumps(context, indent=2)}\n\n"
                f"User question:\n{question}"
            ),
        },
    ]


def extract_stream_text(payload: dict[str, Any]) -> str:
    delta = (payload.get("choices") or [{}])[0].get("delta", {})
    content = delta.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content if isinstance(part, dict))
    blocks = delta.get("model_extra", {}).get("content_blocks", [])
    return "".join(block.get("text", "") for block in blocks if isinstance(block, dict))


async def stream_chat_response(messages: list[dict[str, str]]):
    try:
        _, model, url, headers = chat_config()
    except RuntimeError as error:
        return PlainTextResponse(str(error), status_code=500)

    client = httpx.AsyncClient(timeout=None)
    stream = client.stream("POST", url, headers=headers, json={"model": model, "stream": True, "messages": messages})

    try:
        response = await stream.__aenter__()
    except Exception as error:
        await client.aclose()
        return PlainTextResponse(str(error), status_code=500)

    if response.is_error:
        text = await response.aread()
        await stream.__aexit__(None, None, None)
        await client.aclose()
        return PlainTextResponse(text.decode() or "Model request failed.", status_code=500)

    async def body():
        try:
            async for line in response.aiter_lines():
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    break
                payload = json.loads(data)
                if payload.get("error", {}).get("message"):
                    raise RuntimeError(payload["error"]["message"])
                text = extract_stream_text(payload)
                if text:
                    yield text
        finally:
            await stream.__aexit__(None, None, None)
            await client.aclose()

    return StreamingResponse(
        body(),
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "no-cache, no-transform"},
    )


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/api/prov-graph")
async def prov_graph(request: Request):
    body = await request.json()
    calls = normalize_tool_calls(body.get("toolCalls"))

    if not calls:
        return {"dag": {"nodes": [], "edges": []}, "cached": False}

    cache_path, public_path = get_cache_path(body.get("traceId"), calls)
    if cache_path.exists():
        return {
            "dag": json.loads(cache_path.read_text()),
            "cached": True,
            "cachePath": public_path,
        }

    summaries = summarize(calls)
    edges = suggested_edges(summaries)
    draft_graph = build_graph(summaries, edges)
    patch = await refine_graph(draft_graph)
    dag = apply_graph_patch(draft_graph, patch, edges)

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(dag, indent=2))

    return {"dag": dag, "cached": False, "cachePath": public_path}


@app.post("/api/provenance-agent")
async def provenance_agent(request: Request):
    body = await request.json()
    question = body.get("question").strip() if isinstance(body.get("question"), str) else ""

    if not question:
        return PlainTextResponse("Question is required.", status_code=400)

    selected_traces = (
        body.get("selectedTraces") if isinstance(body.get("selectedTraces"), list) else []
    )
    messages = build_messages(question, selected_traces, graph_mode(body.get("graphMode")))

    return await stream_chat_response(messages)
