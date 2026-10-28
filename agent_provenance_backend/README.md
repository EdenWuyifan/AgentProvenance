# AgentTrails backend

Run from the repository root:

```sh
.venv/bin/uvicorn app:app --app-dir agent_provenance_backend --host 127.0.0.1 --port 8008
```

The frontend proxies requests to `PROVENANCE_BACKEND_URL` (default `http://127.0.0.1:8008`).

## API

- `POST /api/prov-graph`: normalize one trace and return its inspectable Activity–Entity graph.
- `POST /api/joined-provenance-graph`: review and join selected traces; return importance, display groups and source witnesses.
- `POST /api/tool-sets`: list tools for the source collection.
- `POST /api/provenance-agent`: stream validated graph-inspection actions from Copilot.
- `POST /api/import-workflows`: import supported workflow records and persist their manifest.
- `GET /api/workflow-corpora`: list saved imports.
- `GET /api/workflow-corpora/{corpus_id}`: read an imported corpus.

See request/response definitions in `app.py`; no benchmark-specific routes are used. A trace supplies `traceId`, `toolCalls`, optional task/final text, initial context, outcomes and declared reference schemas. Imported workflows and analysis snapshots can instead provide `workflowRef` or `snapshotRef`.

## Evidence and caches

Recorded references are kept separate from retrieved and model-reviewed relevance. Inferred links require source and consumer citations, respect temporal availability, and never replace recorded transport. Joint patterns retain per-run witnesses and complementary input branches. S/R/O importance and pattern selection are independent of display-only clustering.

Analyses and paid responses live under `agent_provenance_react/.cache/pattern-framework/`; corpus state lives under `state_dir/`. Neither belongs in Git. Snapshot replay requires its saved analysis record and makes no inference. Keep caches when cleaning generated builds.

For uncached review/Copilot, install and sign in to Codex CLI. `AGENTTRAILS_CODEX` defaults to `codex`, `AGENTTRAILS_MODEL` to `gpt-6-luna`. Embedding retrieval uses a local sentence-transformer model; model files are persistent dependencies. Do not share private traces or credentials with a public repository.

Run network-free regressions from the root with `.venv/bin/python -B -m pytest tests -q`.
