"""
Parser module for extracting tool calls from agent tracing JSON data.
"""

import json
from pathlib import Path
from typing import Any, Dict, List, Set, Union

# Keys that contain tool call data and should not be copied to metadata
TOOL_CALL_KEYS = frozenset(["tool_calls", "toolCalls", "calls", "steps"])
# Keys that identify a trace and should not be copied to metadata
ID_KEYS = frozenset(["id", "trace_id"])
# Keys that are promoted to the normalized trace root
PASSTHROUGH_KEYS = frozenset(["inputs", "outputs", "score"])
# All reserved keys that should not be copied to metadata
RESERVED_KEYS = TOOL_CALL_KEYS | ID_KEYS | PASSTHROUGH_KEYS


def load_trace_records(
    data: Union[str, Path, Dict[str, Any], List[Dict[str, Any]]]
) -> List[Dict[str, Any]]:
    """
    Load raw trace records from JSON, JSONL, or in-memory objects.

    Args:
        data: Can be one of:
            - A file path (str or Path) to a JSON or JSONL file
            - A JSON or JSONL string
            - A trace dictionary
            - A list of trace dictionaries

    Returns:
        A list of raw trace dictionaries.

    Raises:
        ValueError: If the input format is not supported or invalid.
    """
    if isinstance(data, (str, Path)):
        text_or_path = Path(data)
        try:
            path_exists = text_or_path.exists()
        except OSError:
            path_exists = False

        if path_exists:
            payload = text_or_path.read_text(encoding="utf-8")
        else:
            payload = str(data)

        records = _parse_json_payload(payload)
    elif isinstance(data, dict):
        records = [data]
    elif isinstance(data, list):
        records = data
    else:
        raise ValueError(f"Unsupported input type: {type(data)}")

    if isinstance(records, dict):
        records = [records]

    if not isinstance(records, list):
        raise ValueError("Traces must be a list or dictionary")

    return records


def parse_traces(
    data: Union[str, Path, Dict[str, Any], List[Dict[str, Any]]]
) -> List[Dict[str, Any]]:
    """
    Parse agent tracing data from various input formats.

    Args:
        data: Can be one of:
            - A file path (str or Path) to a JSON file
            - A JSON string
            - A trace dictionary
            - A list of trace dictionaries

    Returns:
        A list of trace dictionaries, each containing tool call information.

    Raises:
        ValueError: If the input format is not supported or invalid.
        FileNotFoundError: If the specified file does not exist.
    """
    return _normalize_traces(load_trace_records(data))


def _parse_json_payload(payload: str) -> Any:
    """Parse payload text as JSON first, then JSONL if needed."""
    try:
        return json.loads(payload)
    except json.JSONDecodeError as json_error:
        lines = [line.strip() for line in payload.splitlines() if line.strip()]
        if not lines:
            raise ValueError("No traces found in input") from json_error

        records = []
        try:
            for line_number, line in enumerate(lines, start=1):
                records.append(json.loads(line))
        except json.JSONDecodeError as jsonl_error:
            raise ValueError(
                f"Invalid JSON or JSONL input near line {line_number}"
            ) from jsonl_error

        return records


def _normalize_traces(traces: Any) -> List[Dict[str, Any]]:
    """
    Normalize trace data into a consistent format.

    Args:
        traces: Raw trace data (can be a list or single trace dict).

    Returns:
        A list of normalized trace dictionaries.
    """
    if isinstance(traces, dict):
        traces = [traces]

    if not isinstance(traces, list):
        raise ValueError("Traces must be a list or dictionary")

    normalized = []
    for trace in traces:
        normalized.append(_normalize_single_trace(trace))

    return normalized


