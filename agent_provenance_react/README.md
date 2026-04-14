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

## Provenance Copilot

The dashboard also includes a small Portkey-backed chat panel for the current
selection.

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
- [`app/api/provenance-agent/route.ts`](./app/api/provenance-agent/route.ts): Portkey-backed server route
