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
        <div class="ap-upset-controls" role="group" aria-label="UpSet controls">
            <div class="ap-upset-controls-row ap-upset-controls-row--top">
                <div class="ap-segmented" id="{self._plot_id}-top-chart-toggle">
                    <button type="button" data-mode="usage">Usage</button>
                    <button type="button" data-mode="impact">Impact</button>
                </div>
                <div class="ap-upset-controls-spacer"></div>
            </div>
            <div class="ap-upset-controls-row ap-upset-controls-row--bottom">
                <div class="ap-upset-controls-spacer"></div>
                <div class="ap-group-controls">
                    <label class="ap-inline-field">
                        <span>Group rows</span>
                        <select id="{self._plot_id}-group-by-select">
                            <option value="">None</option>
                        </select>
                    </label>
                    <div class="ap-separator"></div>
                    <div class="ap-inline-actions">
                        <button type="button" id="{self._plot_id}-fold-all">Fold all</button>
                        <button type="button" id="{self._plot_id}-expand-all">Expand all</button>
                    </div>
                </div>
            </div>
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
        #{self._plot_id} .ap-card-header--with-actions {{
            align-items: flex-start;
            display: flex;
            justify-content: space-between;
            gap: 16px;
        }}
        #{self._plot_id} .ap-title {{
            color: #09090b;
            font-size: 20px;
            font-weight: 600;
            letter-spacing: -0.02em;
            margin: 0;
        }}
        #{self._plot_id} .ap-title--section {{
            font-size: 18px;
        }}
        #{self._plot_id} .ap-subtitle {{
            color: #52525b;
            font-size: 14px;
            margin: 6px 0 0;
        }}
        #{self._plot_id} .ap-upset-controls {{
            margin-bottom: 8px;
        }}
        #{self._plot_id} .ap-upset-controls-row {{
            align-items: center;
            display: grid;
            grid-template-columns: 3fr 1fr;
            gap: 8px;
        }}
        #{self._plot_id} .ap-upset-controls-row + .ap-upset-controls-row {{
            margin-top: 6px;
        }}
        #{self._plot_id} .ap-upset-controls-spacer {{
            min-height: 28px;
        }}
        #{self._plot_id} .ap-segmented {{
            align-items: center;
            background: rgba(244, 244, 245, 0.95);
            border: 1px solid #d4d4d8;
            display: inline-flex;
            min-height: 28px;
        }}
        #{self._plot_id} .ap-segmented > button {{
            background: transparent;
            border: 0;
            color: #71717a;
            cursor: pointer;
            font-size: 11px;
            font-weight: 500;
            height: 100%;
            padding: 0 8px;
        }}
        #{self._plot_id} .ap-segmented > button + button {{
            border-left: 1px solid #d4d4d8;
        }}
        #{self._plot_id} .ap-segmented > button[aria-pressed="true"] {{
            background: #ffffff;
            color: #09090b;
        }}
        #{self._plot_id} .ap-group-controls {{
            align-items: stretch;
            background: rgba(244, 244, 245, 0.95);
            border: 1px solid #d4d4d8;
            display: flex;
            min-height: 28px;
        }}
        #{self._plot_id} .ap-inline-field {{
            align-items: center;
            color: #52525b;
            display: inline-flex;
            font-size: 11px;
        }}
        #{self._plot_id} .ap-inline-field > span {{
            border-right: 1px solid #d4d4d8;
            padding: 0 8px;
        }}
        #{self._plot_id} .ap-inline-field > select {{
            background: transparent;
            border: 0;
            color: #09090b;
            font-size: 11px;
            height: 100%;
            outline: none;
            padding: 0 8px;
        }}
        #{self._plot_id} .ap-separator {{
            border-left: 1px solid #d4d4d8;
            width: 1px;
        }}
        #{self._plot_id} .ap-inline-actions {{
            align-items: center;
            display: inline-flex;
            font-size: 11px;
        }}
        #{self._plot_id} .ap-inline-actions > button {{
            background: transparent;
            border: 0;
            color: #71717a;
            cursor: pointer;
            height: 100%;
            padding: 0 8px;
        }}
        #{self._plot_id} .ap-inline-actions > button + button {{
            border-left: 1px solid #d4d4d8;
        }}
        #{self._plot_id} .ap-inline-actions > button:disabled {{
            color: #d4d4d8;
            cursor: default;
        }}
        #{self._plot_id} .ap-upset {{
            overflow-x: auto;
            width: 100%;
        }}
        #{self._plot_id} .ap-status-message {{
            align-items: center;
            background: #fafafa;
            border: 1px dashed #e4e4e7;
            border-radius: 12px;
            color: #52525b;
            display: flex;
            font-size: 13px;
            justify-content: center;
            min-height: 220px;
            padding: 16px;
            text-align: center;
        }}
        #{self._plot_id} .ap-provenance-graph {{
            background: #fafafa;
            border: 1px solid #e4e4e7;
            border-radius: 12px;
            overflow-x: auto;
            padding: 16px;
        }}
        #{self._plot_id} .ap-provenance-track {{
            align-items: center;
            display: inline-flex;
            flex-wrap: wrap;
            gap: 8px;
            min-height: 188px;
        }}
        #{self._plot_id} .ap-provenance-node {{
            align-items: center;
            background: #ffffff;
            border: 1px solid #d4d4d8;
            border-radius: 999px;
            color: #09090b;
            display: inline-flex;
            font-size: 12px;
            font-weight: 500;
            gap: 6px;
            padding: 6px 10px;
            white-space: nowrap;
        }}
        #{self._plot_id} .ap-provenance-arrow {{
            color: #a1a1aa;
            font-size: 12px;
        }}
        #{self._plot_id} .ap-provenance-count {{
            background: #f4f4f5;
            border-radius: 999px;
            color: #52525b;
            font-size: 10px;
            font-weight: 600;
            padding: 1px 6px;
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
            const topChartToggle = document.getElementById(`${{containerId}}-top-chart-toggle`);
            const groupBySelect = document.getElementById(`${{containerId}}-group-by-select`);
            const foldAllButton = document.getElementById(`${{containerId}}-fold-all`);
            const expandAllButton = document.getElementById(`${{containerId}}-expand-all`);
            let resizeTimer = null;
            const groupingExcluded = new Set(["id", "score", "toolCalls", "tool_calls"]);
            const state = {{
                topChartMode: "impact",
                rowGroupBy: "",
                collapsedGroups: [],
            }};

            function compareLabels(a, b) {{
                return String(a).localeCompare(String(b), undefined, {{
                    numeric: true,
                    sensitivity: "base",
                }});
            }}

            function getGroupingOptions() {{
                const keys = new Set();

                traces.forEach((trace) => {{
                    Object.entries(trace || {{}}).forEach(([key, value]) => {{
                        if (groupingExcluded.has(key)) return;
                        if (value === null || value === undefined || value === "") return;
                        if (typeof value === "object") return;
                        keys.add(key);
                    }});
                }});

                return Array.from(keys).sort((a, b) => a.localeCompare(b));
            }}

            function getGroupingValues(groupBy) {{
                if (!groupBy) return [];

                const values = new Set();
                traces.forEach((trace) => {{
                    const value = trace?.[groupBy];
                    if (value === null || value === undefined || value === "") return;
                    if (typeof value === "object") return;
                    values.add(String(value));
                }});

                return Array.from(values).sort((a, b) => a.localeCompare(b));
            }}

            function escapeHtml(value) {{
                return String(value)
                    .replaceAll("&", "&amp;")
                    .replaceAll("<", "&lt;")
                    .replaceAll(">", "&gt;")
                    .replaceAll('"', "&quot;")
                    .replaceAll("'", "&#39;");
            }}

            function syncControls() {{
                topChartToggle?.querySelectorAll("button[data-mode]").forEach((button) => {{
                    button.setAttribute(
                        "aria-pressed",
                        button.dataset.mode === state.topChartMode ? "true" : "false"
                    );
                }});

                if (groupBySelect && groupBySelect.value !== state.rowGroupBy) {{
                    groupBySelect.value = state.rowGroupBy;
                }}

                const disableFold = !state.rowGroupBy;
                if (foldAllButton) foldAllButton.disabled = disableFold;
                if (expandAllButton) expandAllButton.disabled = disableFold;
            }}

