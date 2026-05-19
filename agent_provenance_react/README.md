# AgentProvenance React UI

Browser interface for exploring agent trace provenance. The frontend owns data
loading, selection state, visualization, and proxy routes. It does not infer
provenance dependencies; graph generation lives in the backend.

Backend behavior is documented in
[`../agent_provenance_backend/README.md`](../agent_provenance_backend/README.md).

## Frontend Domain

- Load JSON or JSONL trace files from `public/`.
- Render the provenance matrix and selected trace context.
- Proxy graph and chat requests to the Python backend.
- Display single-trace PROV DAGs and joined provenance graphs.
- Keep UI state for selected runs, graph mode, thresholds, and chat.

## Run Locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

Set the backend URL when it is not running on the default port:

```bash
PROVENANCE_BACKEND_URL=http://127.0.0.1:8008
```

## Data Source

The default page reads trace data from:

- [`public/tracings.jsonl`](./public/tracings.jsonl)

[`public/pi_mono_tracings.jsonl`](./public/pi_mono_tracings.jsonl) is available
as an alternate local dataset.

Supported trace shapes:

- JSON arrays
- JSONL files
- `tool_calls`
- `toolCalls`
- `calls`
- `steps`
- LangSmith-style `outputs.messages[].tool_calls`

## Backend Boundary

The Next routes under `app/api/` only forward requests to the Python service:

- `app/api/provenance-dag/route.ts` -> `POST /api/prov-graph`
- `app/api/joined-provenance-graph/route.ts` -> `POST /api/joined-provenance-graph`
- `app/api/tool-sets/route.ts` -> `POST /api/tool-sets`
- `app/api/provenance-agent/route.ts` -> `POST /api/provenance-agent`

Run the backend before using PROV graph generation, joined graphs, or the chat
panel:

```bash
cd ../agent_provenance_backend
source .venv/bin/activate
uvicorn app:app --host 127.0.0.1 --port 8008
```

The matrix can still render static trace files without the backend.

## Main Files

- [`app/page.tsx`](./app/page.tsx): page shell and state.
- [`app/components/upset_plot.js`](./app/components/upset_plot.js): provenance
  matrix renderer.
- [`app/components/provenance_graph.tsx`](./app/components/provenance_graph.tsx):
  single and joined graph visualization.
- [`app/components/provenance_copilot.tsx`](./app/components/provenance_copilot.tsx):
  chat panel for selected runs.
- [`app/components/visualization_shared.js`](./app/components/visualization_shared.js):
  shared trace parsing and glyph helpers.
