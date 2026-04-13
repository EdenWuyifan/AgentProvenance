"""
Parser module for extracting minimal trace data from agent tracing payloads.
"""

import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Union

TOOL_CALL_KEYS = ("tool_calls", "toolCalls", "calls", "steps")


def load_trace_records(
    data: Union[str, Path, Dict[str, Any], List[Any]]
) -> List[Dict[str, Any]]:
    """Load raw trace records from JSON, JSONL, or in-memory objects."""
    if isinstance(data, dict):
        return [data]

    if isinstance(data, list):
        if all(isinstance(record, dict) for record in data):
            return data
        if all(isinstance(record, str) for record in data):
            return list(_iter_jsonl_records(data))
        raise ValueError("Trace lists must contain only dictionaries or JSON strings")

    if not isinstance(data, (str, Path)):
        raise ValueError(f"Unsupported input type: {type(data)}")

    path = Path(data)
    if _path_exists(path):
        return _load_path_records(path)

    return _as_trace_list(_parse_json_payload(str(data)))


def parse_traces(
    data: Union[str, Path, Dict[str, Any], List[Any]]
) -> List[Dict[str, Any]]:
    """Parse traces into the minimal AgentProvenance shape."""
    if isinstance(data, (str, Path)):
        path = Path(data)
        if _path_exists(path) and path.suffix == ".jsonl":
            with path.open(encoding="utf-8") as handle:
                return [_minimal_trace(trace, idx) for idx, trace in enumerate(_iter_jsonl_records(handle))]

    return [_minimal_trace(trace, idx) for idx, trace in enumerate(load_trace_records(data))]


def _path_exists(path: Path) -> bool:
    try:
        return path.exists()
    except OSError:
        return False


def _load_path_records(path: Path) -> List[Dict[str, Any]]:
    if path.suffix == ".jsonl":
        with path.open(encoding="utf-8") as handle:
            return list(_iter_jsonl_records(handle))

    return _as_trace_list(_parse_json_payload(path.read_text(encoding="utf-8")))


def _as_trace_list(records: Any) -> List[Dict[str, Any]]:
    if isinstance(records, dict):
        records = [records]

    if not isinstance(records, list):
        raise ValueError("Traces must be a list or dictionary")

    if not all(isinstance(record, dict) for record in records):
        raise ValueError("Each trace must be a dictionary")

    return records


def _parse_json_payload(payload: str) -> Any:
    """Parse payload text as JSON first, then JSONL if needed."""
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return list(_iter_jsonl_records(payload.splitlines()))


def _iter_jsonl_records(lines: Iterable[str]) -> Iterable[Dict[str, Any]]:
    """Yield JSONL records, validating that each line is a trace object."""
    found_record = False

    for line_number, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped:
            continue

        found_record = True
        try:
            record = json.loads(stripped)
        except json.JSONDecodeError as error:
            raise ValueError(f"Invalid JSONL input near line {line_number}") from error

        if not isinstance(record, dict):
            raise ValueError(f"Invalid JSONL input near line {line_number}")

        yield record

    if not found_record:
        raise ValueError("No traces found in input")


def _trace_id(trace: Dict[str, Any], idx: int) -> Any:
    """Return the best available trace id."""
    return trace.get("id", trace.get("trace_id", f"agentrun#{idx}"))


def _top_level_tool_calls(trace: Dict[str, Any]) -> List[Any]:
    """Return top-level tool calls when present."""
    for key in TOOL_CALL_KEYS:
        calls = trace.get(key)
        if isinstance(calls, list):
            return calls
    return []


def _minimal_trace(trace: Dict[str, Any], idx: int) -> Dict[str, Any]:
    """Normalize any supported trace into {id, tool_calls, score?, ...metadata}."""
    tool_calls = extract_tool_call_responses(trace)
    if not tool_calls:
        tool_calls = [
            tool_call
            for call in _top_level_tool_calls(trace)
            if (tool_call := _minimal_tool_call(call))
        ]

    excluded_keys = {"id", "score", "tool_calls", "toolCalls", "calls", "steps", "outputs"}
    metadata = {
        key: value
        for key, value in trace.items()
        if key not in excluded_keys and value is not None and value != "" and not isinstance(value, (dict, list))
    }

    minimal = {
        "id": _trace_id(trace, idx),
        "tool_calls": tool_calls,
        **metadata,
    }

    if trace.get("score") is not None:
        minimal["score"] = trace["score"]

    return minimal


