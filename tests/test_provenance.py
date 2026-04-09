"""Tests for the main AgentProvenance class."""

import json
import tempfile

import pytest

from agent_provenance import AgentProvenance
from agent_provenance.dashboard import TraceDashboard


class TestAgentProvenance:
    """Tests for AgentProvenance class."""

    @pytest.fixture
    def sample_traces(self):
        """Sample trace data for testing."""
        return [
            {"id": "1", "tool_calls": [{"name": "search"}, {"name": "read"}]},
            {"id": "2", "tool_calls": [{"name": "search"}, {"name": "read"}]},
            {"id": "3", "tool_calls": [{"name": "write"}]},
        ]

    @pytest.fixture
    def rich_traces(self):
        """Sample traces matching the richer React dashboard shape."""
        return [
            {
                "id": "trace-1",
                "score": 0.75,
                "outputs": {
                    "messages": [
                        {
                            "type": "ai",
                            "tool_calls": [
                                {"id": "call-1", "name": "search", "args": {"q": "x"}},
                                {"id": "call-2", "name": "read", "args": {"path": "a.txt"}},
                            ],
                        },
                        {
                            "type": "tool",
                            "tool_call_id": "call-1",
                            "content": "{\"hits\": 2}",
                        },
                        {
                            "type": "tool",
                            "tool_call_id": "call-2",
                            "content": "{\"rows\": 4}",
                        },
                    ]
                },
            },
            {
                "id": "trace-2",
                "score": 0.25,
                "outputs": {
                    "messages": [
                        {
                            "type": "ai",
                            "tool_calls": [
                                {"id": "call-3", "name": "write", "args": {"path": "b.txt"}}
                            ],
                        }
                    ]
                },
            },
        ]

    def test_init_without_data(self):
        """Test initialization without data."""
        provenance = AgentProvenance()
        assert provenance.num_traces == 0
        assert provenance.tools == []

    def test_init_with_data(self, sample_traces):
        """Test initialization with data."""
        provenance = AgentProvenance(sample_traces)
        assert provenance.num_traces == 3
        assert set(provenance.tools) == {"search", "read", "write"}

    def test_load_from_list(self, sample_traces):
        """Test loading data from a list."""
        provenance = AgentProvenance()
        result = provenance.load(sample_traces)
        assert result is provenance  # Method chaining
        assert provenance.num_traces == 3

    def test_load_from_file(self, sample_traces):
        """Test loading data from a JSON file."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(sample_traces, f)
            f.flush()
            provenance = AgentProvenance(f.name)
        assert provenance.num_traces == 3

    def test_add_trace(self, sample_traces):
        """Test adding a single trace."""
        provenance = AgentProvenance(sample_traces)
        provenance.add_trace({"id": "4", "tool_calls": [{"name": "delete"}]})
        assert provenance.num_traces == 4
        assert "delete" in provenance.tools

    def test_add_traces(self, sample_traces):
        """Test adding multiple traces."""
        provenance = AgentProvenance(sample_traces)
        provenance.add_traces([
            {"id": "4", "tool_calls": [{"name": "delete"}]},
            {"id": "5", "tool_calls": [{"name": "update"}]},
        ])
        assert provenance.num_traces == 5

    def test_traces_property(self, sample_traces):
        """Test the traces property."""
        provenance = AgentProvenance(sample_traces)
        traces = provenance.traces
        assert len(traces) == 3
        assert all("id" in t for t in traces)
        assert all("tool_calls" in t for t in traces)
        assert traces[0]["tool_calls"][0] == {
            "id": None,
            "name": "search",
            "args": None,
            "response": None,
        }

    def test_raw_traces_property(self, sample_traces):
        """Test the backward-compatible raw_traces alias."""
        provenance = AgentProvenance(sample_traces)
        assert provenance.raw_traces == provenance.traces

    def test_rich_traces_are_minimalized(self, rich_traces):
        """Rich traces should also collapse into the minimal internal shape."""
        provenance = AgentProvenance(rich_traces)
        assert provenance.traces[0]["tool_calls"] == [
            {
                "id": "call-1",
                "name": "search",
                "args": {"q": "x"},
                "response": "{\"hits\": 2}",
            },
            {
                "id": "call-2",
                "name": "read",
                "args": {"path": "a.txt"},
                "response": "{\"rows\": 4}",
            },
        ]

    def test_upset_data_property(self, sample_traces):
        """Test the upset_data property."""
        provenance = AgentProvenance(sample_traces)
        data = provenance.upset_data
        assert "sets" in data
        assert "intersections" in data
        assert "total_traces" in data
        assert data["total_traces"] == 3

    def test_upset_data_cached(self, sample_traces):
        """Test that upset_data is cached."""
        provenance = AgentProvenance(sample_traces)
        data1 = provenance.upset_data
        data2 = provenance.upset_data
        assert data1 is data2  # Same object

    def test_upset_data_cache_invalidated_on_load(self, sample_traces):
        """Test that cache is invalidated on load."""
        provenance = AgentProvenance(sample_traces)
        data1 = provenance.upset_data
        provenance.load([{"id": "new", "tool_calls": []}])
        data2 = provenance.upset_data
        assert data1 is not data2

    def test_build_dashboard_view_returns_trace_dashboard(self, sample_traces):
        """Test the single internal render path."""
        provenance = AgentProvenance(sample_traces)
        dashboard = provenance._build_dashboard_view()
        assert isinstance(dashboard, TraceDashboard)

    def test_build_dashboard_view_custom_params(self, sample_traces):
        """Dashboard builder should pass through display params."""
        provenance = AgentProvenance(sample_traces)
        dashboard = provenance._build_dashboard_view(width=1000, height=600)
        assert dashboard.width == 1000
        assert dashboard.height == 600

    def test_build_dashboard_view_to_html(self, rich_traces):
        """Dashboard HTML generation should work for rich traces."""
        provenance = AgentProvenance(rich_traces)
        html = provenance._build_dashboard_view().to_html()
        assert "<!DOCTYPE html>" in html
        assert "AgentProvenance Trace Explorer" in html
        assert "trace-1" in html
        assert "Tool Call Visualization" not in html

    def test_build_dashboard_view_works_for_simple_traces(self, sample_traces):
        """Simple traces should still render in the dashboard."""
        provenance = AgentProvenance(sample_traces)
        html = provenance._build_dashboard_view().to_html()
        assert '"tool_calls"' in html
        assert "search" in html

    def test_summary(self, sample_traces):
        """Test summary() method."""
        provenance = AgentProvenance(sample_traces)
        summary = provenance.summary()
        assert summary["total_traces"] == 3
        assert summary["unique_tools"] == 3
        assert set(summary["tools"]) == {"search", "read", "write"}
        assert summary["unique_combinations"] == 2
        assert summary["most_common_combination"] is not None

    def test_repr_html(self, sample_traces):
        """Test _repr_html_ for Jupyter display."""
        provenance = AgentProvenance(sample_traces)
        html = provenance._repr_html_()
        assert "ap-dashboard-root" in html

    def test_repr(self, sample_traces):
        """Test __repr__ method."""
        provenance = AgentProvenance(sample_traces)
        repr_str = repr(provenance)
        assert "AgentProvenance" in repr_str
        assert "traces=3" in repr_str
        assert "tools=3" in repr_str

    def test_method_chaining(self, sample_traces):
        """Test that methods support chaining."""
        provenance = (
            AgentProvenance()
            .load(sample_traces)
            .add_trace({"id": "4", "tool_calls": [{"name": "new"}]})
        )
        assert provenance.num_traces == 4
