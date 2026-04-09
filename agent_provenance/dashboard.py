"""Standalone React-style UpSet dashboard HTML view."""

import json
import uuid
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Optional

RENDERER_FILES = (
    "agent_provenance_react/app/components/visualization_shared.js",
    "agent_provenance_react/app/components/upset_plot.js",
)

D3_CDN_URL = "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"
D3_SRI_HASH = "sha512-vc58qvvBdrDR4etbxMdlTt4GBQk1qjvyORR2nrsPsFPyrs+/u5c3+1Ct6upOgdZoIl7eq6k3a1UPDSNAQi/32A=="


def build_dashboard_traces(traces: List[Dict[str, object]]) -> List[Dict[str, object]]:
    """Return dashboard-safe copies of trace payloads."""
    return [deepcopy(trace) for trace in traces]


def _strip_module_syntax(source: str) -> str:
    """Convert small ES module files into plain script content."""
    transformed: List[str] = []
    skipping_import = False

    for line in source.splitlines():
        stripped = line.strip()

        if skipping_import:
            if ";" in stripped:
                skipping_import = False
            continue

        if stripped == '"use client";':
            continue

        if stripped.startswith("import "):
            if not stripped.endswith(";"):
                skipping_import = True
            continue

        if stripped.startswith("export function "):
            line = line.replace("export function ", "function ", 1)
        elif stripped.startswith("export const "):
            line = line.replace("export const ", "const ", 1)
        elif stripped.startswith("export {"):
            continue

        transformed.append(line)

    return "\n".join(transformed)


@lru_cache(maxsize=1)
def load_renderer_bundle() -> str:
    """Load the React-side UpSet renderer sources for notebook HTML."""
    repo_root = Path(__file__).resolve().parent.parent
    parts: List[str] = []

    for relative_path in RENDERER_FILES:
        source_path = repo_root / relative_path
        if not source_path.exists():
            raise FileNotFoundError(
                f"Dashboard renderer source not found: {source_path}"
            )
        parts.append(_strip_module_syntax(source_path.read_text(encoding="utf-8")))

    return "\n\n".join(parts)


class TraceDashboard:
    """Standalone HTML dashboard for the React-style UpSet view."""

    def __init__(
        self,
        traces: List[Dict[str, object]],
        width: int = 960,
        height: Optional[int] = None,
        title: str = "AgentProvenance Trace Explorer",
        subtitle: str = "Inspect tool provenance across runs.",
        tool_sets: Optional[Dict[str, List[str]]] = None,
    ):
        self.traces = traces
        self.width = width
        self.height = height
        self.title = title
        self.subtitle = subtitle
        self.tool_sets = tool_sets or {}
        self._plot_id = f"agentprovenance-dashboard-{uuid.uuid4().hex[:8]}"

    def to_html(self, include_d3: bool = True) -> str:
        """Generate a standalone HTML document for the dashboard."""
        d3_script = ""
        if include_d3:
            d3_script = (
                f'<script src="{D3_CDN_URL}" '
                f'integrity="{D3_SRI_HASH}" '
                'crossorigin="anonymous"></script>'
            )

        return f"""
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>{self.title}</title>
    {d3_script}
    <style>
        {self._get_css()}
    </style>
</head>
<body>
    {self._get_markup()}
    <script>
        {self._get_javascript()}
    </script>
</body>
</html>
"""

    def save(self, filepath: str) -> None:
        """Save the dashboard HTML to disk."""
        path = Path(filepath)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.to_html(), encoding="utf-8")

    def _repr_html_(self) -> str:
        """IPython/Jupyter HTML representation."""
        return f"""
{self._get_markup()}
<style>
    {self._get_css()}
</style>
<script>
    (function() {{
        if (typeof d3 === "undefined") {{
            var script = document.createElement("script");
            script.src = "{D3_CDN_URL}";
            script.integrity = "{D3_SRI_HASH}";
            script.crossOrigin = "anonymous";
            script.onload = function() {{
                {self._get_javascript()}
            }};
            document.head.appendChild(script);
        }} else {{
            {self._get_javascript()}
        }}
    }})();
</script>
"""

    def show(self) -> None:
        """Display the dashboard in Jupyter when IPython is available."""
        try:
            from IPython.display import HTML, display

            display(HTML(self._repr_html_()))
        except ImportError:
            print("IPython not available. Use save() to export as HTML file.")

    def _get_markup(self) -> str:
        """HTML markup for the dashboard shell."""
        return f"""
<div id="{self._plot_id}" class="ap-dashboard-root">
    <div class="ap-card">
        <div class="ap-card-header">
            <h1 class="ap-title">{self.title}</h1>
            <p class="ap-subtitle">{self.subtitle}</p>
        </div>
        <div id="{self._plot_id}-upset" class="ap-upset"></div>
    </div>
</div>
"""

    def _get_css(self) -> str:
        """CSS for the standalone dashboard shell."""
        return f"""
        #{self._plot_id} {{
            background: #fafafa;
            color: #09090b;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            padding: 24px;
        }}
        #{self._plot_id} * {{
            box-sizing: border-box;
        }}
        #{self._plot_id} .ap-card {{
            background: #ffffff;
            border: 1px solid #e4e4e7;
            border-radius: 16px;
            box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
            padding: 24px;
        }}
        #{self._plot_id} .ap-card-header {{
            margin-bottom: 16px;
        }}
        #{self._plot_id} .ap-title {{
            color: #09090b;
            font-size: 20px;
            font-weight: 600;
            letter-spacing: -0.02em;
            margin: 0;
        }}
        #{self._plot_id} .ap-subtitle {{
            color: #52525b;
            font-size: 14px;
            margin: 6px 0 0;
        }}
        #{self._plot_id} .ap-upset {{
            overflow-x: auto;
            width: 100%;
        }}
"""

    def _get_javascript(self) -> str:
        """Bootstrap the shared UpSet renderer into the dashboard shell."""
        renderer_bundle = load_renderer_bundle()
        traces_json = json.dumps(self.traces, default=str)
        tool_sets_json = json.dumps(self.tool_sets, default=str)
        height_value = "null" if self.height is None else json.dumps(self.height)
        width_value = json.dumps(self.width)

        return f"""
        {renderer_bundle}

        (function() {{
            const containerId = "{self._plot_id}";
            const traces = {traces_json};
            const toolSets = {tool_sets_json};
            const configuredWidth = {width_value};
            const configuredHeight = {height_value};
            const upsetNode = document.getElementById(`${{containerId}}-upset`);
            let resizeTimer = null;

            function renderDashboard() {{
                const options = {{}};
                const measuredWidth = upsetNode.clientWidth || configuredWidth;

                if (measuredWidth) {{
                    options.width = Math.max(measuredWidth, 640);
                }}
                if (configuredHeight !== null) {{
                    options.height = configuredHeight;
                }}

                renderUpsetPlot(upsetNode, traces, toolSets, options);
            }}

            window.addEventListener("resize", function() {{
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(renderDashboard, 120);
            }});

            renderDashboard();
        }})();
"""
