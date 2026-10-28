"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  useState,
} from "react";

import { SemanticGraphView } from "./components/semantic_graph";
import { createGraphWorkspace } from "./components/graph_layout";
import { graphScope, type GraphCommand, type GraphViewState } from "./components/graph_controls";
import { DEFAULT_GRAPH_FILTERS } from "./components/graph_search";
import { ProvenanceCopilot } from "./components/provenance_copilot";
import { DEFAULT_TRACE_SOURCE, EXAMPLES, parseTraceView, traceViewUrl, type TraceSource } from "./components/trace_sources";
import type {
  AgentDag,
  GraphMode,
  JoinedProvenanceGraph,
  ToolSets,
  Tracing,
} from "./components/types";
import { renderUpsetPlot } from "./components/upset_plot";
import {
  extractToolCallRecords,
  parseTracingPayload,
  prepareTracings,
} from "./components/visualization_shared";

const GROUPING_EXCLUDED_KEYS = new Set([
  "id",
  "score",
  "toolCalls",
  "tool_calls",
  "finalOutput",
  "snapshotRef",
  "final_answer",
  "answer",
]);
const SCORING_EXCLUDED_KEYS = new Set(["id", "trace_id", "toolCalls", "tool_calls", "seed", "isSummary", "eventCount", "participantCount"]);
const TRACE_SELECTION_COLORS = [
  "rgba(56, 189, 248, 0.18)",
  "rgba(251, 146, 60, 0.18)",
  "rgba(74, 222, 128, 0.18)",
] as const;
const TRACE_SELECTION_ACCENTS = ["#38bdf8", "#fb923c", "#22c55e"] as const;

function traceSelectionColor(index: number) {
  const color = TRACE_SELECTION_COLORS[index];
  if (color) {
    return color;
  }

  const hue = (index * 137.508) % 360;
  return `hsl(${hue} 86% 90% / 0.42)`;
}

function traceSelectionAccent(index: number) {
  const color = TRACE_SELECTION_ACCENTS[index];
  if (color) {
    return color;
  }

  return `hsl(${(index * 137.508) % 360} 70% 42%)`;
}

type TopChartMode = "usage" | "impact";
type ComparisonDetail = "overview" | "all";
type AgentDagState =
  | { status: "loading" }
  | { status: "ready"; dag: AgentDag; analysisKey: string; tracing?: Tracing }
  | { status: "error"; message: string };
type JoinedGraphState =
  | { status: "idle" }
  | { status: "loading"; key: string }
  | { status: "ready"; key: string; graph: JoinedProvenanceGraph }
  | { status: "error"; key: string; message: string };

function getGroupingOptions(tracings: Tracing[]) {
  const keys = new Set<string>();

  tracings.forEach((tracing) => {
    Object.entries(tracing).forEach(([key, value]) => {
      if (GROUPING_EXCLUDED_KEYS.has(key)) {
        return;
      }

      if (value === null || value === undefined || value === "") {
        return;
      }

      if (typeof value === "object") {
        return;
      }

      keys.add(key);
    });
  });

  return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

function getGroupingValues(tracings: Tracing[], groupBy: string) {
  if (!groupBy) {
    return [];
  }

  const values = new Set<string>();

  tracings.forEach((tracing) => {
    const value = tracing[groupBy];

    if (value === null || value === undefined || value === "") {
      return;
    }

    if (typeof value === "object") {
      return;
    }

    values.add(String(value));
  });

  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

function isScoringValue(value: unknown) {
  if (typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

function getScoringOptions(tracings: Tracing[]) {
  const keys = new Set<string>();

  tracings.forEach((tracing) => {
    Object.entries(tracing).forEach(([key, value]) => {
      if (!SCORING_EXCLUDED_KEYS.has(key) && isScoringValue(value)) {
        keys.add(key);
      }
    });
  });

  return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

function normalizeTracing(
  tracing: Record<string, unknown> & { id: Tracing["id"]; score?: unknown }
): Tracing {
  return {
    ...Object.fromEntries(
      Object.entries(tracing).filter(([key]) => !GROUPING_EXCLUDED_KEYS.has(key))
    ),
    id: tracing.id,
    score:
      tracing.score === null
        ? null
        : isScoringValue(tracing.score)
          ? Number(tracing.score)
          : undefined,
    toolCalls: extractToolCallRecords(tracing),
    finalOutput: typeof tracing.finalOutput === "string" ? tracing.finalOutput : null,
    snapshotRef: typeof tracing.snapshotRef === "string" ? tracing.snapshotRef : undefined,
  };
}

function workflowRequest(tracing: Tracing) {
  return { eventSchemaVersion: tracing.eventSchemaVersion, participants: tracing.participants,
    eventLinks: tracing.eventLinks, outcomes: tracing.outcomes, importMetadata: tracing.importMetadata,
    workflowRef: tracing.workflowRef, snapshotRef: tracing.snapshotRef };
}

function resolveTaskDescription(tracing: Tracing) {
  const value = [
    tracing.task_description,
    tracing.taskDescription,
    tracing.task,
  ].find((candidate) => typeof candidate === "string");
  return typeof value === "string" ? value : null;
}

async function hashText(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function uniqueToolNames(tracings: Tracing[]) {
  return Array.from(
    new Set(
      tracings.flatMap((tracing) =>
        tracing.toolCalls.map((toolCall) => toolCall.name).filter(Boolean)
      )
    )
  ).sort((a, b) => a.localeCompare(b));
}

function useTracingData(source: TraceSource) {
  const [data, setData] = useState<Tracing[]>([]);
  const [cacheKey, setCacheKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadedSource, setLoadedSource] = useState<TraceSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const text = source.text ?? await fetchTraceText(source);
        if (cancelled) {
          return;
        }

        let records = parseTracingPayload(text);
        if (records.some((record: Record<string, unknown>) => record.token_log && record.config && record.steps)) {
          const response = await fetch('/api/import-workflows', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ records, label: source.name }) });
          if (!response.ok) throw new Error(await response.text());
          records = (await response.json()).traces;
        }
        const parsed = prepareTracings(records).map(normalizeTracing);
        const nextCacheKey = await hashText(text);
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setData(parsed);
          setCacheKey(nextCacheKey);
          setLoadedSource(source);
          setError(null);
          setLoading(false);
        });
      } catch (loadError) {
        if (cancelled) {
          return;
        }

        const message =
          loadError instanceof Error
            ? loadError.message
            : "Unable to load traces";

        startTransition(() => {
          setData([]);
          setCacheKey("");
          setLoadedSource(source);
          setError(message);
          setLoading(false);
        });
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [source]);

  return { data, cacheKey, loading: loading || loadedSource !== source, error };
}

