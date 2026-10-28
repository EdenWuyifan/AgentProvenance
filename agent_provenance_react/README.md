# AgentTrails interface

```sh
npm ci
npm run dev
```

The backend must be available at `PROVENANCE_BACKEND_URL` (default `http://127.0.0.1:8008`). The page has three dropdown examples: **Discovera**, **App world (Use Case 2)** and **Suzuki**. App world has two task choices. All traces, including user imports, use common graph and heatmap controls. **Open traces** loads user-provided JSON/JSONL. No runs are selected on initial load.

Example JSONL and content-addressed snapshot caches are local data, excluded from Git. See the root README for file locations. Saved analysis replay does not make new model requests; selecting uncached raw traces can require review.

## Inspect a graph

- Search tools or evidence; use **Main flow**, **Shared flow** or **All steps** to control context.
- **Color** selects semantic role, result evidence or score association. This heatmap is separate from run success/failure.
- Wider lines indicate more supporting runs. Recorded links are solid; inferred-only links are dashed. Shared/key paths use angular routing; supporting links use rounded curves. Distinct ports and white halos clarify endpoints and crossings.
- Hover or select a step/connection to dim unrelated items. **Fit all** shows the whole projection; **100%** provides readable detail with panning.
- Expand a group in place to see activities and entities. Matching operations share a container while retaining parameter and outcome variants. Exact entity identity requires matching content, type and producer lineage; other variants remain explicitly expandable.
- **Run labels** defaults to recorded outcomes or numeric scores. Choose a numeric field or an explicit threshold rule. Rules never regrade runs. Inside a cluster, click a run label to inspect its records. A tool error is different from a failed run.

Display projection never creates chronological dependency edges or changes S/R/O, canonical provenance, skill selection or export. Imported workflow timelines retain agent/role lanes. Manual positions and filters are source-scoped.

Design references: [Dunne and Shneiderman, 2013](https://doi.org/10.1145/2470654.2466444), [van Ham and Perer, 2009](https://doi.org/10.1109/TVCG.2009.108), [Ware et al., 2002](https://doi.org/10.1057/palgrave.ivs.9500013), and [Holten et al., 2011](https://doi.org/10.1109/PACIFICVIS.2011.5742390). These motivate the design; local checks do not establish improved usability.

## Verify and build

Node.js 22.18+ is required for native TypeScript stripping in the tests.

```sh
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Tests use synthetic records, without backend inference or private datasets. Keep the lockfile for reproducible dependency installation.
