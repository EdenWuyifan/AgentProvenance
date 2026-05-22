import json
import os
import re
from typing import Any, Callable

from fastapi.responses import PlainTextResponse, StreamingResponse
from portkey_ai import AsyncPortkey


MAX_ARRAY_ITEMS = 12
MAX_OBJECT_KEYS = 16
MAX_STRING_LENGTH = 600
DEFAULT_MODEL_REQUESTS = 10
DEFAULT_TOOL_CALLS = 48
DEFAULT_MAX_TOKENS = 65536
DEFAULT_THINKING_BUDGET = 32768


def env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if not value:
        return default
    try:
        return max(1, int(value))
    except ValueError:
        return default


def event_line(kind: str, **data: Any) -> str:
    return json.dumps({"type": kind, **data}, default=str) + "\n"


def content_blocks(value: Any) -> list[dict[str, Any]]:
    blocks = value.get("content_blocks") if isinstance(value, dict) else None
    return [block for block in blocks or [] if isinstance(block, dict)]


def split_content_blocks(blocks: list[dict[str, Any]]) -> tuple[str, str]:
    thinking: list[str] = []
    text: list[str] = []

    for block in blocks:
        delta = block.get("delta") if isinstance(block.get("delta"), dict) else block
        if block.get("type") == "thinking" or delta.get("thinking"):
            thinking.append(str(delta.get("thinking") or ""))
        elif block.get("type") == "text" or delta.get("text"):
            text.append(str(delta.get("text") or ""))

    return "".join(thinking), "".join(text)


def message_text(payload: dict[str, Any]) -> tuple[str, str]:
    thinking, text = split_content_blocks(content_blocks(payload))
    if not text and isinstance(payload.get("content"), str):
        text = payload["content"]
    return thinking, text


