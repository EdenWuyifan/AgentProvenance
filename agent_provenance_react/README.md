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

## Main files

- [`app/page.tsx`](./app/page.tsx): page shell and state
- [`app/components/upset_plot.js`](./app/components/upset_plot.js): provenance matrix renderer
- [`app/components/visualization_shared.js`](./app/components/visualization_shared.js): shared trace parsing and glyph helpers
