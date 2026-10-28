export type TraceSource = { name: string; path?: string; text?: string };

export const EXAMPLES: Array<{ name: string; sources: TraceSource[] }> = [
  { name: "Discovera", sources: [{ name: "Full traces", path: "/tracings.jsonl" }] },
  {
    name: "App world (Use Case 2)",
    sources: [
      { name: "Bill splitting", path: "/appworld-bill-cached.jsonl" },
      { name: "SMS movie", path: "/appworld-movie-cached.jsonl" },
    ],
  },
  { name: "Suzuki", sources: [{ name: "Cached review", path: "/cached-suzuki-review.jsonl" }] },
];

export const DEFAULT_TRACE_SOURCE = EXAMPLES[0].sources[0];

export function parseTraceView(search: string) {
  const params = new URLSearchParams(search);
  const sourcePath = params.get("source") ?? DEFAULT_TRACE_SOURCE.path;
  const source = EXAMPLES.flatMap((example) => example.sources).find((item) => item.path === sourcePath)
    ?? (sourcePath && /^\/api\/workflow-corpora\/[\w-]+$/.test(sourcePath)
      ? { name: "Saved workflow corpus", path: sourcePath }
      : DEFAULT_TRACE_SOURCE);
  const filters: Partial<GraphFilters> = {};
  if (params.has("q")) filters.text = params.get("q")!;
  const support = Number(params.get("support"));
  if (Number.isInteger(support) && support > 0) filters.minSupport = support;
  if (params.get("display") === "flow") filters.view = "isolate";
  const context = params.get("context");
  if (context === "parents" || context === "inputs" || context === "neighbors" || context === "workflow") filters.context = context;
  const role = params.get("role");
  if (role === "key" || role === "supporting" || role === "unknown") filters.role = role;
  const evidence = params.get("evidence");
  if (evidence === "main" || evidence === "supported" || evidence === "direct" || evidence === "path" || evidence === "failure") filters.evidence = evidence;
  const outcome = Number(params.get("outcome"));
  if (Number.isFinite(outcome) && outcome > 0) filters.minOutcome = outcome;
  const links = params.get("links");
  if (links === "recorded" || links === "inferred") filters.links = links;
  return {
    source,
    runs: (params.get("runs") ?? "").split(",").filter(Boolean),
    axis: params.get("axis") === "semantic" || params.get("axis") === "evidence" || params.get("axis") === "outcome" ? params.get("axis") as "semantic" | "evidence" | "outcome" : undefined,
    filters,
  };
}

export function traceViewUrl(source: TraceSource, runs: Array<string | number>, axis = "semantic", figureScale = 1, filters: Partial<GraphFilters> = {}) {
  const params = new URLSearchParams({ source: source.path!, runs: runs.map(String).join(","), axis });
  if (figureScale > 1) params.set("figure", String(figureScale));
  if (filters.text) params.set("q", filters.text);
  if (filters.minSupport) params.set("support", String(filters.minSupport));
  if (filters.view === "isolate") params.set("display", "flow");
  if (filters.context && filters.context !== "none") params.set("context", filters.context);
  if (filters.role && filters.role !== "all") params.set("role", filters.role);
  if (filters.evidence && filters.evidence !== "all") params.set("evidence", filters.evidence);
  if (filters.minOutcome) params.set("outcome", String(filters.minOutcome));
  if (filters.links && filters.links !== "all") params.set("links", filters.links);
  return `/?${params}`;
}

import type { GraphFilters } from "./graph_search";
