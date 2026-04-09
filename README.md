# AgentProvenance

A Python tool to convert agent traces into interactive UpSet plots and React-style provenance dashboards for Jupyter and standalone HTML.

## Features

- **Parse Agent Traces**: Load JSON, JSONL, or in-memory trace payloads
- **Interactive UpSet Plots**: Generate D3-based overlap views for tool usage
- **Trace Dashboard**: Explore the React-side provenance matrix in a standalone HTML shell
- **Jupyter Integration**: Display plots directly in Jupyter Notebooks
- **Export to HTML**: Save visualizations as standalone HTML files
- **Flexible Input Formats**: Support for various trace data formats

## Installation

```bash
pip install agent_provenance
```

For Jupyter Notebook support:

```bash
pip install agent_provenance[jupyter]
```

For development:

```bash
pip install agent_provenance[dev]
```

## Quick Start

### Basic Usage

```python
from agent_provenance import AgentProvenance

# Load traces from a JSON file
provenance = AgentProvenance("traces.json")

# Display the default provenance dashboard in Jupyter
provenance.show()
```

### Working with Trace Data

```python
from agent_provenance import AgentProvenance

# Create traces programmatically
traces = [
    {
        "id": "trace_1",
        "tool_calls": [
            {"name": "search"},
            {"name": "read_file"},
            {"name": "write_file"}
        ]
    },
    {
        "id": "trace_2", 
        "tool_calls": [
            {"name": "search"},
            {"name": "read_file"}
        ]
    },
    {
        "id": "trace_3",
        "tool_calls": [
            {"name": "execute_code"}
        ]
    }
]

# Initialize provenance with traces
provenance = AgentProvenance(traces)

# Get summary statistics
print(provenance.summary())
# Output: {'total_traces': 3, 'unique_tools': 4, 'tools': [...], ...}

# Access the tools found
print(provenance.tools)
# Output: ['execute_code', 'read_file', 'search', 'write_file']
```

### Method Chaining

```python
from agent_provenance import AgentProvenance

provenance = (
    AgentProvenance()
    .load("initial_traces.json")
    .add_trace({"id": "new", "tool_calls": [{"name": "new_tool"}]})
)
provenance.show()
```

### Customizing the Dashboard

```python
provenance.show(
    width=1000,
    height=600,
    title="Custom Trace Explorer",
    subtitle="Tool provenance across runs"
)
```

## Supported Trace Formats

AgentProvenance supports multiple common formats for tool call data:

```python
# Format 1: Using 'tool_calls' with 'name'
{"tool_calls": [{"name": "search"}, {"name": "read"}]}

# Format 2: Using 'toolCalls' with 'toolName'
{"toolCalls": [{"toolName": "search"}]}

# Format 3: Using 'calls' with 'function'
{"calls": [{"function": "search"}]}

# Format 4: Using 'steps'
{"steps": [{"name": "search"}, {"name": "read"}]}

# Format 5: Simple string arrays
{"tool_calls": ["search", "read"]}

# Format 6: LangSmith-style traces with outputs.messages
{"outputs": {"messages": [{"tool_calls": [{"id": "call-1", "name": "search"}]}]}}
```

## API Reference

### AgentProvenance

Main class for loading traces and generating visualizations.

#### Methods

- `load(data)` - Load traces from file, JSON string, or list
- `add_trace(trace)` - Add a single trace
- `add_traces(traces)` - Add multiple traces
- `show(**kwargs)` - Display the provenance dashboard in Jupyter Notebook
- `summary()` - Get summary statistics

#### Properties

- `traces` - List of loaded traces
- `tools` - List of unique tools
- `num_traces` - Total number of traces
- `upset_data` - Computed UpSet plot data

## License

MIT License - see [LICENSE](LICENSE) for details
