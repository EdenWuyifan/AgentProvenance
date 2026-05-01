# AgentProvenance React UI

This app is the browser UI for exploring trace provenance.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Data source

The page loads trace data from [`public/tracings.jsonl`](./public/tracings.jsonl).

- JSON arrays are supported.
- JSONL files are supported.
- Rich traces with `outputs.messages[].tool_calls` are supported.
- Simpler traces with `tool_calls` are supported.
- Both shapes render the provenance matrix.

## PROV Graph Workflow

The PROV graph treats each tool call as:

```text
input -> tool activity -> output
```

The Python backend in [`../agent_provenance_backend/app.py`](../agent_provenance_backend/app.py)
builds the graph in two stages. The Next route only proxies requests to that backend.

1. Code creates the stable skeleton:
   - one Activity node for each tool call
   - at most one primary output Entity for a tool call with a valid artifact id, path, url, name, or filename
   - Activity -> Entity edges for tool outputs

2. Code proposes direct dependency candidates between earlier calls and later calls:
   - shared ids, filenames, paths, urls, or artifact names from previous output to next input
   - weighted input-token coverage using an inverted index from previous output tokens to tool calls
   - adjacency alone is not used as evidence

3. The LLM receives sanitized full args/response JSON, the draft graph, and suggested `ProvEdge` objects, then returns validated graph edit operations. Supported operations are `addNode`, `removeNode`, `editNode`, `addEdge`, `removeEdge`, and `editEdge`.

Rules:

- No Entity -> Entity edges.
- If a call has no selected direct predecessor, its Activity node starts as a new root.
- If a previous tool call has no valid output Entity but still clearly informs a later call, the graph may use Activity -> Activity.
- Redundant inspection or preview steps are pruned only when the LLM explicitly returns graph edits; the code does not rely on fixed tool names.
- Token-overlap edges are scored candidates only; the LLM must still reject indirect or sibling calls.

Embedding candidates are disabled for now because local embedding generation is slow. Token candidates are generated from raw scalar JSON values before truncation, so short inputs such as gene lists can connect to earlier outputs containing the same genes.

```bash
# Optional:
PROVENANCE_BACKEND_URL=http://127.0.0.1:8008
PROVENANCE_TOKEN_CHAMFER_THRESHOLD=0.5
```

Run the backend before using PROV graph generation or the chat panel:

```bash
cd ../agent_provenance_backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8008
```

## Provenance Copilot

The dashboard also includes a small chat panel for the current selection. The
Next route proxies the request to the Python backend, and the backend makes the
LLM call.

Set these environment variables before running the app:

```bash
PORTKEY_API_KEY=...
PORTKEY_BASE_URL=https://your-portkey-server/v1/
PORTKEY_MODEL=gpt-5-mini
```

Select up to 3 runs in the matrix, then ask questions about the active
provenance graph. The request includes the selected traces, their scores,
metadata, and ordered tool calls with parameters.

## Main files

- [`app/page.tsx`](./app/page.tsx): page shell and state
- [`app/components/upset_plot.js`](./app/components/upset_plot.js): provenance matrix renderer
- [`app/components/visualization_shared.js`](./app/components/visualization_shared.js): shared trace parsing and glyph helpers
- [`app/components/provenance_copilot.tsx`](./app/components/provenance_copilot.tsx): minimal chat UI for the selected runs
- [`app/api/provenance-agent/route.ts`](./app/api/provenance-agent/route.ts): chat proxy route
- [`../agent_provenance_backend/app.py`](../agent_provenance_backend/app.py): PROV graph and LLM backend
