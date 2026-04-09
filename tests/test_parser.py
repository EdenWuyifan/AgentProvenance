"""Tests for the parser module."""

import json
import tempfile
from pathlib import Path

import pytest

from agent_provenance.parser import (
    _extract_tool_calls,
    compute_upset_data,
    extract_tool_call_responses,
    extract_tool_sets,
    load_trace_records,
    parse_traces,
)


def tool_call(name, *, id=None, args=None, response=None, status=None):
    payload = {
        "id": id,
        "name": name,
        "args": args,
        "response": response,
    }
    if status is not None:
        payload["status"] = status
    return payload


class TestParseTraces:
    """Tests for parse_traces."""

    def test_parse_list_of_traces(self):
        traces = [
            {"id": "1", "tool_calls": [{"name": "search"}, {"name": "read"}]},
            {"id": "2", "tool_calls": [{"name": "write"}]},
        ]

        result = parse_traces(traces)

        assert result == [
            {"id": "1", "tool_calls": [tool_call("search"), tool_call("read")]},
            {"id": "2", "tool_calls": [tool_call("write")]},
        ]

    def test_parse_single_trace_dict(self):
        trace = {"id": "1", "tool_calls": [{"name": "search"}]}

        result = parse_traces(trace)

        assert result == [{"id": "1", "tool_calls": [tool_call("search")]}]

    def test_parse_json_string(self):
        json_str = '[{"id": "1", "tool_calls": [{"name": "search"}]}]'

        result = parse_traces(json_str)

        assert result == [{"id": "1", "tool_calls": [tool_call("search")]}]

    def test_parse_list_of_json_lines(self):
        tracings = [
            json.dumps({"id": "1", "tool_calls": [{"name": "search"}]}),
            json.dumps({"id": "2", "tool_calls": ["read"]}),
        ]

        result = parse_traces(tracings)

        assert result == [
            {"id": "1", "tool_calls": [tool_call("search")]},
            {"id": "2", "tool_calls": [tool_call("read")]},
        ]

    def test_parse_json_file(self):
        traces = [{"id": "1", "tool_calls": [{"name": "search"}]}]

        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as handle:
            json.dump(traces, handle)
            handle.flush()
            result = parse_traces(handle.name)

        assert result == [{"id": "1", "tool_calls": [tool_call("search")]}]

    def test_parse_jsonl_file_returns_minimal_traces(self):
        payload = "\n".join(
            [
                json.dumps(
                    {
                        "id": "1",
                        "score": 0.9,
                        "outputs": {
                            "messages": [
                                {
                                    "type": "assistant",
                                    "tool_calls": [
                                        {
                                            "id": "call-1",
                                            "name": "search",
                                            "args": {"q": "bos"},
                                        }
                                    ],
                                },
                                {
                                    "type": "tool",
                                    "tool_call_id": "call-1",
                                    "content": "{\"hits\": 3}",
                                },
                            ]
                        },
                    }
                ),
                json.dumps({"id": "2", "tool_calls": ["read"]}),
            ]
        )

        with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as handle:
            handle.write(payload)
            handle.flush()
            result = parse_traces(handle.name)

        assert result == [
            {
                "id": "1",
                "score": 0.9,
                "tool_calls": [
                    tool_call(
                        "search",
                        id="call-1",
                        args={"q": "bos"},
                        response='{"hits": 3}',
                    )
                ],
            },
            {"id": "2", "tool_calls": [tool_call("read")]},
        ]

    def test_load_trace_records_from_single_dict(self):
        trace = {"id": "1", "tool_calls": [{"name": "search"}]}
        assert load_trace_records(trace) == [trace]

    def test_parse_path_object(self):
        traces = [{"id": "1", "tool_calls": [{"name": "search"}]}]

        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as handle:
            json.dump(traces, handle)
            handle.flush()
            result = parse_traces(Path(handle.name))

        assert result == [{"id": "1", "tool_calls": [tool_call("search")]}]

    def test_parse_invalid_input(self):
        with pytest.raises(ValueError):
            parse_traces(12345)

    def test_parse_invalid_json_string(self):
        with pytest.raises(ValueError):
            parse_traces("not valid json")