def _normalize_single_trace(trace: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalize a single trace entry.

    Args:
        trace: A single trace dictionary.

    Returns:
        Normalized trace dictionary with consistent structure.
    """
    normalized: Dict[str, Any] = {
        "id": trace.get("id", trace.get("trace_id", str(id(trace)))),
        "tool_calls": [],
        "metadata": {},
    }

    # Extract tool calls from various possible formats
    tool_calls = _extract_tool_calls(trace)
    normalized["tool_calls"] = tool_calls

    if "score" in trace:
        normalized["score"] = trace.get("score")
    if "inputs" in trace:
        normalized["inputs"] = trace.get("inputs")
    if "outputs" in trace:
        normalized["outputs"] = trace.get("outputs")

    tool_call_details = _extract_tool_call_details(trace)
    if tool_call_details:
        normalized["tool_call_details"] = tool_call_details

    # Preserve any additional metadata
    for key, value in trace.items():
        if key not in RESERVED_KEYS:
            normalized["metadata"][key] = value

    return normalized


def _extract_tool_calls(trace: Dict[str, Any]) -> List[str]:
    """
    Extract tool call names from a trace dictionary.

    Supports multiple common formats for tool call data.

    Args:
        trace: A trace dictionary.

    Returns:
        A list of tool names that were called.
    """
    tool_calls: List[str] = []

    outputs = trace.get("outputs")
    if isinstance(outputs, dict):
        messages = outputs.get("messages")
        if isinstance(messages, list):
            for message in messages:
                if not isinstance(message, dict):
                    continue
                calls = _extract_message_tool_calls(message)
                for call in calls:
                    tool_name = _extract_tool_name(call)
                    if tool_name:
                        tool_calls.append(tool_name)

    # Check common key names for tool calls
    for key in ["tool_calls", "toolCalls", "calls", "steps"]:
        if key in trace:
            calls = trace[key]
            if isinstance(calls, list):
                for call in calls:
                    tool_name = _extract_tool_name(call)
                    if tool_name:
                        tool_calls.append(tool_name)

    return tool_calls


def _extract_tool_call_details(trace: Dict[str, Any]) -> List[Any]:
    """Preserve the original top-level tool call payload when available."""
    for key in ["tool_calls", "toolCalls", "calls", "steps"]:
        calls = trace.get(key)
        if isinstance(calls, list):
            return calls
    return []


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
    """
    Extract the tool name from a tool call entry.

    Args:
        call: A tool call entry (can be string, dict, etc.).

    Returns:
        The tool name as a string, or empty string if not found.
    """
    if isinstance(call, str):
        return call
    elif isinstance(call, dict):
        # Check common key names for tool name
        for key in ["name", "tool", "tool_name", "toolName", "function", "type"]:
            if key in call:
                name = call[key]
                if isinstance(name, str):
                    return name
                elif isinstance(name, dict) and "name" in name:
                    return name["name"]
    return ""


def _extract_tool_args(call: Any) -> Any:
    """Extract tool arguments from a raw tool call record."""
    if not isinstance(call, dict):
        return None

    for key in ["args", "arguments", "input"]:
        if key in call:
            return call[key]

    function = call.get("function")
    if isinstance(function, dict):
        return function.get("arguments")

    return None


def extract_tool_call_responses(trace: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Extract ordered tool calls and their responses from an OpenAI-style trace.

    Args:
        trace: A single trace dictionary containing outputs.messages.

    Returns:
        A list of dictionaries with ``id``, ``name``, ``args``, and ``response``.
        If a tool call has no matching tool response, ``response`` is ``None``.
    """
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

        if message.get("type") != "tool":
            continue

        tool_call_id = message.get("tool_call_id")
        if isinstance(tool_call_id, str) and tool_call_id in pairs_by_id:
            pairs_by_id[tool_call_id]["response"] = message.get("content")

    return pairs


def extract_tool_sets(traces: List[Dict[str, Any]]) -> List[Set[str]]:
    """
    Extract sets of tools used in each trace.

    Args:
        traces: A list of normalized trace dictionaries.

    Returns:
        A list of sets, where each set contains the unique tools used in that trace.
    """
    return [
        {
            tool_name
            for call in trace.get("tool_calls", [])
            if (tool_name := _extract_tool_name(call))
        }
        for trace in traces
    ]


def compute_upset_data(traces: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Compute data structure needed for UpSet plot visualization.

    Args:
        traces: A list of normalized trace dictionaries.

    Returns:
        A dictionary containing:
        - sets: List of all unique tools
        - intersections: List of intersection data for the UpSet plot
    """
    tool_sets = extract_tool_sets(traces)

    # Get all unique tools
    all_tools = set()
    for ts in tool_sets:
        all_tools.update(ts)
    all_tools = sorted(list(all_tools))

    # Count occurrences of each unique combination
    combination_counts: Dict[tuple, int] = {}
    for ts in tool_sets:
        key = tuple(sorted(ts))
        combination_counts[key] = combination_counts.get(key, 0) + 1

    # Build intersection data
    intersections = []
    for combo, count in sorted(combination_counts.items(), key=lambda x: (-x[1], x[0])):
        intersections.append({
            "sets": list(combo),
            "size": count
        })

    return {
        "sets": all_tools,
        "intersections": intersections,
        "total_traces": len(traces)
    }