async function fetchTraceText(source: TraceSource) {
  if (!source.path) {
    throw new Error("Trace source is missing a path.");
  }

  const response = await fetch(source.path);
  if (!response.ok) {
    throw new Error(response.status === 404
      ? 'No trace file is available for this source. Use Open traces to load a JSON or JSONL file.'
      : `Unable to load this source (HTTP ${response.status}).`);
  }

  return response.text();
}

function Card({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-zinc-950">
            {title}
          </h2>
          <div className="mt-1 max-w-3xl text-sm text-zinc-600">{description}</div>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function StatusMessage({ message }: { message: string }) {
  return (
    <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-zinc-200 bg-zinc-50 px-6 py-10 text-sm text-zinc-600">
      {message}
    </div>
  );
}

function UpsetGroupBySelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="inline-flex h-full min-w-0 flex-1 items-center text-[11px] text-zinc-600">
      <span className="shrink-0 border-r border-zinc-300 px-2">Group rows</span>
      <select
        className="h-full min-w-0 flex-1 border-0 bg-transparent px-2 text-[11px] text-zinc-950 outline-none"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">None</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function UpsetScoreBySelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="inline-flex h-full min-w-0 flex-1 items-center text-[11px] text-zinc-600">
      <span className="shrink-0 border-r border-zinc-300 px-2">Score by</span>
      <select
        className="h-full min-w-0 flex-1 border-0 bg-transparent px-2 text-[11px] text-zinc-950 outline-none disabled:text-zinc-400"
        value={value}
        disabled={options.length === 0}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.length === 0 ? (
          <option value="score">score</option>
        ) : (
          options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))
        )}
      </select>
    </label>
  );
}

function UpsetFoldActions({
  disabled,
  onFoldAll,
  onExpandAll,
}: {
  disabled: boolean;
  onFoldAll: () => void;
  onExpandAll: () => void;
}) {
  return (
    <div className="inline-flex h-full shrink-0 items-center border-l border-zinc-300 text-[11px]">
      <button
        type="button"
        className="h-full px-2 text-zinc-500 transition hover:text-zinc-950 disabled:cursor-default disabled:text-zinc-300"
        onClick={onFoldAll}
        disabled={disabled}
      >
        Fold all
      </button>
      <button
        type="button"
        className="h-full border-l border-zinc-300 px-2 text-zinc-500 transition hover:text-zinc-950 disabled:cursor-default disabled:text-zinc-300"
        onClick={onExpandAll}
        disabled={disabled}
      >
        Expand all
      </button>
    </div>
  );
}

