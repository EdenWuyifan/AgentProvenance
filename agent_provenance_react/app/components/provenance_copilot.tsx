"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  ProvenanceCopilotAgent,
  type CopilotHistoryMessage,
  type CopilotStreamEvent,
} from "./provenance_copilot_agent";
import type { AgentDag, GraphMode, JoinedProvenanceGraph, Tracing } from "./types";

type ProvenanceCopilotProps = {
  selectedTraces: Tracing[];
  selectedTraceDags: Record<string, AgentDag>;
  joinedGraph: JoinedProvenanceGraph | null;
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

type CopilotStep = {
  id: string;
  name: string;
  status: "running" | "done";
  args?: unknown;
  result?: unknown;
};

type CopilotMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  steps?: CopilotStep[];
  error?: string;
};

const DEFAULT_PANEL_SIZE = {
  width: 540,
  height: 320,
} as const;
const MIN_PANEL_WIDTH = 360;
const MIN_PANEL_HEIGHT = 220;
const MINIMIZED_PANEL_WIDTH = 280;
const HISTORY_STORAGE_KEY = "agent-provenance-copilot-history-v1";
const MAX_MEMORY_MESSAGES = 12;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function formatScore(score: Tracing["score"]) {
  return typeof score === "number" ? score.toFixed(2) : null;
}

function newId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatDetail(value: unknown) {
  if (value == null || value === "") {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function memoryMessages(messages: CopilotMessage[]): CopilotHistoryMessage[] {
  return messages
    .filter((message) => message.content.trim())
    .slice(-MAX_MEMORY_MESSAGES)
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }));
}

function formatInlineMath(value: string) {
  return value
    .replaceAll("\\rightarrow", "->")
    .replaceAll("\\leftarrow", "<-")
    .replaceAll("\\geq", ">=")
    .replaceAll("\\leq", "<=");
}

