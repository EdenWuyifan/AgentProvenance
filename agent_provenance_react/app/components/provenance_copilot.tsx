"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { ProvenanceCopilotAgent } from "./provenance_copilot_agent";
import type { GraphMode, Tracing } from "./types";

type ProvenanceCopilotProps = {
  selectedTraces: Tracing[];
  graphMode: GraphMode;
};

type PanelPosition = {
  x: number;
  y: number;
};

type PanelSize = {
  width: number;
  height: number;
};

type DragState = {
  offsetX: number;
  offsetY: number;
  pointerId: number;
};

type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type ResizeState = {
  direction: ResizeDirection;
  startX: number;
  startY: number;
  startLeft: number;
  startTop: number;
  startWidth: number;
  startHeight: number;
  pointerId: number;
};

const DEFAULT_PANEL_SIZE = {
  width: 540,
  height: 320,
} as const;
const MIN_PANEL_WIDTH = 360;
const MIN_PANEL_HEIGHT = 220;
const MINIMIZED_PANEL_WIDTH = 280;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function formatScore(score: Tracing["score"]) {
  return typeof score === "number" ? score.toFixed(2) : null;
}

export function ProvenanceCopilot({
  selectedTraces,
  graphMode,
}: ProvenanceCopilotProps) {
  const agent = useMemo(() => new ProvenanceCopilotAgent(), []);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const resizeStateRef = useRef<ResizeState | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [minimized, setMinimized] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const [size, setSize] = useState<PanelSize>(DEFAULT_PANEL_SIZE);
  const visibleTraces = selectedTraces.slice(0, 4);
  const hiddenTraceCount = Math.max(selectedTraces.length - visibleTraces.length, 0);

  useEffect(() => {
    if (!dragging && !resizing) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      const panel = panelRef.current;

      if (dragState && panel && event.pointerId === dragState.pointerId) {
        const nextX = event.clientX - dragState.offsetX;
        const nextY = event.clientY - dragState.offsetY;
        const maxX = Math.max(window.innerWidth - panel.offsetWidth - 12, 12);
        const maxY = Math.max(window.innerHeight - panel.offsetHeight - 12, 12);

        setPosition({
          x: Math.min(Math.max(nextX, 12), maxX),
          y: Math.min(Math.max(nextY, 12), maxY),
        });

        return;
      }

      const resizeState = resizeStateRef.current;

      if (!resizeState || event.pointerId !== resizeState.pointerId) {
        return;
      }

      const right = resizeState.startLeft + resizeState.startWidth;
      const bottom = resizeState.startTop + resizeState.startHeight;
      const deltaX = event.clientX - resizeState.startX;
      const deltaY = event.clientY - resizeState.startY;

      let nextX = resizeState.startLeft;
      let nextY = resizeState.startTop;
      let nextWidth = resizeState.startWidth;
      let nextHeight = resizeState.startHeight;

      if (resizeState.direction.includes("e")) {
        nextWidth = clamp(
          resizeState.startWidth + deltaX,
          MIN_PANEL_WIDTH,
          window.innerWidth - resizeState.startLeft - 12
        );
      }

      if (resizeState.direction.includes("s")) {
        nextHeight = clamp(
          resizeState.startHeight + deltaY,
          MIN_PANEL_HEIGHT,
          window.innerHeight - resizeState.startTop - 12
        );
      }

      if (resizeState.direction.includes("w")) {
        nextX = clamp(
          resizeState.startLeft + deltaX,
          12,
          right - MIN_PANEL_WIDTH
        );
        nextWidth = right - nextX;
      }

      if (resizeState.direction.includes("n")) {
        nextY = clamp(
          resizeState.startTop + deltaY,
          12,
          bottom - MIN_PANEL_HEIGHT
        );
        nextHeight = bottom - nextY;
      }

      setPosition({
        x: nextX,
        y: nextY,
      });
      setSize({ width: nextWidth, height: nextHeight });
    };

    const handlePointerEnd = (event: PointerEvent) => {
      if (dragStateRef.current?.pointerId === event.pointerId) {
        dragStateRef.current = null;
        setDragging(false);
      }

      if (resizeStateRef.current?.pointerId === event.pointerId) {
        resizeStateRef.current = null;
        setResizing(false);
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [dragging, resizing]);

  function handleDragStart(event: React.PointerEvent<HTMLDivElement>) {
    const panel = panelRef.current;

    if (!panel) {
      return;
    }

    const rect = panel.getBoundingClientRect();

    dragStateRef.current = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      pointerId: event.pointerId,
    };

    setPosition({ x: rect.left, y: rect.top });
    setDragging(true);
  }

  function handleResizeStart(direction: ResizeDirection) {
    return (event: React.PointerEvent<HTMLDivElement>) => {
      const panel = panelRef.current;

      if (!panel) {
        return;
      }

      event.stopPropagation();

      const rect = panel.getBoundingClientRect();

      resizeStateRef.current = {
        direction,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: rect.left,
        startTop: rect.top,
        startWidth: rect.width,
        startHeight: rect.height,
        pointerId: event.pointerId,
      };

      setPosition({ x: rect.left, y: rect.top });
      setSize({ width: rect.width, height: rect.height });
      setResizing(true);
    };
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!question.trim() || selectedTraces.length === 0) {
      return;
    }

    setLoading(true);
    setError(null);
    setAnswer("");

    try {
      await agent.run(
        {
          question: question.trim(),
          selectedTraces,
          graphMode,
        },
        setAnswer
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to get an answer."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      ref={panelRef}
      className={`fixed z-50 flex flex-col overflow-hidden rounded-[22px] border border-slate-200/80 bg-white/72 shadow-[0_10px_30px_rgba(15,23,42,0.12)] backdrop-blur-xl ${
        position ? "" : "right-4 top-4"
      }`}
      style={{
        left: position?.x,
        top: position?.y,
        width: minimized ? MINIMIZED_PANEL_WIDTH : size.width,
        height: minimized ? undefined : size.height,
        maxWidth: "calc(100vw - 24px)",
        maxHeight: "calc(100vh - 24px)",
      }}
    >
      <div
        className={`flex h-8 items-center justify-between gap-3 border-b border-slate-200/80 bg-white/45 px-3 text-[11px] text-slate-600 ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        } select-none`}
        onPointerDown={handleDragStart}
      >
        <span className="truncate font-medium text-slate-700">Copilot</span>

        <div className="flex items-center gap-1.5">
          <span
            className={`rounded-full px-2 py-0.5 font-medium ${
              selectedTraces.length === 0
                ? "bg-slate-100 text-slate-500"
                : "bg-emerald-50 text-emerald-700"
            }`}
          >
            {selectedTraces.length} selected
          </span>
          {loading && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-500">
              Streaming
            </span>
          )}
          <button
            type="button"
            className="flex h-5 w-5 items-center justify-center rounded-full text-xs text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            onClick={() => setMinimized((current) => !current)}
            onPointerDown={(event) => event.stopPropagation()}
            aria-label={minimized ? "Expand copilot" : "Minimize copilot"}
          >
            {minimized ? "+" : "-"}
          </button>
        </div>
      </div>

      {!minimized && (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-3">
            <div className="flex flex-wrap gap-1">
              {selectedTraces.length === 0 ? (
                <span className="px-1 text-[11px] text-slate-500">
                  Select traces to ground the answer.
                </span>
              ) : (
                <>
                  {visibleTraces.map((trace) => {
                    const score = formatScore(trace.score);

                    return (
                      <span
                        key={trace.id}
                        className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-600"
                      >
                        {score ? `#${trace.id} · ${score}` : `#${trace.id}`}
                      </span>
                    );
                  })}
                  {hiddenTraceCount > 0 && (
                    <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-500">
                      +{hiddenTraceCount}
                    </span>
                  )}
                </>
              )}
            </div>

            <div
              className={`min-h-0 flex-1 overflow-auto rounded-[18px] border px-3 py-3 text-sm leading-6 whitespace-pre-wrap ${
                error
                  ? "border-red-200 bg-red-50/90 text-red-700"
                  : "border-slate-200/80 bg-white/70 text-slate-700"
              }`}
              aria-live="polite"
            >
              {error
                ? error
                : answer
                  ? answer
                  : loading
                    ? "Waiting for response..."
                    : selectedTraces.length === 0
                      ? "Select traces first, then ask a grounded question."
                      : "Ask about tool use, provenance patterns, or differences across the selected traces."}
            </div>

            <form
              className="flex items-center gap-2 rounded-full border border-slate-200/80 bg-white/88 px-3 py-2 shadow-[0_8px_18px_rgba(15,23,42,0.06)]"
              onSubmit={handleSubmit}
            >
              <input
                id="provenance-copilot-question"
                className="min-w-0 flex-1 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"
                placeholder={
                  selectedTraces.length === 0
                    ? "Select traces to begin"
                    : "Ask Copilot..."
                }
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
              />
              <button
                type="submit"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white transition hover:bg-slate-800 disabled:cursor-default disabled:bg-slate-300"
                disabled={loading || !question.trim() || selectedTraces.length === 0}
                aria-label="Send message to Copilot"
              >
                <svg
                  viewBox="0 0 20 20"
                  fill="none"
                  className="h-4 w-4"
                  aria-hidden="true"
                >
                  <path
                    d="M4.167 10h10.833M10 4.167 15.833 10 10 15.833"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </form>
          </div>

          <div className="pointer-events-none absolute inset-0">
            <div
              className="pointer-events-auto absolute left-3 top-0 right-3 h-2 -translate-y-1/2 cursor-ns-resize"
              onPointerDown={handleResizeStart("n")}
            />
            <div
              className="pointer-events-auto absolute bottom-0 left-3 right-3 h-2 translate-y-1/2 cursor-ns-resize"
              onPointerDown={handleResizeStart("s")}
            />
            <div
              className="pointer-events-auto absolute bottom-3 right-0 top-3 w-2 translate-x-1/2 cursor-ew-resize"
              onPointerDown={handleResizeStart("e")}
            />
            <div
              className="pointer-events-auto absolute bottom-3 left-0 top-3 w-2 -translate-x-1/2 cursor-ew-resize"
              onPointerDown={handleResizeStart("w")}
            />
            <div
              className="pointer-events-auto absolute left-0 top-0 h-3 w-3 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize"
              onPointerDown={handleResizeStart("nw")}
            />
            <div
              className="pointer-events-auto absolute right-0 top-0 h-3 w-3 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize"
              onPointerDown={handleResizeStart("ne")}
            />
            <div
              className="pointer-events-auto absolute bottom-0 left-0 h-3 w-3 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize"
              onPointerDown={handleResizeStart("sw")}
            />
            <div
              className="pointer-events-auto absolute bottom-0 right-0 h-3 w-3 translate-x-1/2 translate-y-1/2 cursor-nwse-resize"
              onPointerDown={handleResizeStart("se")}
            />
          </div>
        </>
      )}
    </div>
  );
}
