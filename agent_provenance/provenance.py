"""Minimal AgentProvenance interface."""

from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from .dashboard import TraceDashboard, build_dashboard_traces
from .parser import compute_upset_data, extract_tool_call_responses, load_trace_records

TOOL_CALL_KEYS = ("tool_calls", "toolCalls", "calls", "steps")


def _trace_id(trace: Dict[str, Any]) -> Any:
    """Return the best available trace id."""
    return trace.get("id", trace.get("trace_id", str(id(trace))))


def _tool_name(call: Any) -> str:
    """Return the tool name from a tool call record."""
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


def _tool_args(call: Any) -> Any:
    """Return tool arguments from a tool call record."""
    if not isinstance(call, dict):
        return None

    for key in ("args", "arguments", "input"):
        if key in call:
            return call[key]

    function = call.get("function")
    if isinstance(function, dict):
        return function.get("arguments")

    return None


def _top_level_tool_calls(trace: Dict[str, Any]) -> List[Any]:
    """Return top-level tool calls when present."""
    for key in TOOL_CALL_KEYS:
        calls = trace.get(key)
        if isinstance(calls, list):
            return calls
    return []


def _minimal_tool_call(call: Any) -> Optional[Dict[str, Any]]:
    """Normalize a single tool call into the minimal AgentProvenance shape."""
    name = _tool_name(call)
    if not name:
        return None

    tool_call = {
        "id": call.get("id") if isinstance(call, dict) else None,
        "name": name,
        "args": _tool_args(call),
        "response": call.get("response") if isinstance(call, dict) else None,
    }

    if isinstance(call, dict) and call.get("status") is not None:
        tool_call["status"] = call["status"]

    return tool_call


def _minimal_trace(trace: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize any supported trace into {id, tool_calls, score?}."""
    tool_calls = extract_tool_call_responses(trace)
    if not tool_calls:
        tool_calls = [
            tool_call
            for call in _top_level_tool_calls(trace)
            if (tool_call := _minimal_tool_call(call))
        ]

    minimal = {
        "id": _trace_id(trace),
        "tool_calls": tool_calls,
    }

    if trace.get("score") is not None:
        minimal["score"] = trace["score"]

    return minimal


class AgentProvenance:
    """Load traces, summarize tool usage, and render the dashboard."""

    def __init__(
        self,
        data: Optional[Union[str, Path, Dict[str, Any], List[Dict[str, Any]]]] = None,
    ):
        self._traces: List[Dict[str, Any]] = []
        self._upset_data: Optional[Dict[str, Any]] = None

        if data is not None:
            self.load(data)

    def _reset_cache(self) -> None:
        self._upset_data = None

    def _minimalize(
        self, data: Union[str, Path, Dict[str, Any], List[Dict[str, Any]]]
    ) -> List[Dict[str, Any]]:
        return [_minimal_trace(trace) for trace in load_trace_records(data)]

    def load(
        self, data: Union[str, Path, Dict[str, Any], List[Dict[str, Any]]]
    ) -> "AgentProvenance":
        self._traces = self._minimalize(data)
        self._reset_cache()
        return self

    def add_trace(self, trace: Dict[str, Any]) -> "AgentProvenance":
        return self.add_traces([trace])

    def add_traces(self, traces: List[Dict[str, Any]]) -> "AgentProvenance":
        self._traces.extend(self._minimalize(traces))
        self._reset_cache()
        return self

    @property
    def traces(self) -> List[Dict[str, Any]]:
        """Return minimal traces."""
        return self._traces

    @property
    def raw_traces(self) -> List[Dict[str, Any]]:
        """Backward-compatible alias for the minimal trace list."""
        return self._traces

    @property
    def upset_data(self) -> Dict[str, Any]:
        if self._upset_data is None:
            self._upset_data = compute_upset_data(self._traces)
        return self._upset_data

    @property
    def tools(self) -> List[str]:
        return self.upset_data["sets"]

    @property
    def num_traces(self) -> int:
        return len(self._traces)

    def _build_dashboard_view(
        self,
        width: int = 960,
        height: Optional[int] = None,
        title: str = "AgentProvenance Trace Explorer",
        subtitle: str = "Inspect tool provenance across runs.",
        tool_sets: Optional[Dict[str, List[str]]] = None,
    ) -> TraceDashboard:
        return TraceDashboard(
            traces=build_dashboard_traces(self._traces),
            width=width,
            height=height,
            title=title,
            subtitle=subtitle,
            tool_sets=tool_sets,
        )

    def show(self, **kwargs) -> None:
        self._build_dashboard_view(**kwargs).show()

    def summary(self) -> Dict[str, Any]:
        upset = self.upset_data
        return {
            "total_traces": upset["total_traces"],
            "unique_tools": len(upset["sets"]),
            "tools": upset["sets"],
            "unique_combinations": len(upset["intersections"]),
            "most_common_combination": (
                upset["intersections"][0] if upset["intersections"] else None
            ),
        }

    def _repr_html_(self) -> str:
        return self._build_dashboard_view()._repr_html_()

    def __repr__(self) -> str:
        return f"AgentProvenance(traces={self.num_traces}, tools={len(self.tools)})"