function renderInlineMarkdown(text: string) {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`|\$[^$]+\$)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      }

      if (part.startsWith("`") && part.endsWith("`")) {
        return (
          <code
            key={index}
            className="rounded bg-slate-200/80 px-1 py-0.5 text-[0.88em] text-slate-800"
          >
            {part.slice(1, -1)}
          </code>
        );
      }

      if (part.startsWith("$") && part.endsWith("$")) {
        return <span key={index}>{formatInlineMath(part.slice(1, -1))}</span>;
      }

      return <span key={index}>{part}</span>;
    });
}

function MarkdownContent({ content }: { content: string }) {
  const lines = content.split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      blocks.push(<div key={index} className="h-2" />);
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      blocks.push(
        <pre
          key={`code-${index}`}
          className="my-2 max-h-64 overflow-auto rounded-lg bg-slate-950 px-3 py-2 text-[11px] leading-5 text-slate-100"
        >
          <code>{code.join("\n")}</code>
        </pre>
      );
      index += 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const className =
        heading[1].length <= 2
          ? "mt-3 mb-1 text-base font-semibold text-slate-900"
          : "mt-3 mb-1 text-sm font-semibold text-slate-900";
      blocks.push(
        <div key={index} className={className}>
          {renderInlineMarkdown(heading[2])}
        </div>
      );
      index += 1;
      continue;
    }

    const ordered = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (ordered) {
      blocks.push(
        <div
          key={index}
          className="my-1 flex gap-2"
          style={{ marginLeft: Math.min(ordered[1].length, 8) * 4 }}
        >
          <span className="w-5 shrink-0 text-right text-slate-400">
            {ordered[2]}.
          </span>
          <span>{renderInlineMarkdown(ordered[3])}</span>
        </div>
      );
      index += 1;
      continue;
    }

    const bullet = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (bullet) {
      blocks.push(
        <div
          key={index}
          className="my-1 flex gap-2"
          style={{ marginLeft: Math.min(bullet[1].length, 8) * 4 }}
        >
          <span className="text-slate-400">•</span>
          <span>{renderInlineMarkdown(bullet[2])}</span>
        </div>
      );
      index += 1;
      continue;
    }

    blocks.push(
      <p key={index} className="my-1">
        {renderInlineMarkdown(line)}
      </p>
    );
    index += 1;
  }

  return <div className="space-y-0.5">{blocks}</div>;
}

export function ProvenanceCopilot({
  selectedTraces,
  selectedTraceDags,
  joinedGraph,
  graphMode,
}: ProvenanceCopilotProps) {
  const agent = useMemo(() => new ProvenanceCopilotAgent(), []);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const resizeStateRef = useRef<ResizeState | null>(null);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [minimized, setMinimized] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const [size, setSize] = useState<PanelSize>(DEFAULT_PANEL_SIZE);
  const visibleTraces = selectedTraces.slice(0, 4);
  const hiddenTraceCount = Math.max(selectedTraces.length - visibleTraces.length, 0);

  useEffect(() => {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) {
      setHistoryLoaded(true);
      return;
    }

    const history = JSON.parse(raw) as CopilotHistoryMessage[];
    setMessages(
      history
        .filter(
          (message) =>
            (message.role === "user" || message.role === "assistant") &&
            typeof message.content === "string" &&
            message.content.trim()
        )
        .map((message) => ({
          id: newId(message.role),
          role: message.role,
          content: message.content,
        }))
    );
    setHistoryLoaded(true);
  }, []);

  useEffect(() => {
    if (!historyLoaded) {
      return;
    }

    const history = memoryMessages(messages);
    if (history.length === 0) {
      window.localStorage.removeItem(HISTORY_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  }, [historyLoaded, messages]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) {
      transcript.scrollTop = transcript.scrollHeight;
    }
  }, [messages, loading]);

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

  function updateAssistantMessage(
    assistantId: string,
    update: (message: CopilotMessage) => CopilotMessage
  ) {
    setMessages((current) =>
      current.map((message) =>
        message.id === assistantId ? update(message) : message
      )
    );
  }

  function appendOrUpdateStep(
    steps: CopilotStep[] = [],
    nextStep: CopilotStep
  ) {
    const index = steps.findIndex((step) => step.id === nextStep.id);
    if (index === -1) {
      return [...steps, nextStep];
    }

    return steps.map((step, stepIndex) =>
      stepIndex === index ? { ...step, ...nextStep } : step
    );
  }

  function applyStreamEvent(assistantId: string, streamEvent: CopilotStreamEvent) {
    updateAssistantMessage(assistantId, (message) => {
      if (streamEvent.type === "message_delta") {
        return { ...message, content: message.content + streamEvent.delta };
      }

      if (streamEvent.type === "thinking_delta") {
        return {
          ...message,
          thinking: `${message.thinking ?? ""}${streamEvent.delta}`,
        };
      }

      if (streamEvent.type === "tool_call") {
        return {
          ...message,
          steps: appendOrUpdateStep(message.steps, {
            id: streamEvent.id,
            name: streamEvent.name,
            status: "running",
            args: streamEvent.args,
          }),
        };
      }

      if (streamEvent.type === "tool_result") {
        return {
          ...message,
          steps: appendOrUpdateStep(message.steps, {
            id: streamEvent.id,
            name: streamEvent.name ?? "tool",
            status: "done",
            result: streamEvent.result,
          }),
        };
      }

      if (streamEvent.type === "final" && streamEvent.output && !message.content) {
        return { ...message, content: streamEvent.output };
      }

      if (streamEvent.type === "error") {
        return { ...message, error: streamEvent.message };
      }

      return message;
    });
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const prompt = question.trim();
    if (!prompt || selectedTraces.length === 0) {
      return;
    }

    const assistantId = newId("assistant");
    const chatHistory = memoryMessages(messages);
    setLoading(true);
    setQuestion("");
    setMessages((current) => [
      ...current,
      { id: newId("user"), role: "user", content: prompt },
      { id: assistantId, role: "assistant", content: "", steps: [] },
    ]);

    try {
      await agent.run(
        {
          question: prompt,
          chatHistory,
          selectedTraces,
          selectedTraceDags,
          joinedGraph,
          graphMode,
        },
        (streamEvent) => applyStreamEvent(assistantId, streamEvent)
      );
    } catch (requestError) {
      const message =
        requestError instanceof Error
          ? requestError.message
          : "Unable to get an answer.";
      updateAssistantMessage(assistantId, (assistantMessage) => ({
        ...assistantMessage,
        error: message,
      }));
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
          {messages.length > 0 && (
            <button
              type="button"
              className="rounded-full px-2 py-0.5 font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:cursor-default disabled:text-slate-300"
              onClick={() => {
                setMessages([]);
                window.localStorage.removeItem(HISTORY_STORAGE_KEY);
              }}
              onPointerDown={(event) => event.stopPropagation()}
              disabled={loading}
            >
              Clear
            </button>
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
              ref={transcriptRef}
              className="min-h-0 flex-1 overflow-auto rounded-[18px] border border-slate-200/80 bg-white/70 px-3 py-3 text-sm leading-6 text-slate-700"
              aria-live="polite"
            >
              {messages.length === 0 ? (
                <div className="text-sm text-slate-500">
                  {selectedTraces.length === 0
                    ? "Select traces first, then ask a grounded question."
                    : "Ask about tool use, provenance patterns, or differences across the selected traces."}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {messages.map((message) => {
                    const isUser = message.role === "user";

                    return (
                      <div
                        key={message.id}
                        className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`max-w-[88%] rounded-2xl px-3 py-2 ${
                            isUser
                              ? "whitespace-pre-wrap bg-slate-900 text-white"
                              : "bg-slate-100/90 text-slate-700"
                          }`}
                        >
                          {!isUser && (
                            <div className="mb-1 flex flex-col gap-1 text-[11px] leading-5 text-slate-500">
                              {message.thinking && (
                                <details className="rounded-lg bg-white/70 px-2 py-1">
                                  <summary className="cursor-pointer font-medium text-slate-600">
                                    Thinking
                                  </summary>
                                  <div className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap text-slate-500">
                                    {message.thinking}
                                  </div>
                                </details>
                              )}

                              {message.steps?.map((step) => {
                                const args = formatDetail(step.args);
                                const result = formatDetail(step.result);

                                return (
                                  <details
                                    key={step.id}
                                    className="rounded-lg bg-white/70 px-2 py-1"
                                  >
                                    <summary className="cursor-pointer font-medium text-slate-600">
                                      {step.status === "done" ? "Called" : "Calling"}{" "}
                                      {step.name}
                                    </summary>
                                    {(args || result) && (
                                      <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-4 text-slate-500">
                                        {args ? `args\n${args}` : ""}
                                        {args && result ? "\n\n" : ""}
                                        {result ? `result\n${result}` : ""}
                                      </pre>
                                    )}
                                  </details>
                                );
                              })}

                              {!message.content &&
                                !message.error &&
                                loading &&
                                message.id === messages[messages.length - 1]?.id && (
                                  <span className="px-1 text-slate-500">
                                    Thinking...
                                  </span>
                                )}
                            </div>
                          )}

                          {message.error ? (
                            <span className="text-red-700">{message.error}</span>
                          ) : isUser ? (
                            message.content
                          ) : message.content ? (
                            <MarkdownContent content={message.content} />
                          ) : (
                            null
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
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
              className="pointer-events-auto absolute left-3 right-3 top-0 h-3 -translate-y-1/2 cursor-ns-resize"
              onPointerDown={handleResizeStart("n")}
            />
            <div
              className="pointer-events-auto absolute bottom-0 left-3 right-3 h-3 translate-y-1/2 cursor-ns-resize"
              onPointerDown={handleResizeStart("s")}
            />
            <div
              className="pointer-events-auto absolute bottom-3 right-0 top-3 w-3 translate-x-1/2 cursor-ew-resize"
              onPointerDown={handleResizeStart("e")}
            />
            <div
              className="pointer-events-auto absolute bottom-3 left-0 top-3 w-3 -translate-x-1/2 cursor-ew-resize"
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
              className="pointer-events-auto absolute bottom-1 right-1 h-5 w-5 cursor-nwse-resize opacity-60 transition hover:opacity-100"
              onPointerDown={handleResizeStart("se")}
              aria-label="Resize copilot"
            >
              <span className="absolute bottom-1 right-1 h-2 w-2 border-b border-r border-slate-400" />
              <span className="absolute bottom-1 right-1 h-3.5 w-3.5 border-b border-r border-slate-300" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
