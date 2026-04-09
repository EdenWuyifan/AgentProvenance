"""Tests for the parser module."""

import json
import tempfile
from pathlib import Path

import pytest

from agent_provenance.parser import (
    _extract_tool_calls,
    _normalize_traces,
    compute_upset_data,
    extract_tool_call_responses,
    extract_tool_sets,
    load_trace_records,
    parse_traces,
)


class TestParseTraces:
    """Tests for parse_traces function."""

    def test_parse_list_of_traces(self):
        """Test parsing a list of trace dictionaries."""
        traces = [
            {"id": "1", "tool_calls": [{"name": "search"}, {"name": "read"}]},
            {"id": "2", "tool_calls": [{"name": "write"}]},
        ]
        result = parse_traces(traces)
        assert len(result) == 2
        assert result[0]["id"] == "1"
        assert result[0]["tool_calls"] == ["search", "read"]
        assert result[1]["tool_calls"] == ["write"]

    def test_parse_single_trace_dict(self):
        """Test parsing a single trace dictionary."""
        trace = {"id": "1", "tool_calls": [{"name": "search"}]}
        result = parse_traces([trace])
        assert len(result) == 1
        assert result[0]["tool_calls"] == ["search"]

    def test_parse_json_string(self):
        """Test parsing a JSON string."""
        json_str = '[{"id": "1", "tool_calls": [{"name": "search"}]}]'
        result = parse_traces(json_str)
        assert len(result) == 1
        assert result[0]["tool_calls"] == ["search"]

    def test_parse_json_file(self):
        """Test parsing a JSON file."""
        traces = [{"id": "1", "tool_calls": [{"name": "search"}]}]
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(traces, f)
            f.flush()
            result = parse_traces(f.name)
        assert len(result) == 1
        assert result[0]["tool_calls"] == ["search"]

    def test_parse_jsonl_file(self):
        """Test parsing a JSONL file."""
        payload = "\n".join(
            [
                json.dumps({"id": "1", "tool_calls": [{"name": "search"}]}),
                json.dumps({"id": "2", "tool_calls": [{"name": "read"}]}),
            ]
        )
        with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
            f.write(payload)
            f.flush()
            result = parse_traces(f.name)
        assert len(result) == 2
        assert result[0]["tool_calls"] == ["search"]
        assert result[1]["tool_calls"] == ["read"]

    def test_load_trace_records_from_single_dict(self):
        """Test loading a single trace dict without normalization."""
        trace = {"id": "1", "tool_calls": [{"name": "search"}]}
        result = load_trace_records(trace)
        assert result == [trace]

    def test_parse_path_object(self):
        """Test parsing with Path object."""
        traces = [{"id": "1", "tool_calls": [{"name": "search"}]}]
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(traces, f)
            f.flush()
            result = parse_traces(Path(f.name))
        assert len(result) == 1

    def test_parse_invalid_input(self):
        """Test that invalid input raises ValueError."""
        with pytest.raises(ValueError):
            parse_traces(12345)

    def test_parse_invalid_json_string(self):
        """Test that invalid JSON string raises ValueError."""
        with pytest.raises(ValueError):
            parse_traces("not valid json")


class TestExtractToolCalls:
    """Tests for tool call extraction."""

    def test_extract_tool_calls_name_format(self):
        """Test extracting tool calls with 'name' key."""
        trace = {"tool_calls": [{"name": "search"}, {"name": "read"}]}
        result = _extract_tool_calls(trace)
        assert result == ["search", "read"]

    def test_extract_tool_calls_string_format(self):
        """Test extracting tool calls as strings."""
        trace = {"tool_calls": ["search", "read"]}
        result = _extract_tool_calls(trace)
        assert result == ["search", "read"]

    def test_extract_tool_calls_tool_key(self):
        """Test extracting tool calls with 'tool' key."""
        trace = {"tool_calls": [{"tool": "search"}]}
        result = _extract_tool_calls(trace)
        assert result == ["search"]

    def test_extract_tool_calls_toolName_key(self):
        """Test extracting tool calls with 'toolName' key."""
        trace = {"toolCalls": [{"toolName": "search"}]}
        result = _extract_tool_calls(trace)
        assert result == ["search"]

    def test_extract_tool_calls_function_key(self):
        """Test extracting tool calls with 'function' key."""
        trace = {"calls": [{"function": "search"}]}
        result = _extract_tool_calls(trace)
        assert result == ["search"]

    def test_extract_tool_calls_steps_format(self):
        """Test extracting tool calls from 'steps' key."""
        trace = {"steps": [{"name": "search"}, {"name": "read"}]}
        result = _extract_tool_calls(trace)
        assert result == ["search", "read"]

    def test_extract_tool_calls_outputs_messages_format(self):
        """Test extracting tool calls from outputs.messages."""
        trace = {
            "outputs": {
                "messages": [
                    {
                        "tool_calls": [
                            {"id": "call-1", "name": "search", "args": {"q": "a"}},
                            {"id": "call-2", "function": {"name": "read"}},
                        ]
                    }
                ]
            }
        }
        result = _extract_tool_calls(trace)
        assert result == ["search", "read"]


