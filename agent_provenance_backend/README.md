# AgentProvenance Backend

FastAPI service for provenance graph construction and LLM-backed provenance
reasoning. The backend owns inference and graph generation; the React app owns
display and user interaction.

## Backend Domain

- Normalize trace tool calls into compact Activity and Entity records.
- Build single-trace PROV DAGs from tool inputs, outputs, and explicit evidence.
- Cache generated DAGs under `agent_provenance_react/.cache/generated-prov-graphs`.
- Build joined provenance graphs across selected traces.
- Stream Provenance Copilot answers for selected runs.

The backend does not render the matrix or graph UI. Frontend behavior is
documented in [`../agent_provenance_react/README.md`](../agent_provenance_react/README.md).

## Run Locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8008
```

Health check:

```bash
curl http://127.0.0.1:8008/health
```

## Environment

The service reads `../agent_provenance_react/.env` if present, then falls back to
the shell environment.

```bash
PORTKEY_API_KEY=...
PORTKEY_BASE_URL=...
PORTKEY_MODEL=...
```

## API

- `GET /health`: service status.
- `POST /api/prov-graph`: builds or returns a cached PROV DAG for one trace.
- `POST /api/joined-provenance-graph`: joins multiple trace DAGs into shared
  activity clusters, root nodes, support summaries, and motifs.
- `POST /api/tool-sets`: generates and caches semantic tool groups for one
  trace file hash.
- `POST /api/provenance-agent`: streams chat answers for selected traces.

## PROV Graph Rules

- Activity nodes contain call identity, tool name, time index, and sanitized
  args.
- Entity nodes contain sanitized output responses.
- Responses are not duplicated on Activity nodes.
- Entity metadata such as names and paths stays inside the response payload.
- The draft graph is strictly bipartite: `Activity -> Entity` for generated
  outputs and `Entity -> Activity` for consumed inputs.
- The default graph contains only structural generated outputs and exact
  artifact `usedBy` edges.
- Output entities whose artifact refs are inherited from a consumed input stay
  visible but are not reused as downstream artifact sources.
- Shared-token matches use plain string scalar extraction with a `0.2`
  threshold, but they are only passed to the LLM as optional semantic
  candidates.
- The refinement LLM receives the sanitized draft graph plus optional semantic
  candidates and returns graph edit operations.

## Main Files

- [`app.py`](./app.py): FastAPI routes, single-trace graph generation, LLM calls.
- [`joined_provenance.py`](./joined_provenance.py): joined graph clustering,
  root support, edge support, and motifs.
- [`requirements.txt`](./requirements.txt): runtime dependencies.