def parse_json_args(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {"INVALID_JSON": value}
    return parsed if isinstance(parsed, dict) else {"value": parsed}


def graph_mode(value: Any) -> str:
    return value if value in {"collapsed", "tree", "comparison"} else "tree"


def compact(value: Any, depth: int = 0) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value if len(value) <= MAX_STRING_LENGTH else f"{value[:MAX_STRING_LENGTH]}..."
    if depth >= 4:
        return "[truncated]"
    if isinstance(value, list):
        items = [compact(item, depth + 1) for item in value[:MAX_ARRAY_ITEMS]]
        if len(value) > MAX_ARRAY_ITEMS:
            items.append(f"[+{len(value) - MAX_ARRAY_ITEMS} more]")
        return items
    if isinstance(value, dict):
        entries = list(value.items())
        result = {
            str(key): compact(item, depth + 1)
            for key, item in entries[:MAX_OBJECT_KEYS]
        }
        if len(entries) > MAX_OBJECT_KEYS:
            result["__truncated__"] = f"{len(entries) - MAX_OBJECT_KEYS} more keys"
        return result
    return str(value)


def trace_id(trace: dict[str, Any]) -> str:
    return str(trace.get("id"))


def tool_calls(trace: dict[str, Any]) -> list[dict[str, Any]]:
    return [call for call in trace.get("toolCalls", []) if isinstance(call, dict)]


def tool_sequence(trace: dict[str, Any]) -> list[str]:
    return [str(call.get("name") or "") for call in tool_calls(trace)]


def trace_score(score: Any) -> float | None:
    return round(score, 3) if isinstance(score, (int, float)) else None


def trace_metadata(trace: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in trace.items()
        if key not in {"id", "score", "toolCalls"}
        and value is not None
        and not isinstance(value, (dict, list))
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


def tokens(value: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[A-Za-z0-9._:-]+", value.lower())
        if len(token.strip("._:-")) > 1
    }


def chat_history(value: Any) -> list[dict[str, str]]:
    history = []

    for message in value if isinstance(value, list) else []:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = message.get("content")
        if role in {"user", "assistant"} and isinstance(content, str) and content.strip():
            history.append({"role": role, "content": content.strip()})

    return history[-12:]


class CopilotStore:
    def __init__(self, body: dict[str, Any]) -> None:
        self.question = body.get("question").strip() if isinstance(body.get("question"), str) else ""
        self.chat_history = chat_history(body.get("chatHistory"))
        self.mode = graph_mode(body.get("graphMode"))
        self.traces = [
            trace for trace in body.get("selectedTraces", [])
            if isinstance(trace, dict)
        ]
        self.trace_by_id = {trace_id(trace): trace for trace in self.traces}
        self.dags = self.normalize_dags(body.get("selectedTraceDags"))
        self.joined_graph = body.get("joinedGraph") if isinstance(body.get("joinedGraph"), dict) else None

    def normalize_dags(self, value: Any) -> dict[str, dict[str, Any]]:
        if isinstance(value, dict):
            return {
                str(key): dag
                for key, dag in value.items()
                if isinstance(dag, dict)
            }
        if isinstance(value, list):
            return {
                str(item.get("traceId")): item["dag"]
                for item in value
                if isinstance(item, dict) and isinstance(item.get("dag"), dict)
            }
        return {}

    def initial_context(self) -> dict[str, Any]:
        return {
            "graphView": self.mode,
            "selectedTraceIds": [trace_id(trace) for trace in self.traces],
            "selectedTraceCount": len(self.traces),
            "scoreSummary": score_summary(self.traces),
            "hasJoinedGraph": self.joined_graph is not None,
            "traceGraphsAvailable": sorted(self.dags),
            "traces": [self.trace_summary(trace) for trace in self.traces],
        }

    def trace_summary(self, trace: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": trace_id(trace),
            "score": trace_score(trace.get("score")),
            "metadata": trace_metadata(trace),
            "toolSequence": tool_sequence(trace),
            "toolCallCount": len(tool_calls(trace)),
        }

    def call_tool(self, name: str, args: dict[str, Any]) -> Any:
        print(f"[copilot] tool={name} args={args}", flush=True)
        tools = {
            "list_traces": self.list_traces,
            "list_tool_calls": self.list_tool_calls,
            "get_tool_call_io": self.get_tool_call_io,
            "search_tool_calls": self.search_tool_calls,
            "get_prov_graph": self.get_prov_graph,
            "get_graph_node": self.get_graph_node,
            "get_graph_edge": self.get_graph_edge,
            "get_joined_graph": self.get_joined_graph,
            "get_joined_node": self.get_joined_node,
            "get_joined_edge": self.get_joined_edge,
            "expand_joined_anchor": self.expand_joined_anchor,
        }
        tool = tools.get(name)
        return tool(args) if tool else {"error": f"Unknown tool: {name}"}

    def get_trace(self, trace_id_value: Any = None) -> dict[str, Any] | None:
        if trace_id_value is None and len(self.traces) == 1:
            return self.traces[0]
        return self.trace_by_id.get(str(trace_id_value))

    def find_call(self, trace: dict[str, Any], args: dict[str, Any]) -> tuple[int, dict[str, Any]] | None:
        calls = tool_calls(trace)
        step = args.get("step")
        if isinstance(step, int) and 1 <= step <= len(calls):
            return step, calls[step - 1]

        call_id = args.get("callId")
        if call_id is not None:
            for index, call in enumerate(calls, start=1):
                if str(call.get("id")) == str(call_id):
                    return index, call
        return None

    def list_traces(self, _: dict[str, Any]) -> Any:
        return {"traces": [self.trace_summary(trace) for trace in self.traces]}

    def list_tool_calls(self, args: dict[str, Any]) -> Any:
        traces = [self.get_trace(args.get("traceId"))] if args.get("traceId") is not None else self.traces
        return {
            "traces": [
                {
                    "traceId": trace_id(trace),
                    "toolCalls": [
                        {
                            "step": index + 1,
                            "id": call.get("id"),
                            "name": call.get("name"),
                            "status": call.get("status"),
                            "hasArgs": call.get("args") is not None,
                            "hasResponse": call.get("response") is not None,
                        }
                        for index, call in enumerate(tool_calls(trace))
                    ],
                }
                for trace in traces
                if trace
            ]
        }

    def get_tool_call_io(self, args: dict[str, Any]) -> Any:
        trace = self.get_trace(args.get("traceId"))
        if not trace:
            return {"error": "Trace not found."}
        found = self.find_call(trace, args)
        if not found:
            return {"error": "Tool call not found."}

        step, call = found
        include = args.get("include") if args.get("include") in {"args", "response", "both"} else "both"
        full = bool(args.get("full"))
        result = {
            "traceId": trace_id(trace),
            "step": step,
            "id": call.get("id"),
            "name": call.get("name"),
            "status": call.get("status"),
        }
        if include in {"args", "both"}:
            result["args"] = call.get("args") if full else compact(call.get("args"))
        if include in {"response", "both"}:
            result["response"] = call.get("response") if full else compact(call.get("response"))
        return result

    def search_tool_calls(self, args: dict[str, Any]) -> Any:
        query_tokens = tokens(str(args.get("query") or ""))
        trace_filter = {str(item) for item in args.get("traceIds", []) if item is not None}
        matches = []

        for trace in self.traces:
            if trace_filter and trace_id(trace) not in trace_filter:
                continue
            for index, call in enumerate(tool_calls(trace), start=1):
                text = json.dumps(call, ensure_ascii=False, default=str).lower()
                matched = sorted(token for token in query_tokens if token in text)
                if matched:
                    matches.append(
                        {
                            "traceId": trace_id(trace),
                            "step": index,
                            "id": call.get("id"),
                            "name": call.get("name"),
                            "matched": matched[:12],
                        }
                    )

        return {"matches": matches[:16]}

    def get_prov_graph(self, args: dict[str, Any]) -> Any:
        trace = self.get_trace(args.get("traceId"))
        if not trace:
            return {"error": "Trace not found."}
        dag = self.dags.get(trace_id(trace))
        if not dag:
            return {"error": "Displayed PROV graph is not available for this trace."}
        return {
            "traceId": trace_id(trace),
            "nodes": [self.compact_graph_node(node) for node in dag.get("nodes", [])],
            "edges": [compact(edge) for edge in dag.get("edges", [])],
        }

    def get_graph_node(self, args: dict[str, Any]) -> Any:
        dag = self.dags.get(str(args.get("traceId")))
        node_id = args.get("nodeId")
        if not dag or not isinstance(node_id, str):
            return {"error": "Trace graph or nodeId not found."}
        node = next((item for item in dag.get("nodes", []) if item.get("id") == node_id), None)
        if not node:
            return {"error": "Node not found."}
        return {
            "node": compact(node),
            "incoming": [edge for edge in dag.get("edges", []) if edge.get("target") == node_id],
            "outgoing": [edge for edge in dag.get("edges", []) if edge.get("source") == node_id],
        }

    def get_graph_edge(self, args: dict[str, Any]) -> Any:
        dag = self.dags.get(str(args.get("traceId")))
        if not dag:
            return {"error": "Trace graph not found."}
        source = args.get("source")
        target = args.get("target")
        relation = args.get("relation")
        return {
            "edges": compact(
                [
                    edge
                    for edge in dag.get("edges", [])
                    if (source is None or edge.get("source") == source)
                    and (target is None or edge.get("target") == target)
                    and (relation is None or edge.get("relation") == relation)
                ]
            )
        }

    def get_joined_graph(self, _: dict[str, Any]) -> Any:
        if not self.joined_graph:
            return {"error": "Joined graph is not available."}
        return {
            "nodes": [
                {
                    "id": node.get("id"),
                    "kind": node.get("kind"),
                    "label": node.get("label"),
                    "supportTraces": node.get("supportTraces"),
                    "supportCount": node.get("supportCount"),
                    "confidence": node.get("confidence"),
                    "scoreSummary": node.get("scoreSummary"),
                }
                for node in self.joined_graph.get("nodes", [])
            ],
            "edges": [
                {
                    "id": edge.get("id"),
                    "source": edge.get("source"),
                    "target": edge.get("target"),
                    "supportTraces": edge.get("supportTraces"),
                    "supportCount": edge.get("supportCount"),
                    "relationTypes": edge.get("relationTypes"),
                    "scoreSummary": edge.get("scoreSummary"),
                }
                for edge in self.joined_graph.get("edges", [])
            ],
            "motifs": compact(self.joined_graph.get("motifs")),
            "scoreSummary": self.joined_graph.get("scoreSummary"),
        }

    def get_joined_node(self, args: dict[str, Any]) -> Any:
        node = self.joined_node(args.get("nodeId"))
        return compact(node) if node else {"error": "Joined node not found."}

    def get_joined_edge(self, args: dict[str, Any]) -> Any:
        edge = self.joined_edge(args)
        return compact(edge) if edge else {"error": "Joined edge not found."}

    def expand_joined_anchor(self, args: dict[str, Any]) -> Any:
        anchor = str(args.get("anchor") or "")
        if anchor.startswith("E"):
            edge = self.joined_edge({"edgeId": anchor})
            return compact(edge or {"error": "Joined edge not found."})

        node = self.joined_node(anchor)
        if not node:
            return {"error": "Joined node not found."}
        return {
            "nodeId": node.get("id"),
            "label": node.get("label"),
            "members": compact(node.get("members")),
            "rootSetsByTrace": compact(node.get("rootSetsByTrace")),
        }

    def joined_node(self, node_id: Any) -> dict[str, Any] | None:
        if not self.joined_graph or not isinstance(node_id, str):
            return None
        return next(
            (node for node in self.joined_graph.get("nodes", []) if node.get("id") == node_id),
            None,
        )

    def joined_edge(self, args: dict[str, Any]) -> dict[str, Any] | None:
        if not self.joined_graph:
            return None
        edge_id = args.get("edgeId")
        source = args.get("source")
        target = args.get("target")
        return next(
            (
                edge
                for edge in self.joined_graph.get("edges", [])
                if (edge_id is None or edge.get("id") == edge_id)
                and (source is None or edge.get("source") == source)
                and (target is None or edge.get("target") == target)
            ),
            None,
        )

    def compact_graph_node(self, node: dict[str, Any]) -> dict[str, Any]:
        return {
            key: compact(node.get(key))
            for key in ("id", "kind", "tool", "toolCallId", "timeIndex", "entityType", "args", "response")
            if key in node
        }


def system_prompt() -> str:
    return """You are AgentProvenance Copilot.
Answer only from selected traces and displayed provenance graph data.
For every turn, decide whether to answer directly or use tools.
Answer directly for greetings, small talk, and questions already answered by the initial selected context.
Use tools when graph structure, support, scores, anchors, tool arguments, outputs, concrete data values, or comparisons need more evidence.
After each tool result, decide again: answer if evidence is sufficient, or call another targeted tool if more evidence is needed.
The initial context already lists selected traces, scores, and tool sequences; do not use tools just to repeat that overview.

Investigation protocol:
- Overview tools are for orientation, not final evidence for detailed questions.
- If an overview reveals relevant IDs, inspect the specific node, edge, anchor, or tool call before answering.
- For "why", "how", "compare", "difference", "support", "input", "output", or "what happened" questions, prefer at least one overview tool and one specific evidence tool.
- Stop calling tools when the next answer can cite concrete trace IDs, joined IDs, node IDs, edge IDs, or tool-call steps.

Single selected trace:
- Use get_prov_graph for graph structure.
- Use get_graph_node/get_graph_edge for specific graph evidence.
- Use list_tool_calls or search_tool_calls first, then get_tool_call_io for exact tool inputs/outputs.
- Use full=true only for one specific call when truncated summaries are insufficient.

Multiple selected traces:
- Use get_joined_graph for comparison, support, score, or motif questions.
- Use get_joined_node/get_joined_edge for specific joined graph evidence.
- Use expand_joined_anchor to map joined nodes/edges to underlying trace calls.
- Use get_tool_call_io for concrete per-trace evidence.

Be concise. Cite trace IDs, joined IDs, node IDs, and tool-call steps when they support the answer. If needed context is unavailable, say so directly."""


def user_prompt(store: CopilotStore) -> str:
    return (
        "Initial selected context:\n"
        f"{json.dumps(store.initial_context(), indent=2, default=str)}\n\n"
        f"Question:\n{store.question}"
    )


def tool_definitions() -> list[dict[str, Any]]:
    def tool(name: str, description: str, properties: dict[str, Any], required: list[str] | None = None):
        return {
            "type": "function",
            "function": {
                "name": name,
                "description": description,
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": required or [],
                },
            },
        }

    return [
        tool(
            "list_tool_calls",
            "List tool-call IDs and steps for one selected trace, or all selected traces.",
            {"traceId": {"type": "string"}},
        ),
        tool(
            "get_tool_call_io",
            "Read exact args and/or response for one selected tool call.",
            {
                "traceId": {"type": "string"},
                "step": {"type": "integer"},
                "callId": {"type": "string"},
                "include": {"type": "string", "enum": ["args", "response", "both"]},
                "full": {"type": "boolean"},
            },
        ),
        tool(
            "search_tool_calls",
            "Search selected tool calls by keyword, ID, tool name, args, or response text.",
            {
                "query": {"type": "string"},
                "traceIds": {"type": "array", "items": {"type": "string"}},
            },
            ["query"],
        ),
        tool(
            "get_prov_graph",
            "Read the displayed single-trace PROV DAG overview.",
            {"traceId": {"type": "string"}},
        ),
        tool(
            "get_graph_node",
            "Read one node and adjacent edges from a selected trace PROV DAG.",
            {"traceId": {"type": "string"}, "nodeId": {"type": "string"}},
            ["traceId", "nodeId"],
        ),
        tool(
            "get_graph_edge",
            "Read matching edges from a selected trace PROV DAG.",
            {
                "traceId": {"type": "string"},
                "source": {"type": "string"},
                "target": {"type": "string"},
                "relation": {"type": "string", "enum": ["usedBy", "generatedBy", "informedBy"]},
            },
            ["traceId"],
        ),
        tool("get_joined_graph", "Read the displayed joined provenance graph overview.", {}),
        tool(
            "get_joined_node",
            "Read one joined graph node, including support traces, signatures, and members.",
            {"nodeId": {"type": "string"}},
            ["nodeId"],
        ),
        tool(
            "get_joined_edge",
            "Read one joined graph edge by ID or source/target.",
            {"edgeId": {"type": "string"}, "source": {"type": "string"}, "target": {"type": "string"}},
        ),
        tool(
            "expand_joined_anchor",
            "Expand a joined anchor such as C5, R1, or E2 to underlying trace evidence and member calls.",
            {"anchor": {"type": "string"}},
            ["anchor"],
        ),
    ]


def model_messages(store: CopilotStore) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": [{"type": "text", "text": system_prompt()}]},
        *store.chat_history,
        {"role": "user", "content": user_prompt(store)},
    ]