class TestNormalizeTraces:
    """Tests for trace normalization."""

    def test_normalize_adds_id(self):
        """Test that normalization adds an ID if missing."""
        traces = [{"tool_calls": [{"name": "search"}]}]
        result = _normalize_traces(traces)
        assert "id" in result[0]

    def test_normalize_preserves_metadata(self):
        """Test that normalization preserves additional metadata."""
        traces = [{"id": "1", "tool_calls": [], "custom_field": "value"}]
        result = _normalize_traces(traces)
        assert result[0]["metadata"]["custom_field"] == "value"

    def test_normalize_handles_single_dict(self):
        """Test that a single dict gets wrapped in a list."""
        trace = {"id": "1", "tool_calls": [{"name": "search"}]}
        result = _normalize_traces(trace)
        assert isinstance(result, list)
        assert len(result) == 1

    def test_normalize_promotes_dashboard_fields(self):
        """Test that score and outputs stay available for dashboard rendering."""
        trace = {
            "id": "1",
            "score": 0.9,
            "outputs": {"messages": [{"tool_calls": [{"name": "search"}]}]},
        }
        result = _normalize_traces([trace])
        assert result[0]["score"] == 0.9
        assert result[0]["outputs"]["messages"][0]["tool_calls"][0]["name"] == "search"


class TestExtractToolCallResponses:
    """Tests for extracting tool call/response pairs from OpenAI-style traces."""

    def test_extract_tool_call_responses_pairs_by_id(self):
        """Tool calls should be matched to tool outputs by tool_call_id."""
        trace = {
            "outputs": {
                "messages": [
                    {
                        "type": "ai",
                        "tool_calls": [
                            {"id": "call-1", "name": "search", "args": {"q": "bos"}},
                            {"id": "call-2", "function": {"name": "read", "arguments": "{\"path\": \"a.csv\"}"}},
                        ],
                    },
                    {
                        "type": "tool",
                        "tool_call_id": "call-2",
                        "content": "{\"rows\": 10}",
                    },
                    {
                        "type": "tool",
                        "tool_call_id": "call-1",
                        "content": "{\"hits\": 3}",
                    },
                ]
            }
        }

        result = extract_tool_call_responses(trace)

        assert result == [
            {
                "id": "call-1",
                "name": "search",
                "args": {"q": "bos"},
                "response": "{\"hits\": 3}",
            },
            {
                "id": "call-2",
                "name": "read",
                "args": "{\"path\": \"a.csv\"}",
                "response": "{\"rows\": 10}",
            },
        ]

    def test_extract_tool_call_responses_handles_missing_tool_output(self):
        """Missing tool responses should stay as None."""
        trace = {
            "outputs": {
                "messages": [
                    {
                        "type": "ai",
                        "tool_calls": [
                            {"id": "call-1", "name": "search", "args": {"q": "bos"}}
                        ],
                    }
                ]
            }
        }

        result = extract_tool_call_responses(trace)

        assert result == [
            {
                "id": "call-1",
                "name": "search",
                "args": {"q": "bos"},
                "response": None,
            }
        ]


class TestExtractToolSets:
    """Tests for extract_tool_sets function."""

    def test_extract_tool_sets_basic(self):
        """Test basic tool set extraction."""
        traces = [
            {"id": "1", "tool_calls": ["search", "read"], "metadata": {}},
            {"id": "2", "tool_calls": ["write"], "metadata": {}},
        ]
        result = extract_tool_sets(traces)
        assert len(result) == 2
        assert result[0] == {"search", "read"}
        assert result[1] == {"write"}

    def test_extract_tool_sets_empty(self):
        """Test extraction with empty traces."""
        result = extract_tool_sets([])
        assert result == []


class TestComputeUpsetData:
    """Tests for compute_upset_data function."""

    def test_compute_upset_data_basic(self):
        """Test basic UpSet data computation."""
        traces = [
            {"id": "1", "tool_calls": ["search", "read"], "metadata": {}},
            {"id": "2", "tool_calls": ["search", "read"], "metadata": {}},
            {"id": "3", "tool_calls": ["write"], "metadata": {}},
        ]
        result = compute_upset_data(traces)

        assert "sets" in result
        assert "intersections" in result
        assert "total_traces" in result
        assert result["total_traces"] == 3
        assert set(result["sets"]) == {"search", "read", "write"}

    def test_compute_upset_data_intersection_counts(self):
        """Test that intersection counts are correct."""
        traces = [
            {"id": "1", "tool_calls": ["a", "b"], "metadata": {}},
            {"id": "2", "tool_calls": ["a", "b"], "metadata": {}},
            {"id": "3", "tool_calls": ["a"], "metadata": {}},
        ]
        result = compute_upset_data(traces)

        # Check intersection sizes
        intersections = {tuple(i["sets"]): i["size"] for i in result["intersections"]}
        assert intersections[("a", "b")] == 2
        assert intersections[("a",)] == 1

    def test_compute_upset_data_empty(self):
        """Test with empty traces."""
        result = compute_upset_data([])
        assert result["sets"] == []
        assert result["intersections"] == []
        assert result["total_traces"] == 0