class TestExtractToolCalls:
    """Tests for tool name extraction."""

    def test_extract_tool_calls_name_format(self):
        trace = {"tool_calls": [{"name": "search"}, {"name": "read"}]}
        assert _extract_tool_calls(trace) == ["search", "read"]

    def test_extract_tool_calls_string_format(self):
        trace = {"tool_calls": ["search", "read"]}
        assert _extract_tool_calls(trace) == ["search", "read"]

    def test_extract_tool_calls_tool_key(self):
        trace = {"tool_calls": [{"tool": "search"}]}
        assert _extract_tool_calls(trace) == ["search"]

    def test_extract_tool_calls_tool_name_key(self):
        trace = {"toolCalls": [{"toolName": "search"}]}
        assert _extract_tool_calls(trace) == ["search"]

    def test_extract_tool_calls_function_key(self):
        trace = {"calls": [{"function": "search"}]}
        assert _extract_tool_calls(trace) == ["search"]

    def test_extract_tool_calls_steps_format(self):
        trace = {"steps": [{"name": "search"}, {"name": "read"}]}
        assert _extract_tool_calls(trace) == ["search", "read"]

    def test_extract_tool_calls_outputs_messages_format(self):
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

        assert _extract_tool_calls(trace) == ["search", "read"]


class TestExtractToolCallResponses:
    """Tests for extracting ordered tool call/response pairs."""

    def test_extract_tool_call_responses_pairs_by_id(self):
        trace = {
            "outputs": {
                "messages": [
                    {
                        "type": "assistant",
                        "tool_calls": [
                            {"id": "call-1", "name": "search", "args": {"q": "bos"}},
                            {
                                "id": "call-2",
                                "function": {
                                    "name": "read",
                                    "arguments": '{"path": "a.csv"}',
                                },
                            },
                        ],
                    },
                    {
                        "type": "tool",
                        "tool_call_id": "call-2",
                        "content": '{"rows": 10}',
                    },
                    {
                        "type": "tool",
                        "tool_call_id": "call-1",
                        "content": '{"hits": 3}',
                    },
                ]
            }
        }

        assert extract_tool_call_responses(trace) == [
            tool_call("search", id="call-1", args={"q": "bos"}, response='{"hits": 3}'),
            tool_call("read", id="call-2", args='{"path": "a.csv"}', response='{"rows": 10}'),
        ]

    def test_extract_tool_call_responses_handles_missing_tool_output(self):
        trace = {
            "outputs": {
                "messages": [
                    {
                        "type": "assistant",
                        "tool_calls": [
                            {"id": "call-1", "name": "search", "args": {"q": "bos"}}
                        ],
                    }
                ]
            }
        }

        assert extract_tool_call_responses(trace) == [
            tool_call("search", id="call-1", args={"q": "bos"})
        ]


class TestExtractToolSets:
    """Tests for extract_tool_sets."""

    def test_extract_tool_sets_basic(self):
        traces = [
            {"id": "1", "tool_calls": ["search", "read"]},
            {"id": "2", "tool_calls": ["write"]},
        ]

        assert extract_tool_sets(traces) == [{"search", "read"}, {"write"}]

    def test_extract_tool_sets_empty(self):
        assert extract_tool_sets([]) == []


class TestComputeUpsetData:
    """Tests for compute_upset_data."""

    def test_compute_upset_data_basic(self):
        traces = [
            {"id": "1", "tool_calls": ["search", "read"]},
            {"id": "2", "tool_calls": ["search", "read"]},
            {"id": "3", "tool_calls": ["write"]},
        ]

        result = compute_upset_data(traces)

        assert result["total_traces"] == 3
        assert set(result["sets"]) == {"search", "read", "write"}
        assert "intersections" in result

    def test_compute_upset_data_intersection_counts(self):
        traces = [
            {"id": "1", "tool_calls": ["a", "b"]},
            {"id": "2", "tool_calls": ["a", "b"]},
            {"id": "3", "tool_calls": ["a"]},
        ]

        result = compute_upset_data(traces)
        intersections = {tuple(item["sets"]): item["size"] for item in result["intersections"]}

        assert intersections[("a", "b")] == 2
        assert intersections[("a",)] == 1

    def test_compute_upset_data_empty(self):
        result = compute_upset_data([])

        assert result == {
            "sets": [],
            "intersections": [],
            "total_traces": 0,
        }
