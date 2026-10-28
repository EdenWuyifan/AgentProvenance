# AgentTrails

Visual analytics for comparing tool-using agent runs. AgentTrails reconstructs provenance, joins repeated operations across runs, and lets users inspect and filter compact patterns while retaining their source evidence.

## Run locally

Use Python 3.10+ and Node.js 22.18+.

```sh
python3 -m venv .venv
.venv/bin/pip install -e . -r agent_provenance_backend/requirements.txt
cd agent_provenance_react
npm ci
cd ..
PYTHON="$PWD/.venv/bin/python" ./run_agent_provenance_system.sh
```

Open http://localhost:3000. No runs are selected automatically. **Open traces** accepts JSON/JSONL files. The three dropdown examples use local datasets:

| Example | Local file under `agent_provenance_react/public/` |
| --- | --- |
| Discovera | `tracings.jsonl` (full collection) |
| App world (Use Case 2) | `appworld-bill-cached.jsonl`, `appworld-movie-cached.jsonl` |
| Suzuki | `cached-suzuki-review.jsonl` |

These datasets and paid caches stay local and are excluded from Git. Files containing `snapshotRef` require the corresponding content-addressed records under `agent_provenance_react/.cache/pattern-framework/analyses/`. Keep JSONL files and their cache together. A missing snapshot is reported rather than silently reconstructed. Opening the full Discovera collection does not imply that every run already has a semantic review.

Uncached analysis and Copilot use the signed-in Codex CLI, defaulting to `gpt-6-luna`. The CLI must be on `PATH`; override it with `AGENTTRAILS_CODEX` and the model with `AGENTTRAILS_MODEL`. Cached replay and ordinary graph interactions require no new model calls. Model requests use the user's configured hosted service; they are not local model inference.

## Workflow and interface

1. Normalize calls into activities and output entities, retaining original parameters, responses and order.
2. Recover recorded references; retrieve earlier evidence and review semantic candidates with cited source and consumer evidence. Recorded transport and inferred relevance stay distinct.
3. Assess semantic significance, support for the final result and association with run outcomes. Outcome association is observational.
4. Join compatible operations across runs. Expand display groups in place to inspect Activity–Entity records and original witnesses. Selection preserves complete witnessed multi-input patterns for downstream use.

All traces, including user imports, use the same graph controls and importance heatmap. Search, Main flow and Shared flow reduce the displayed context. Click a node or connection to follow its neighborhood. **Fit all** frames the overview; **100%** restores readable detail. Run labels default to recorded outcomes or numeric scores. User-defined score rules affect display only. Tool errors remain separate from whole-run outcomes.

## Repository

- `agent_provenance/`: trace parsing, Python dashboard and import utilities.
- `agent_provenance_backend/`: generic provenance, retrieval, importance, pattern selection and API.
- `agent_provenance_react/`: interface and synthetic frontend tests.
- `tests/`: focused, network-free Python regression tests.

Local scientific archives, paper outputs, worlds, response caches and persistent state are deliberately outside version control. They are not deleted by source cleanup. There is no separate core export.

## Verify

```sh
.venv/bin/python -B -m pytest -p no:cacheprovider tests -q
cd agent_provenance_react
npm test
npx tsc --noEmit
npm run build
```

Tests use synthetic records and mocked inference, without paid requests. They cover temporal and multi-input dependencies, witness preservation, importance, selection, replay, protocol handling and display grouping. They do not establish inferred-edge accuracy or usability.

Graph exploration adapts [motif simplification](https://doi.org/10.1145/2470654.2466444), [Search, Show Context, Expand on Demand](https://doi.org/10.1109/TVCG.2009.108), and findings on [path readability](https://doi.org/10.1057/palgrave.ivs.9500013). See [frontend controls](agent_provenance_react/README.md) and [backend API](agent_provenance_backend/README.md).