def request_kwargs(model: str, messages: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "model": model,
        "max_tokens": env_int("COPILOT_MAX_TOKENS", DEFAULT_MAX_TOKENS),
        "thinking": {
            "type": "enabled",
            "budget_tokens": env_int("COPILOT_THINKING_BUDGET", DEFAULT_THINKING_BUDGET),
        },
        "stream": True,
        "messages": messages,
        "tools": tool_definitions(),
    }


def chunk_payload(chunk: Any) -> dict[str, Any]:
    return chunk.model_dump() if hasattr(chunk, "model_dump") else dict(chunk)


def update_tool_call(tool_calls: dict[str, dict[str, Any]], index: int, raw_call: dict[str, Any]) -> None:
    key = str(raw_call.get("id") or raw_call.get("index") or index)
    call = tool_calls.setdefault(
        key,
        {"id": raw_call.get("id") or f"portkey-tool-{index}", "type": "function", "function": {"name": "", "arguments": ""}},
    )
    if raw_call.get("id"):
        call["id"] = raw_call["id"]
    if raw_call.get("type"):
        call["type"] = raw_call["type"]

    function = raw_call.get("function") if isinstance(raw_call.get("function"), dict) else {}
    target = call["function"]
    if function.get("name"):
        target["name"] = function["name"]
    if function.get("arguments"):
        target["arguments"] = f"{target.get('arguments', '')}{function['arguments']}"
    if function.get("thought_signature"):
        target["thought_signature"] = f"{target.get('thought_signature', '')}{function['thought_signature']}"


