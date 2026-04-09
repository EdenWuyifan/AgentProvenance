"""Minimal AgentProvenance interface."""

from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from .dashboard import TraceDashboard, build_dashboard_traces
from .parser import compute_upset_data, parse_traces


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
        return parse_traces(data)

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