function UpsetTopChartToggle({
  mode,
  onChange,
}: {
  mode: TopChartMode;
  onChange: (mode: TopChartMode) => void;
}) {
  return (
    <div className="inline-flex h-full items-center border-r border-zinc-300 bg-zinc-50">
      {[
        ["usage", "Usage"],
        ["impact", "Impact"],
      ].map(([value, label]) => {
        const active = mode === value;

        return (
          <button
            key={value}
            type="button"
            className={`h-full px-2 text-[11px] font-medium transition ${
              active
                ? "bg-white text-zinc-950 shadow-sm"
                : "text-zinc-500 hover:text-zinc-950"
            }`}
            style={value === "impact" ? { borderLeft: "1px solid rgb(212 212 216)" } : undefined}
            onClick={() => onChange(value as TopChartMode)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function parseFigureScale(search: string) {
  const raw = new URLSearchParams(search).get("figure");
  if (raw === null) {
    return 1;
  }

  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 1) {
    return Math.min(parsed, 2.5);
  }

  return 1.4;
}

export default function Home() {
  const upsetRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Figure mode (?figure or ?figure=1.6): larger fonts for paper screenshots.
  const [figureScale, setFigureScale] = useState(1);

  const [traceSource, setTraceSource] = useState<TraceSource>(DEFAULT_TRACE_SOURCE);
  const initialRunIds = useRef<string[] | null>(null);
  const [requestedView, setRequestedView] = useState<ReturnType<typeof parseTraceView> | null>(null);
  const sourceRevision = useRef(0);
  const [selectedTracingIds, setSelectedTracingIds] = useState<Array<Tracing["id"]>>([]);
  const [toolSets, setToolSets] = useState<ToolSets>({});
  const [topChartMode, setTopChartMode] = useState<TopChartMode>("impact");
  const [upsetGroupBy, setUpsetGroupBy] = useState("");
  const [upsetScoreBy, setUpsetScoreBy] = useState("score");
  const [toolMatrixOpen, setToolMatrixOpen] = useState(false);
  const [toolMatrixEpoch, setToolMatrixEpoch] = useState(0);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [comparisonDetail, setComparisonDetail] = useState<ComparisonDetail>("overview");
  const [laneBy, setLaneBy] = useState<'agent' | 'role'>('agent');
  const [focusDraft, setFocusDraft] = useState("");
  const [focus, setFocus] = useState("");
  const [targetCallSelection, setTargetCallSelection] = useState("");
  const [graphMode] = useState<GraphMode>("tree");
  const [agentDagStates, setAgentDagStates] = useState<
    Record<string, AgentDagState>
  >({});
  const [joinedGraphState, setJoinedGraphState] = useState<JoinedGraphState>({
    status: "idle",
  });
  const [hoveredJoinedTraceId, setHoveredJoinedTraceId] = useState<string | null>(null);
  const [pinnedJoinedTraceId, setPinnedJoinedTraceId] = useState<string | null>(null);
  const agentDagStatesRef = useRef<Record<string, AgentDagState>>({});

  const { data, cacheKey, loading, error } = useTracingData(traceSource);
  const activeExample = EXAMPLES.find((example) => example.sources.some((source) => source.path === traceSource.path));
  const [graphViewState, setGraphViewState] = useState<GraphViewState | null>(null);
  const [graphCommands, setGraphCommands] = useState<GraphCommand[]>([]);
  const graphWorkspace = useMemo(() => {
    const workspace = createGraphWorkspace(cacheKey);
    workspace.axis = requestedView?.axis;
    workspace.filters = {...DEFAULT_GRAPH_FILTERS, ...requestedView?.filters};
    return workspace;
  }, [cacheKey, requestedView]);
  const groupingOptions = getGroupingOptions(data);
  const groupingValues = getGroupingValues(data, upsetGroupBy);
  const scoringOptions = getScoringOptions(data);
  const selectedScoreBy = scoringOptions.includes(upsetScoreBy)
    ? upsetScoreBy
    : scoringOptions[0] ?? "score";
  const selectedTracings = useMemo(
    () => selectedTracingIds
      .map((selectedTracingId) =>
        (() => {
          const tracing = data.find((tracing) => tracing.id === selectedTracingId);
          const state = agentDagStates[String(selectedTracingId)];
          return tracing ? { ...tracing, ...(state?.status === 'ready' ? state.tracing : undefined) } : null;
        })()
      )
      .filter((tracing): tracing is Tracing => tracing !== null),
    [data, selectedTracingIds, agentDagStates]
  );
  const selectedTracing = selectedTracings[0] ?? null;
  const selectedJoinKey = `${selectedScoreBy}:${comparisonDetail}:${laneBy}:${focus}:${targetCallSelection}:${selectedTracingIds.map(String).join(":")}`;
  const targetCallOptions = selectedTracings.flatMap((tracing) => tracing.toolCalls
    .filter((call) => typeof call.id === "string" && call.id.length > 0 && (!tracing.eventSchemaVersion || tracing.outcomes?.some((outcome) => outcome.eventId === call.id)))
    .map((call) => ({
      id: call.id!,
      traceId: String(tracing.id),
      value: JSON.stringify([String(tracing.id), call.id]),
      label: `Run #${tracing.id}${call.round === undefined ? '' : ` · Round ${call.round + 1}`} · ${call.name} · step ${tracing.toolCalls.indexOf(call) + 1}`,
    })));
  const selectedTarget = targetCallOptions.find((option) => option.value === targetCallSelection);
  const selectedDagStates = selectedTracings.map(
    (tracing) => agentDagStates[String(tracing.id)]
  );
  const selectedDagsReady =
    selectedTracings.length >= 1 &&
    selectedDagStates.every((state) => state?.status === "ready");
  const selectedDagsError =
    selectedTracings.length >= 1 &&
    selectedDagStates.some((state) => state?.status === "error");
  const selectedTraceDags = useMemo(() => selectedTracings.reduce<Record<string, AgentDag>>(
    (graphs, tracing) => {
      const state = agentDagStates[String(tracing.id)];
      if (state?.status === "ready") {
        graphs[String(tracing.id)] = state.dag;
      }
      return graphs;
    },
    {}
  ), [selectedTracings, agentDagStates]);
  const activeJoinedGraph =
    joinedGraphState.status === "ready" && joinedGraphState.key === selectedJoinKey
      ? joinedGraphState.graph
      : null;
  const activeGraphScope = useMemo(() => activeJoinedGraph ? graphScope(activeJoinedGraph, cacheKey) : null, [activeJoinedGraph, cacheKey]);
  const highlightedJoinedTraceId = hoveredJoinedTraceId ?? pinnedJoinedTraceId;
  const selectedTracingColors = useMemo(
    () =>
      Object.fromEntries(
        selectedTracingIds.map((selectedTracingId, index) => [
          selectedTracingId,
          traceSelectionColor(index),
        ])
      ),
    [selectedTracingIds]
  );

  const openTraceSource = useCallback((source: TraceSource) => {
    sourceRevision.current += 1;
    setSelectedTracingIds([]);
    setCollapsedGroups([]);
    agentDagStatesRef.current = {};
    setAgentDagStates({});
    setJoinedGraphState({ status: "idle" });
    setHoveredJoinedTraceId(null);
    setPinnedJoinedTraceId(null);
    setToolSets({});
    setUpsetScoreBy("score");
    setUpsetGroupBy("");
    setFocus("");
    setFocusDraft("");
    setComparisonDetail("overview");
    setGraphCommands([]);
    setGraphViewState(null);
    setTargetCallSelection('');
    setRequestedView(null);
    setTraceSource(source);
  }, []);

  const handleFileOpen = useCallback(async (files: File[]) => {
    if (!files.length) return;
    const contents = await Promise.all(files.map((file) => file.text()));
    openTraceSource({ name: files.length === 1 ? files[0].name : `${files.length} workflow files`,
      text: contents.length === 1 ? contents[0] : JSON.stringify(contents.flatMap(parseTracingPayload)) });
  }, [openTraceSource]);

  const setAgentDagState = useCallback((traceId: Tracing["id"], state: AgentDagState) => {
    agentDagStatesRef.current = {
      ...agentDagStatesRef.current,
      [String(traceId)]: state,
    };
    setAgentDagStates(agentDagStatesRef.current);
  }, []);

  const loadAgentDag = useCallback(async (tracing: Tracing) => {
    const revision = sourceRevision.current;
    const state = agentDagStatesRef.current[String(tracing.id)];

    if (state?.status === "loading" || state?.status === "ready") {
      return;
    }

    setAgentDagState(tracing.id, { status: "loading" });

    try {
      const response = await fetch("/api/provenance-dag", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          traceId: tracing.id,
          toolCalls: tracing.workflowRef || tracing.snapshotRef ? undefined : tracing.toolCalls,
          ...workflowRequest(tracing),
          taskId: tracing.task_id ?? tracing.taskId ?? null,
          taskDescription: resolveTaskDescription(tracing),
          finalOutput: tracing.finalOutput ?? null,
          focus,
          targetCallIds: selectedTarget?.traceId === String(tracing.id) ? [selectedTarget.id] : [],
        }),
      });

      if (!response.ok) {
        throw new Error((await response.text()) || "Unable to build PROV graph.");
      }

      const payload = (await response.json()) as {
        dag: AgentDag;
        analysis: {
          traceId: string | number;
          analysisKey: string;
        };
        tracing?: Tracing;
      };

      if (revision !== sourceRevision.current) return;
      setAgentDagState(tracing.id, {
        status: "ready",
        dag: payload.dag,
        analysisKey: payload.analysis.analysisKey,
        tracing: payload.tracing,
      });
    } catch (loadError) {
      if (revision !== sourceRevision.current) return;
      setAgentDagState(tracing.id, {
        status: "error",
        message: loadError instanceof Error ? loadError.message : "Unable to build PROV graph.",
      });
    }
  }, [setAgentDagState, focus, selectedTarget?.id, selectedTarget?.traceId]);

  useEffect(() => {
    const view = parseTraceView(window.location.search);
    openTraceSource(view.source);
    initialRunIds.current = view.runs;
    setRequestedView(view);
    setFigureScale(parseFigureScale(window.location.search));
  }, [openTraceSource]);

  useEffect(() => {
    if (loading || initialRunIds.current === null) return;
    const ids = new Set(initialRunIds.current);
    initialRunIds.current = null;
    const traces = data.filter((tracing) => ids.has(String(tracing.id)));
    setSelectedTracingIds(traces.map((tracing) => tracing.id));
    traces.forEach((tracing) => { void loadAgentDag(tracing); });
  }, [loading, data, loadAgentDag]);

  const handleTracingSelect = useCallback((tracingId: Tracing["id"]) => {
    setHoveredJoinedTraceId(null);
    setPinnedJoinedTraceId(null);
    const tracing = data.find((item) => item.id === tracingId);

    if (tracing && !selectedTracingIds.includes(tracingId)) {
      void loadAgentDag(tracing);
    }

    setSelectedTracingIds((current) => {
      if (current.includes(tracingId)) {
        return current.filter((selectedTracingId) => selectedTracingId !== tracingId);
      }

      return [...current, tracingId];
    });
  }, [data, loadAgentDag, selectedTracingIds]);

  const handleGroupSelect = useCallback((group: string) => {
    if (!upsetGroupBy) {
      return;
    }

    setHoveredJoinedTraceId(null);
    setPinnedJoinedTraceId(null);

    const groupTracingIds = data
      .filter((tracing) => {
        const value = tracing[upsetGroupBy];
        const label =
          value === null || value === undefined || value === ""
            ? "unknown"
            : String(value);
        return label === group;
      })
      .map((tracing) => tracing.id);
    const groupIdSet = new Set(groupTracingIds);

    data
      .filter((tracing) => groupIdSet.has(tracing.id))
      .forEach((tracing) => {
        void loadAgentDag(tracing);
      });

    setSelectedTracingIds((current) => {
      const selectedGroupCount = groupTracingIds.filter((id) => current.includes(id)).length;

      if (selectedGroupCount === groupTracingIds.length) {
        return current.filter((id) => !groupIdSet.has(id));
      }

      return [
        ...current.filter((id) => !groupIdSet.has(id)),
        ...groupTracingIds,
      ];
    });
  }, [data, loadAgentDag, upsetGroupBy]);

  useEffect(() => {
    const validGroups = new Set(getGroupingValues(data, upsetGroupBy));

    setCollapsedGroups((current) =>
      current.filter((group) => validGroups.has(group))
    );
  }, [data, upsetGroupBy]);

  useEffect(() => {
    setSelectedTracingIds((current) =>
      current.filter((selectedTracingId) =>
        data.some((tracing) => tracing.id === selectedTracingId)
      )
    );
  }, [data]);

  useEffect(() => {
    const toolNames = uniqueToolNames(data);
    if (!cacheKey || toolNames.length === 0) {
      setToolSets({});
      return;
    }

    let cancelled = false;

    async function loadToolSets() {
      try {
        const response = await fetch("/api/tool-sets", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ cacheKey, toolNames }),
        });

        if (!response.ok) {
          throw new Error("Unable to generate tool sets.");
        }

        const payload = await response.json() as { toolSets?: ToolSets };
        if (!cancelled) {
          setToolSets(payload.toolSets ?? {});
        }
      } catch {
        if (!cancelled) {
          setToolSets({});
        }
      }
    }

    void loadToolSets();

    return () => {
      cancelled = true;
    };
  }, [cacheKey, data]);

  useEffect(() => {
    if (selectedTracingIds.length < 1) {
      setJoinedGraphState({ status: "idle" });
      return;
    }

    if (selectedDagsError) {
      const failedState = selectedTracingIds.map((id) => agentDagStates[String(id)]).find((state) => state?.status === "error");
      setJoinedGraphState({
        status: "error",
        key: selectedJoinKey,
        message: failedState?.status === "error" ? failedState.message : "Unable to build one of the selected PROV graphs.",
      });
      return;
    }

    if (!selectedDagsReady) {
      setJoinedGraphState({ status: "loading", key: selectedJoinKey });
      return;
    }

    let cancelled = false;

    async function loadJoinedGraph() {
      setJoinedGraphState({ status: "loading", key: selectedJoinKey });

      try {
        const graphs = selectedTracingIds.flatMap((selectedTracingId) => {
          const tracing = data.find((item) => item.id === selectedTracingId);
          const state = agentDagStates[String(selectedTracingId)];

          return tracing && state?.status === "ready"
            ? [{
                traceId: tracing.id,
                taskId: tracing.task_id ?? tracing.taskId ?? null,
                taskDescription: resolveTaskDescription(tracing),
                finalOutput: tracing.finalOutput ?? null,
                score: isScoringValue(tracing[selectedScoreBy]) ? Number(tracing[selectedScoreBy]) : null,
                scoreMetric: selectedScoreBy === 'score' ? tracing.scoreMetric ?? 'score' : selectedScoreBy,
                toolCalls: tracing.workflowRef || tracing.snapshotRef ? undefined : tracing.toolCalls,
                ...workflowRequest(tracing),
                targetCallIds: selectedTarget?.traceId === String(tracing.id) ? [selectedTarget.id] : [],
              }]
            : [];
        });
        const referenceCohort = data.map((tracing) => {
          const state = agentDagStates[String(tracing.id)];
          return {
            traceId: tracing.id,
            taskId: tracing.task_id ?? tracing.taskId ?? null,
            score: isScoringValue(tracing[selectedScoreBy]) ? Number(tracing[selectedScoreBy]) : null,
            scoreMetric: selectedScoreBy === 'score' ? tracing.scoreMetric ?? 'score' : selectedScoreBy,
            workflowSummary: tracing.workflowSummary,
            tools: [...new Set(tracing.toolCalls.map((call) => call.name))].sort(),
            analysisKey: state?.status === "ready" ? state.analysisKey : tracing.snapshotRef ?? null,
          };
        });
        const response = await fetch("/api/joined-provenance-graph", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ graphs, referenceCohort, detail: comparisonDetail, focus, laneBy }),
        });

        if (!response.ok) {
          throw new Error((await response.text()) || "Unable to join PROV graphs.");
        }

        const payload = (await response.json()) as {
          joinedGraph: JoinedProvenanceGraph;
        };

        if (!cancelled) {
          setJoinedGraphState({
            status: "ready",
            key: selectedJoinKey,
            graph: payload.joinedGraph,
          });
        }
      } catch (loadError) {
        if (!cancelled) {
          setJoinedGraphState({
            status: "error",
            key: selectedJoinKey,
            message:
              loadError instanceof Error
                ? loadError.message
                : "Unable to join PROV graphs.",
          });
        }
      }
    }

    void loadJoinedGraph();

    return () => {
      cancelled = true;
    };
  }, [
    agentDagStates,
    data,
    selectedDagsError,
    selectedDagsReady,
    selectedJoinKey,
    selectedScoreBy,
    comparisonDetail,
    laneBy,
    selectedTracingIds,
    focus,
    targetCallSelection,
    selectedTarget?.id,
    selectedTarget?.traceId,
  ]);

  useEffect(() => {
    const element = upsetRef.current;
    if (!element || loading || error || data.length === 0 || (!toolMatrixOpen && data.length <= 12)) {
      return;
    }

    let currentWidth = Math.max(Math.floor(element.getBoundingClientRect().width), 720);
    const render = (width = currentWidth) => {
      renderUpsetPlot(element, data, toolSets, {
        width,
        matrixMaxHeight: 360,
        fontScale: figureScale,
        topChartMode,
        rowGroupBy: upsetGroupBy || undefined,
        scoreKey: selectedScoreBy,
        scoreLabel: selectedScoreBy,
        collapsedGroups,
        selectedTracingColors,
        onGroupToggle: (group: string) => {
          setCollapsedGroups((current) =>
            current.includes(group)
              ? current.filter((item) => item !== group)
              : [...current, group]
          );
        },
        onGroupSelect: handleGroupSelect,
        onTracingSelect: handleTracingSelect,
      });
    };

    render();

    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = Math.max(Math.floor(entry.contentRect.width), 720);
      if (nextWidth !== currentWidth) {
        currentWidth = nextWidth;
        render(nextWidth);
      }
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [
    collapsedGroups,
    data,
    error,
    figureScale,
    handleGroupSelect,
    handleTracingSelect,
    loading,
    selectedTracingColors,
    selectedScoreBy,
    toolSets,
    topChartMode,
    toolMatrixOpen,
    toolMatrixEpoch,
    upsetGroupBy,
  ]);

  return (
    <div
      className={`min-h-screen bg-stone-100 px-4 py-10 text-zinc-950${
        figureScale > 1 ? " figure-mode" : ""
      }`}
    >
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="px-1">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-zinc-500">
            AgentTrails
          </p>
        </header>

        <Card
          title="Traces overview"
          description="Visualize and explore the provenance of your agent runs, including the tools they used and their outcomes."
        >
          <div className="mb-4 flex h-8 w-fit items-center rounded-md border border-zinc-300 bg-zinc-50">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".json,.jsonl,application/json"
              className="hidden"
              onChange={(event) => {
                void handleFileOpen(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className="h-full border-r border-zinc-300 px-2 text-[11px] font-medium text-zinc-500 transition hover:text-zinc-950"
              onClick={() => fileInputRef.current?.click()}
            >
              Open traces
            </button>
            <select
              aria-label="Trace source"
              title={traceSource.name}
              className="h-full max-w-96 border-r border-zinc-300 bg-transparent px-2 text-[11px] text-zinc-700"
              value={activeExample?.name ?? ""}
              onChange={(event) => {
                const example = EXAMPLES.find((item) => item.name === event.target.value);
                if (example) openTraceSource(example.sources[0]);
              }}
            >
              {!activeExample && <option value="">{traceSource.name}</option>}
              {EXAMPLES.map((example) => <option key={example.name} value={example.name}>{example.name}</option>)}
            </select>
            {activeExample && activeExample.sources.length > 1 && <select aria-label="Example task" title={traceSource.name} className="h-full border-r border-zinc-300 bg-transparent px-2 text-[11px] text-zinc-700" value={traceSource.path ?? ""} onChange={(event) => { const source = activeExample.sources.find((item) => item.path === event.target.value); if (source) openTraceSource(source); }}>
              {activeExample.sources.map((source) => <option key={source.path} value={source.path}>{source.name}</option>)}
            </select>}
            {!loading && data.length > 0 && data.length <= 12 && <button type="button" className="h-full px-2 text-[11px] text-zinc-600 hover:text-zinc-950" onClick={() => { data.forEach((tracing) => { void loadAgentDag(tracing); }); setSelectedTracingIds(data.map((tracing) => tracing.id)); }}>Compare all {data.length} runs</button>}
          </div>
          {!loading && !error && data.length > 0 && (() => {
            const statuses = data.map((tracing) => (tracing.trainingOutcome as { status?: unknown } | undefined)?.status);
            const success = statuses.filter((status) => status === 'success').length;
            const failure = statuses.filter((status) => status === 'failure').length;
            return success + failure > 0 ? <p className="mb-3 text-xs text-zinc-500">{success} successful · {failure} failed · {data.length - success - failure} unknown outcomes</p> : null;
          })()}
          {!loading && data.some((tracing) => tracing.snapshotRef) && (
            <p className="mb-3 text-xs text-zinc-500">Saved analysis replay · selection, joining and filters run locally without new model calls.</p>
          )}
          <div className="mb-3 flex gap-4 text-xs text-zinc-600">
            {traceSource.path && selectedTracingIds.length > 0 && <a className="underline underline-offset-2" href={traceViewUrl(traceSource, selectedTracingIds, graphViewState?.axis ?? 'semantic', figureScale, graphViewState?.filters)}>Reopen this source and filters</a>}
          </div>
          {!loading && !error && data.length > 0 && data.length <= 12 && <div className="mb-4 flex flex-wrap gap-2" aria-label="Choose runs to compare">
            {data.map((tracing) => {
              const traceId = String(tracing.id);
              const outcome = (tracing.trainingOutcome as { status?: unknown } | undefined)?.status;
              const status = outcome === 'success' ? 'Successful' : outcome === 'failure' ? 'Failed' : null;
              const score = isScoringValue(tracing.score) ? `Score ${Number(tracing.score).toFixed(3)}` : 'Outcome unknown';
              const selected = selectedTracingIds.includes(tracing.id);
              return <button key={traceId} type="button" aria-pressed={selected} title={traceId} onClick={() => handleTracingSelect(tracing.id)} className={`rounded-lg border px-3 py-2 text-left text-xs transition ${selected ? 'border-sky-500 bg-sky-50' : 'border-zinc-300 bg-white hover:border-zinc-400'}`}>
                <span className="block font-medium">Run {data.indexOf(tracing) + 1}</span>
                <span className="text-zinc-500">{status ?? score}</span>
              </button>;
            })}
          </div>}
          {loading && <StatusMessage message="Loading traces…" />}
          {!loading && error && <StatusMessage message={error} />}
          {!loading && !error && data.length === 0 && (
            <StatusMessage message="No traces available." />
          )}
          {!loading && !error && data.length > 0 && (
            <details className="mb-4 rounded-lg border border-zinc-200 bg-white" open={data.length > 12 || toolMatrixOpen} onToggle={(event) => { const isOpen = event.currentTarget.open; setToolMatrixOpen(isOpen); if (isOpen) setToolMatrixEpoch((epoch) => epoch + 1); }}>
              <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs font-medium text-zinc-700">Tool usage and scores <span className="font-normal text-zinc-500">{data.length} runs</span></summary>
              <div className="border-t border-zinc-200 p-2">
            <div className="mb-2"><UpsetTopChartToggle mode={topChartMode} onChange={setTopChartMode} /></div>
            <div className="w-full overflow-x-auto">
              <div className="relative min-w-[720px] pt-4">
                  <div className="pointer-events-none absolute inset-x-0 top-63 z-10 grid w-full grid-cols-[minmax(0,1fr)_280px]">
                    <div />
                    <div className="pointer-events-auto flex h-14 flex-col border border-zinc-300 bg-zinc-50/95 backdrop-blur-sm">
                      <div className="flex h-7 items-center">
                        <UpsetGroupBySelect
                          value={upsetGroupBy}
                          options={groupingOptions}
                          onChange={setUpsetGroupBy}
                        />
                        <UpsetFoldActions
                          disabled={!upsetGroupBy}
                          onFoldAll={() => setCollapsedGroups(groupingValues)}
                          onExpandAll={() => setCollapsedGroups([])}
                        />
                      </div>
                      <div className="flex h-7 items-center border-t border-zinc-300">
                        <UpsetScoreBySelect
                          value={selectedScoreBy}
                          options={scoringOptions}
                          onChange={setUpsetScoreBy}
                        />
                      </div>
                    </div>
                  </div>
                <div ref={upsetRef} className="w-full" />
              </div>
            </div>
              </div>
            </details>
          )}
        </Card>

        <Card
          title="Provenance graph"
          description={
            selectedTracings.length === 1
              ? `Semantic overview for run #${selectedTracing?.id}.`
              : selectedTracings.length >= 2
              ? (
                  <span className="inline-flex flex-wrap items-center gap-x-1 gap-y-1">
                    <span>Joined graph for</span>
                    {selectedTracings.map((tracing, index) => {
                      const traceId = String(tracing.id);
                      const active = highlightedJoinedTraceId === traceId;
                      const pinned = pinnedJoinedTraceId === traceId;
                      const accent = traceSelectionAccent(index);

                      return (
                        <span key={traceId} className="inline-flex items-center gap-1">
                          <span>{index === 0 ? "" : ", "}</span>
                          <button
                            type="button"
                            aria-label={`Highlight run ${traceId}`}
                            aria-pressed={pinned}
                            title={`Run ${traceId} · hover to preview; click to pin`}
                            className="inline-flex items-center rounded-full border bg-white px-2 py-0.5 font-mono text-[11px] leading-none text-zinc-700 shadow-sm transition hover:text-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
                            style={{
                              background: active
                                ? traceSelectionColor(index)
                                : undefined,
                              borderColor: accent,
                              boxShadow: pinned
                                ? `0 0 0 1px ${accent}`
                                : undefined,
                            }}
                            onMouseEnter={() => setHoveredJoinedTraceId(traceId)}
                            onMouseLeave={() => setHoveredJoinedTraceId(null)}
                            onFocus={() => setHoveredJoinedTraceId(traceId)}
                            onBlur={() => setHoveredJoinedTraceId(null)}
                            onClick={() =>
                              setPinnedJoinedTraceId((current) =>
                                current === traceId ? null : traceId
                              )
                            }
                          >
                            {`Run ${selectedTracings.indexOf(tracing) + 1}`}{((tracing.trainingOutcome as { status?: unknown } | undefined)?.status === 'success' || (tracing.trainingOutcome as { status?: unknown } | undefined)?.status === 'failure') ? ` · ${(tracing.trainingOutcome as { status: string }).status === 'success' ? 'Successful' : 'Failed'}` : ''}
                          </button>
                        </span>
                      );
                    })}
                    <span>.</span>
                  </span>
                )
              : selectedTracing
                ? `Run #${selectedTracing.id}`
                : "Choose runs above to compare their workflows."
          }
          actions={selectedTracings.length > 0 ? (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {selectedTracings.some((trace) => trace.eventSchemaVersion || trace.toolCalls.some((call) => call.agentId || call.role)) ? <select aria-label="Group workflow lanes" className="h-7 rounded border border-zinc-300 px-2 text-[11px] text-zinc-700" value={laneBy} onChange={(event) => setLaneBy(event.target.value as 'agent' | 'role')}><option value="agent">Lanes by agent</option><option value="role">Lanes by role</option></select> : <details className="relative text-[11px] text-zinc-600"><summary className="cursor-pointer rounded border border-zinc-300 px-2 py-1.5">Regrouping options</summary><div className="absolute right-0 top-9 z-30 w-72 rounded-lg border border-zinc-300 bg-white p-3 shadow-lg"><p className="mb-2">Change semantic grouping. This may use AI; use search below to locate steps in the current graph.</p><div className="flex items-center gap-2">
              <input
                aria-label="Focus semantic analysis"
                className="h-7 w-36 rounded border border-zinc-300 px-2 text-[11px]"
                placeholder="Focus analysis…"
                value={focusDraft}
                onChange={(event) => setFocusDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") setFocus(focusDraft.trim()); }}
              />
              <button type="button" className="h-7 rounded border border-zinc-300 px-2 text-[11px] text-zinc-700 hover:bg-zinc-100" onClick={() => setFocus(focusDraft.trim())}>Apply</button>
              </div></div></details>}
              <select aria-label="Target tool call" className="h-7 max-w-48 rounded border border-zinc-300 px-2 text-[11px] text-zinc-700" value={targetCallSelection} onChange={(event) => setTargetCallSelection(event.target.value)}>
                <option value="">{selectedTracings.some((trace) => trace.eventSchemaVersion) ? 'Final result' : 'Any target'}</option>
                {targetCallOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <div className="inline-flex h-7 items-center border border-zinc-300 bg-zinc-50/95">
                {(["overview", "all"] as const).map((detail) => (
                  <button
                    key={detail}
                    type="button"
                    aria-pressed={comparisonDetail === detail}
                    className={`h-full px-2 text-[11px] font-medium transition ${
                      comparisonDetail === detail
                        ? "bg-white text-zinc-950 shadow-sm"
                        : "text-zinc-500 hover:text-zinc-950"
                    }`}
                    style={detail === "all" ? { borderLeft: "1px solid rgb(212 212 216)" } : undefined}
                    onClick={() => setComparisonDetail(detail)}
                  >
                    {detail === "overview" ? "Overview" : selectedTracings.some((trace) => trace.eventSchemaVersion) ? "Full history" : "All groups"}
                  </button>
                ))}
              </div>
            </div>
          ) : undefined}
        >
          {loading && <StatusMessage message="Loading traces…" />}
          {!loading && error && <StatusMessage message={error} />}
          {!loading && !error && data.length === 0 && (
            <StatusMessage message="No traces available." />
          )}
          {!loading && !error && data.length > 0 && selectedTracings.length === 0 && (
            <StatusMessage message="Select a trace to build its semantic overview, or select more traces to compare them." />
          )}
          {!loading && !error && selectedTracings.length >= 1 && (
            joinedGraphState.status === "ready" &&
            joinedGraphState.key === selectedJoinKey ? (
              <SemanticGraphView
                publication={figureScale > 1}
                graph={joinedGraphState.graph}
                traces={selectedTracings}
                traceDags={selectedTraceDags}
                highlightTraceId={highlightedJoinedTraceId ?? undefined}
                workspace={graphWorkspace}
                commands={graphCommands}
                onViewStateChange={setGraphViewState}
              />
            ) : (
              <StatusMessage
                message={
                  joinedGraphState.status === "error" &&
                  joinedGraphState.key === selectedJoinKey
                    ? joinedGraphState.message
                    : selectedTracings.length === 1
                      ? "Building semantic overview…"
                      : "Building semantic comparison…"
                }
              />
            )
          )}
        </Card>
      </main>

      <ProvenanceCopilot
        selectedTraces={selectedTracings}
        selectedTraceDags={selectedTraceDags}
        joinedGraph={activeJoinedGraph}
        graphState={activeJoinedGraph && graphViewState?.scope === activeGraphScope ? graphViewState : null}
        onGraphAction={(action) => setGraphCommands((current) => [...current.slice(-31), { nonce: (current.at(-1)?.nonce ?? 0) + 1, action }])}
        graphMode={graphMode}
      />
    </div>
  );
}
