"""
AgentProvenance: A tool to convert agent traces into interactive provenance dashboards.

This package provides functionality to:
- Parse agent tracing JSON files containing tool calls
- Generate interactive React-backed provenance visualizations
- Display visualizations in Jupyter Notebooks using IPython
"""

from .dashboard import TraceDashboard
from .parser import extract_tool_call_responses, parse_traces
from .provenance import AgentProvenance

__version__ = "0.1.0"
__all__ = [
    "AgentProvenance",
    "TraceDashboard",
    "extract_tool_call_responses",
    "parse_traces",
]