def _minimal_tool_call(call: Any) -> Optional[Dict[str, Any]]:
    """Normalize a single tool call into the minimal AgentProvenance shape."""
    name = _extract_tool_name(call)
    if not name:
        return None

    tool_call = {
        "id": call.get("id", call.get("tool_call_id")) if isinstance(call, dict) else None,
        "name": name,
        "args": _extract_tool_args(call),
        "response": call.get("response") if isinstance(call, dict) else None,
    }

    if isinstance(call, dict) and call.get("status") is not None:
        tool_call["status"] = call["status"]

    return tool_call


def _extract_tool_calls(trace: Dict[str, Any]) -> List[str]:
    """Extract tool call names from a trace dictionary."""
    tool_calls: List[str] = []

    outputs = trace.get("outputs")
    if isinstance(outputs, dict):
        messages = outputs.get("messages")
        if isinstance(messages, list):
            for message in messages:
                if not isinstance(message, dict):
                    continue
                for call in _extract_message_tool_calls(message):
                    tool_name = _extract_tool_name(call)
                    if tool_name:
                        tool_calls.append(tool_name)

    for call in _top_level_tool_calls(trace):
        tool_name = _extract_tool_name(call)
        if tool_name:
            tool_calls.append(tool_name)

    return tool_calls


def _extract_message_tool_calls(message: Dict[str, Any]) -> List[Any]:
    """Extract tool calls from a single chat message."""
    calls = message.get("tool_calls")
    if isinstance(calls, list):
        return calls

    additional_kwargs = message.get("additional_kwargs")
    if isinstance(additional_kwargs, dict):
        calls = additional_kwargs.get("tool_calls")
        if isinstance(calls, list):
            return calls

    return []


def _extract_tool_name(call: Any) -> str:
    """Extract the tool name from a tool call entry."""
    if isinstance(call, str):
        return call

    if not isinstance(call, dict):
        return ""

    for key in ("name", "tool", "tool_name", "toolName", "function", "type"):
        value = call.get(key)
        if isinstance(value, str):
            return value
        if isinstance(value, dict) and isinstance(value.get("name"), str):
            return value["name"]

    return ""


def _extract_tool_args(call: Any) -> Any:
    """Extract tool arguments from a raw tool call record."""
    if not isinstance(call, dict):
        return None

    for key in ("args", "arguments", "input"):
        if key in call:
            return call[key]

    function = call.get("function")
    if isinstance(function, dict):
        return function.get("arguments")

    return None


def extract_tool_call_responses(trace: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Extract ordered tool calls and matching tool responses from outputs.messages."""
    outputs = trace.get("outputs")
    if not isinstance(outputs, dict):
        return []

    messages = outputs.get("messages")
    if not isinstance(messages, list):
        return []

    pairs: List[Dict[str, Any]] = []
    pairs_by_id: Dict[str, Dict[str, Any]] = {}

    for message in messages:
        if not isinstance(message, dict):
            continue

        for call in _extract_message_tool_calls(message):
            pair = {
                "id": call.get("id") if isinstance(call, dict) else None,
                "name": _extract_tool_name(call),
                "args": _extract_tool_args(call),
                "response": None,
            }

            if not pair["name"]:
                continue

            pairs.append(pair)
            if pair["id"]:
                pairs_by_id[pair["id"]] = pair

        if message.get("type") != "tool" and message.get("role") != "tool":
            continue

        tool_call_id = message.get("tool_call_id")
        if isinstance(tool_call_id, str) and tool_call_id in pairs_by_id:
            pairs_by_id[tool_call_id]["response"] = message.get("content")

    return pairs


def extract_tool_sets(traces: List[Dict[str, Any]]) -> List[Set[str]]:
    """Extract sets of tools used in each trace."""
    return [
        {
            tool_name
            for call in trace.get("tool_calls", [])
            if (tool_name := _extract_tool_name(call))
        }
        for trace in traces
    ]


def compute_upset_data(traces: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Compute the data structure needed for the UpSet plot."""
    tool_sets = extract_tool_sets(traces)

    all_tools = sorted({tool for tool_set in tool_sets for tool in tool_set})

    combination_counts: Dict[tuple, int] = {}
    for tool_set in tool_sets:
        key = tuple(sorted(tool_set))
        combination_counts[key] = combination_counts.get(key, 0) + 1

    intersections = [
        {"sets": list(combo), "size": count}
        for combo, count in sorted(
            combination_counts.items(), key=lambda item: (-item[1], item[0])
        )
    ]

    return {
        "sets": all_tools,
        "intersections": intersections,
        "total_traces": len(traces),
    }
