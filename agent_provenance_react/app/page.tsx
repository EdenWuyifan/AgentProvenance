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

import {
  AgentDagGraphView,
  JoinedProvenanceGraphView,
  ProvenanceGraphView,
} from "./components/provenance_graph";
import { ProvenanceCopilot } from "./components/provenance_copilot";
import type {
  AgentDag,
  GraphMode,
  JoinedProvenanceGraph,
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
]);
const TRACE_SELECTION_COLORS = [
  "rgba(56, 189, 248, 0.18)",
  "rgba(251, 146, 60, 0.18)",
  "rgba(74, 222, 128, 0.18)",
] as const;

function traceSelectionColor(index: number) {
  const color = TRACE_SELECTION_COLORS[index];
  if (color) {
    return color;
  }

  const hue = (index * 137.508) % 360;
  return `hsl(${hue} 86% 90% / 0.42)`;
}

type TopChartMode = "usage" | "impact";
type BottomGraphView = "trace" | "agent";
type AgentDagState =
  | { status: "loading" }
  | { status: "ready"; dag: AgentDag }
  | { status: "error" };
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

function normalizeTracing(
  tracing: Record<string, unknown> & { id: Tracing["id"]; score?: unknown }
): Tracing {
  return {
    ...Object.fromEntries(
      Object.entries(tracing).filter(([key]) => !GROUPING_EXCLUDED_KEYS.has(key))
    ),
    id: tracing.id,
    score:
      typeof tracing.score === "number" || tracing.score === null
        ? tracing.score
        : undefined,
    toolCalls: extractToolCallRecords(tracing),
  };
}

function useTracingData(path: string) {
  const [data, setData] = useState<Tracing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch(path);
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const text = await response.text();
        if (cancelled) {
          return;
        }

        const parsed = prepareTracings(parseTracingPayload(text)).map(normalizeTracing);
        startTransition(() => {
          setData(parsed);
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
          setError(message);
          setLoading(false);
        });
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [path]);

  return { data, loading, error };
}