async def stream_model_round(client: AsyncPortkey, model: str, messages: list[dict[str, Any]]):
    text = ""
    tool_calls: dict[str, dict[str, Any]] = {}
    stream = await client.chat.completions.create(**request_kwargs(model, messages))

    async for chunk in stream:
        payload = chunk_payload(chunk)
        choices = payload.get("choices") or []
        if not choices:
            continue
        choice = choices[0]
        message = choice.get("delta") or choice.get("message") or {}
        thinking_delta, text_delta = message_text(message)

        if thinking_delta:
            yield {"type": "thinking_delta", "delta": thinking_delta}
        if text_delta:
            text += text_delta
            yield {"type": "message_delta", "delta": text_delta}

        for index, raw_call in enumerate(message.get("tool_calls") or []):
            update_tool_call(tool_calls, index, raw_call)

    yield {
        "type": "round_done",
        "text": text,
        "tool_calls": list(tool_calls.values()),
    }


async def provenance_agent_response(
    body: dict[str, Any],
    client_factory: Callable[[], tuple[AsyncPortkey, str]],
):
    store = CopilotStore(body)
    if not store.question:
        return PlainTextResponse("Question is required.", status_code=400)

    try:
        client, model = client_factory()
    except RuntimeError as error:
        return PlainTextResponse(str(error), status_code=500)

    async def stream():
        messages = model_messages(store)
        tool_call_count = 0

        try:
            for _ in range(env_int("COPILOT_MODEL_REQUESTS", DEFAULT_MODEL_REQUESTS)):
                round_text = ""
                round_tool_calls: list[dict[str, Any]] = []

                async for event in stream_model_round(client, model, messages):
                    if event["type"] == "round_done":
                        round_text = event["text"]
                        round_tool_calls = event["tool_calls"]
                    else:
                        yield event_line(event["type"], **{key: value for key, value in event.items() if key != "type"})

                if not round_tool_calls:
                    yield event_line("final", output=round_text)
                    return

                messages.append({"role": "assistant", "content": round_text, "tool_calls": round_tool_calls})

                for call in round_tool_calls:
                    tool_call_count += 1
                    if tool_call_count > env_int("COPILOT_TOOL_CALLS", DEFAULT_TOOL_CALLS):
                        yield event_line("error", message="Copilot tool budget reached.")
                        return

                    function = call.get("function") or {}
                    tool_name = str(function.get("name") or "")
                    args = parse_json_args(function.get("arguments"))

                    yield event_line("tool_call", id=call["id"], name=tool_name, args=compact(args))
                    result = store.call_tool(tool_name, args)
                    yield event_line("tool_result", id=call["id"], name=tool_name, result=compact(result))
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call["id"],
                            "content": json.dumps(result, default=str),
                        }
                    )

            yield event_line("error", message="Copilot model request budget reached.")
        except Exception as error:
            print(f"[copilot] request failed: {type(error).__name__}: {error}", flush=True)
            yield event_line("error", message=str(error))
        finally:
            await client.close()

    return StreamingResponse(
        stream(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache, no-transform"},
    )