function renderDashboard() {{
                if (!upsetNode) return;

                const measuredWidth = upsetNode.clientWidth || configuredWidth;
                const options = {{
                    topChartMode: state.topChartMode,
                    rowGroupBy: state.rowGroupBy || undefined,
                    collapsedGroups: state.collapsedGroups,
                    onGroupToggle: (group) => {{
                        if (state.collapsedGroups.includes(group)) {{
                            state.collapsedGroups = state.collapsedGroups.filter((item) => item !== group);
                        }} else {{
                            state.collapsedGroups = [...state.collapsedGroups, group];
                        }}
                        renderDashboard();
                    }},

                }};

                if (measuredWidth) {{
                    options.width = Math.max(measuredWidth, 640);
                }}
                if (configuredHeight !== null) {{
                    options.height = configuredHeight;
                }}

                renderUpsetPlot(upsetNode, traces, toolSets, options);
                syncControls();
            }}

            function initControls() {{
                const groupingOptions = getGroupingOptions();
                if (groupBySelect) {{
                    groupBySelect.innerHTML = ['<option value="">None</option>']
                        .concat(groupingOptions.map((value) => `<option value="${{escapeHtml(value)}}">${{escapeHtml(value)}}</option>`))
                        .join("");
                }}

                topChartToggle?.querySelectorAll("button[data-mode]").forEach((button) => {{
                    button.addEventListener("click", () => {{
                        const mode = button.dataset.mode;
                        if (mode === "usage" || mode === "impact") {{
                            state.topChartMode = mode;
                            renderDashboard();
                        }}
                    }});
                }});

groupBySelect?.addEventListener("change", (event) => {{
                    state.rowGroupBy = event.target.value;
                    const validGroups = new Set(getGroupingValues(state.rowGroupBy));
                    state.collapsedGroups = state.collapsedGroups.filter((group) => validGroups.has(group));
                    renderDashboard();
                }});

                foldAllButton?.addEventListener("click", () => {{
                    if (!state.rowGroupBy) return;
                    state.collapsedGroups = getGroupingValues(state.rowGroupBy);
                    renderDashboard();
                }});

                expandAllButton?.addEventListener("click", () => {{
                    if (!state.rowGroupBy) return;
                    state.collapsedGroups = [];
                    renderDashboard();
                }});
            }}

            window.addEventListener("resize", function() {{
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(renderDashboard, 120);
            }});

            initControls();
            renderDashboard();
        }})();
"""