function Card({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: string;
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
          <p className="mt-1 max-w-3xl text-sm text-zinc-600">{description}</p>
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

function GraphModeToggle({
  mode,
  onChange,
}: {
  mode: GraphMode;
  onChange: (mode: GraphMode) => void;
}) {
  return (
    <div className="inline-flex h-7 items-center border border-zinc-300 bg-zinc-50/95 backdrop-blur-sm">
      {[
        ["collapsed", "Collapsed"],
        ["tree", "Tree"],
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
            style={
              value === "tree"
                ? { borderLeft: "1px solid rgb(212 212 216)" }
                : undefined
            }
            onClick={() => onChange(value as GraphMode)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function BottomGraphViewToggle({
  view,
  agentDisabled,
  agentLoading,
  onChange,
}: {
  view: BottomGraphView;
  agentDisabled: boolean;
  agentLoading: boolean;
  onChange: (view: BottomGraphView) => void;
}) {
  return (
    <div className="inline-flex h-7 items-center border border-zinc-300 bg-zinc-50/95 backdrop-blur-sm">
      <button
        type="button"
        className={`h-full px-2 text-[11px] font-medium transition ${
          view === "trace"
            ? "bg-white text-zinc-950 shadow-sm"
            : "text-zinc-500 hover:text-zinc-950"
        }`}
        onClick={() => onChange("trace")}
      >
        Trace
      </button>
      <button
        type="button"
        className={`h-full border-l border-zinc-300 px-2 text-[11px] font-medium transition ${
          view === "agent"
            ? "bg-white text-zinc-950 shadow-sm"
            : "text-zinc-500 hover:text-zinc-950"
        } disabled:cursor-default disabled:bg-zinc-100 disabled:text-zinc-300`}
        onClick={() => onChange("agent")}
        disabled={agentDisabled}
      >
        {agentLoading ? "Building PROV" : "PROV graph"}
      </button>
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
    <label className="inline-flex h-full items-center text-[11px] text-zinc-600">
      <span className="border-r border-zinc-300 px-2">Group rows</span>
      <select
        className="h-full border-0 bg-transparent px-2 text-[11px] text-zinc-950 outline-none"
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
    <div className="inline-flex h-full items-center text-[11px]">
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

export default function Home() {
  const upsetRef = useRef<HTMLDivElement | null>(null);
  const [selectedTracingIds, setSelectedTracingIds] = useState<Array<Tracing["id"]>>([]);
  const [topChartMode, setTopChartMode] = useState<TopChartMode>("impact");
  const [upsetGroupBy, setUpsetGroupBy] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [graphMode, setGraphMode] = useState<GraphMode>("tree");
  const [bottomGraphView, setBottomGraphView] = useState<BottomGraphView>("trace");
  const [agentDagStates, setAgentDagStates] = useState<
    Record<string, AgentDagState>
  >({});
  const [joinedGraphState, setJoinedGraphState] = useState<JoinedGraphState>({
    status: "idle",
  });
  const agentDagStatesRef = useRef<Record<string, AgentDagState>>({});

  const { data, loading, error } = useTracingData("/tracings.jsonl");
  const groupingOptions = getGroupingOptions(data);
  const groupingValues = getGroupingValues(data, upsetGroupBy);
  const selectedTracings = selectedTracingIds
    .map((selectedTracingId) =>
      data.find((tracing) => tracing.id === selectedTracingId) ?? null
    )
    .filter((tracing): tracing is Tracing => tracing !== null);
  const selectedTracing = selectedTracings[0] ?? null;
  const selectedAgentDagState = selectedTracing
    ? agentDagStates[String(selectedTracing.id)]
    : undefined;
  const agentDagReady = selectedAgentDagState?.status === "ready";
  const agentDagLoading = selectedAgentDagState?.status === "loading";
  const selectedJoinKey = selectedTracingIds.map(String).join(":");
  const selectedDagStates = selectedTracings.map(
    (tracing) => agentDagStates[String(tracing.id)]
  );
  const selectedDagsReady =
    selectedTracings.length >= 2 &&
    selectedDagStates.every((state) => state?.status === "ready");
  const selectedDagsError =
    selectedTracings.length >= 2 &&
    selectedDagStates.some((state) => state?.status === "error");
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

  const setAgentDagState = useCallback((traceId: Tracing["id"], state: AgentDagState) => {
    agentDagStatesRef.current = {
      ...agentDagStatesRef.current,
      [String(traceId)]: state,
    };
    setAgentDagStates(agentDagStatesRef.current);
  }, []);

  const loadAgentDag = useCallback(async (tracing: Tracing) => {
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
          toolCalls: tracing.toolCalls,
        }),
      });

      if (!response.ok) {
        throw new Error((await response.text()) || "Unable to build PROV graph.");
      }

      const payload = (await response.json()) as {
        dag: AgentDag;
      };

      setAgentDagState(tracing.id, {
        status: "ready",
        dag: payload.dag,
      });
    } catch {
      setAgentDagState(tracing.id, { status: "error" });
    }
  }, [setAgentDagState]);

  const handleTracingSelect = useCallback((tracingId: Tracing["id"]) => {
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
    if (selectedTracingIds.length < 2) {
      setJoinedGraphState({ status: "idle" });
      return;
    }

    if (selectedDagsError) {
      setJoinedGraphState({
        status: "error",
        key: selectedJoinKey,
        message: "Unable to build one of the selected PROV graphs.",
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
                score: tracing.score,
                dag: state.dag,
                toolCalls: tracing.toolCalls,
              }]
            : [];
        });
        const response = await fetch("/api/joined-provenance-graph", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ graphs }),
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
    selectedTracingIds,
  ]);

  useEffect(() => {
    const element = upsetRef.current;
    if (!element || loading || error || data.length === 0) {
      return;
    }

    let currentWidth = Math.max(Math.floor(element.getBoundingClientRect().width), 720);
    const render = (width = currentWidth) => {
      renderUpsetPlot(element, data, {}, {
        width,
        matrixMaxHeight: 360,
        topChartMode,
        rowGroupBy: upsetGroupBy || undefined,
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
    handleGroupSelect,
    handleTracingSelect,
    loading,
    selectedTracingColors,
    topChartMode,
    upsetGroupBy,
  ]);

  return (
    <div className="min-h-screen bg-stone-100 px-4 py-10 text-zinc-950">
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="px-1">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-zinc-500">
            AgentProvenance
          </p>
        </header>

        <Card
          title="Tracings provenance"
          description="Click up to 3 runs to inspect one PROV graph or join multiple PROV graphs on a shared canvas."
        >
          {loading && <StatusMessage message="Loading traces…" />}
          {!loading && error && <StatusMessage message={error} />}
          {!loading && !error && data.length === 0 && (
            <StatusMessage message="No traces available." />
          )}
          {!loading && !error && data.length > 0 && (
            <div className="w-full overflow-x-auto">
              <div className="relative min-w-[720px] pt-16">
                  <div className="pointer-events-none absolute inset-x-0 top-0 z-10 grid w-full grid-cols-[3fr_1fr]">
                    <div className="pointer-events-auto flex h-7 items-center border border-zinc-300 bg-zinc-50/95 backdrop-blur-sm">
                      <UpsetTopChartToggle
                        mode={topChartMode}
                        onChange={setTopChartMode}
                      />
                      <div className="h-full flex-1 border-l border-zinc-300" />
                    </div>
                  </div>
                  <div className="pointer-events-none absolute inset-x-0 top-63 z-10 grid w-full grid-cols-[3fr_1fr]">
                    <div />
                    <div className="pointer-events-auto flex h-14 flex-col border border-zinc-300 bg-zinc-50/95 backdrop-blur-sm">
                      <div className="flex h-7 items-center">
                        <UpsetGroupBySelect
                          value={upsetGroupBy}
                          options={groupingOptions}
                          onChange={setUpsetGroupBy}
                        />
                        <div className="h-full flex-1 border-l border-zinc-300" />
                      </div>
                      <div className="flex h-7 items-center border-t border-zinc-300">
                        <UpsetFoldActions
                          disabled={!upsetGroupBy}
                          onFoldAll={() => setCollapsedGroups(groupingValues)}
                          onExpandAll={() => setCollapsedGroups([])}
                        />
                        <div className="h-full flex-1 border-l border-zinc-300" />
                      </div>
                    </div>
                  </div>
                <div ref={upsetRef} className="w-full" />
              </div>
            </div>
          )}
        </Card>

        <Card
          title="Provenance graph"
          description={
            selectedTracings.length >= 2
              ? `Joined graph for ${selectedTracings
                  .map((tracing) => `run #${tracing.id}`)
                  .join(", ")}.`
              : selectedTracing
                ? `Run #${selectedTracing.id}`
                : "Select up to 3 runs from the plot."
          }
          actions={
            selectedTracings.length === 1 ? (
              <div className="flex flex-wrap items-center gap-2">
                <BottomGraphViewToggle
                  view={agentDagReady ? bottomGraphView : "trace"}
                  agentDisabled={!agentDagReady}
                  agentLoading={agentDagLoading}
                  onChange={setBottomGraphView}
                />
                {bottomGraphView === "trace" || !agentDagReady ? (
                  <GraphModeToggle mode={graphMode} onChange={setGraphMode} />
                ) : null}
              </div>
            ) : undefined
          }
        >
          {loading && <StatusMessage message="Loading traces…" />}
          {!loading && error && <StatusMessage message={error} />}
          {!loading && !error && data.length === 0 && (
            <StatusMessage message="No traces available." />
          )}
          {!loading && !error && data.length > 0 && selectedTracings.length === 0 && (
            <StatusMessage message="Select up to 3 traces in the matrix to render a provenance graph or comparison." />
          )}
          {!loading && !error && selectedTracings.length === 1 && selectedTracing && (
            bottomGraphView === "agent" && agentDagReady ? (
              <AgentDagGraphView dag={selectedAgentDagState.dag} />
            ) : (
              <ProvenanceGraphView tracing={selectedTracing} mode={graphMode} />
            )
          )}
          {!loading && !error && selectedTracings.length >= 2 && (
            joinedGraphState.status === "ready" &&
            joinedGraphState.key === selectedJoinKey ? (
              <JoinedProvenanceGraphView
                graph={joinedGraphState.graph}
                traceIds={selectedTracingIds}
              />
            ) : (
              <StatusMessage
                message={
                  joinedGraphState.status === "error" &&
                  joinedGraphState.key === selectedJoinKey
                    ? joinedGraphState.message
                    : "Building joined PROV graph…"
                }
              />
            )
          )}
        </Card>
      </main>

      <ProvenanceCopilot
        selectedTraces={selectedTracings}
        graphMode={graphMode}
      />
    </div>
  );
}
