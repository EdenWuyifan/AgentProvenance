'use client';

import { useEffect, useState } from 'react';
import {
  Background,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  NodeToolbar,
  Panel,
  Position,
  ReactFlow,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import {
  ToolCallTooltip,
  type ToolCallTooltipDetail,
} from './tool_call_tooltip';
import type {
  AgentDag,
  GraphMode,
  JoinedProvenanceGraph,
  ToolSets,
  ToolCall,
  Tracing,
} from './types';
import { createGlyphSystem } from './visualization_shared';

type ComparisonNodeDetail = ToolCallTooltipDetail;

type GraphNodeData = {
  label: string;
  glyph: string;
  group: string;
  color?: string;
  kind?: 'Activity' | 'Entity' | 'Root' | 'JoinedActivity';
  nodeType?: string;
  provProperties?: Array<{ name: string; value: string | string[] }>;
  traceMembership?: Array<{ id: string; color: string; active: boolean }>;
  details?: ComparisonNodeDetail[];
  tooltipOpen?: boolean;
  onCloseDetails?: () => void;
};

type GraphEdgeData = {
  repeats?: number;
  curveOffset?: number;
  curveDirection?: 1 | -1;
  color?: string;
  strokeWidth?: number;
  opacity?: number;
  strokeDasharray?: string;
};

type GraphNode = Node<GraphNodeData, 'tool'>;
type GraphEdge = Edge<GraphEdgeData, 'repeat' | 'sequential'>;
type GraphNodeProps = NodeProps<GraphNode>;
type GraphEdgeProps = EdgeProps<GraphEdge>;
type GlyphSystem = ReturnType<typeof createGlyphSystem>;
type JoinedFilterMode = 'fade' | 'prune';
type JoinedFilters = {
  mode: JoinedFilterMode;
  minSupport: number;
  minMaxScore: number;
};

const COLLAPSED_LAYOUT = { x: 0, y: 0, gapY: 50 };
const TREE_LAYOUT = { x: 0, y: 0, gapX: 176, gapY: 112 };
const COMPARE_LAYOUT = { x: 0, y: 0, gapX: 176, gapY: 112 };
const AGENT_DAG_LAYOUT = { x: 0, y: 0, gapX: 248, gapY: 128 };
const JOINED_LAYOUT = { x: 0, y: 0, gapX: 230, gapY: 112 };
const EDGE_LAYOUT = {
  curveGap: 28,
  markerEnd: { type: MarkerType.Arrow, width: 24, height: 24 },
};
const TRACE_A_COLORS = {
  edge: '#38bdf8',
  fill: '#e0f2fe',
  border: '#7dd3fc',
};
const TRACE_B_COLORS = {
  edge: '#fb923c',
  fill: '#ffedd5',
  border: '#fdba74',
};
const TRACE_C_COLORS = {
  edge: '#22c55e',
  fill: '#dcfce7',
  border: '#86efac',
};
type TraceColor = typeof TRACE_A_COLORS;
const COMPARISON_TRACE_COLORS: TraceColor[] = [TRACE_A_COLORS, TRACE_B_COLORS, TRACE_C_COLORS];
const DEFAULT_GLYPH_SYSTEM = createGlyphSystem();

const nodeTypes = { tool: ToolNode };
const edgeTypes = { repeat: RepeatEdge, sequential: SequentialEdge };

function EdgeBadge({
  x,
  y,
  label,
}: {
  x: number;
  y: number;
  label: string | number;
}) {
  return (
    <EdgeLabelRenderer>
      <div
        className="edge-badge"
        style={{
          position: 'absolute',
          transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
          pointerEvents: 'all',
        }}
      >
        <span className="edge-badge__label nodrag nopan">{label}</span>
      </div>
    </EdgeLabelRenderer>
  );
}

function ToolNode({
  data,
  sourcePosition = Position.Bottom,
  targetPosition = Position.Top,
}: GraphNodeProps) {
  const color = data.color ?? DEFAULT_GLYPH_SYSTEM.getGroupColor(data.group);
  const title = data.nodeType ? `${data.label} (${data.nodeType})` : data.label;
  const hasTooltip = Boolean(data.details?.length || data.provProperties?.length);
  const traceMembership = data.traceMembership ?? [];
  const hasTraceRing = traceMembership.length > 0;
  const variant =
    data.kind === 'Entity'
      ? 'entity'
      : data.kind === 'Activity' || data.kind === 'JoinedActivity'
        ? 'activity'
        : data.kind === 'Root'
          ? 'root'
        : 'tool';

  return (
    <>
      {hasTooltip ? (
        <NodeToolbar isVisible={data.tooltipOpen} position={Position.Top} offset={8}>
          {data.details?.length ? (
            <ToolCallTooltip
              details={data.details}
              onClose={data.onCloseDetails ?? (() => {})}
            />
          ) : (
            <ProvNodeTooltip
              properties={data.provProperties ?? []}
              onClose={data.onCloseDetails ?? (() => {})}
            />
          )}
        </NodeToolbar>
      ) : null}
      <Handle type="target" position={targetPosition} />
      <div
        className={`provenance-node provenance-node--${variant}`}
        title={title}
        style={
          hasTraceRing
            ? {
                alignItems: 'center',
                background: '#ffffff',
                borderRadius: 9999,
                height: '100%',
                justifyContent: 'center',
                maxWidth: 'none',
                padding: 8,
                textAlign: 'center',
                width: '100%',
              }
            : undefined
        }
      >
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
          {data.kind !== 'Entity' ? (
            <span
              className="provenance-node__glyph"
              style={{ color }}
              aria-hidden="true"
            >
              <ToolGlyph glyph={data.glyph} />
            </span>
          ) : null}
          <span className="provenance-node__label">{data.label}</span>
        </span>
      </div>
      <Handle type="source" position={sourcePosition} />
    </>
  );
}

function ProvNodeTooltip({
  properties,
  onClose,
}: {
  properties: Array<{ name: string; value: string | string[] }>;
  onClose: () => void;
}) {
  const json = Object.fromEntries(
    properties.map((property) => [property.name, property.value])
  );

  return (
    <div
      className="nodrag nopan relative flex h-44 w-64 resize flex-col overflow-hidden rounded-md border border-zinc-200 bg-white shadow-sm"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex h-5 shrink-0 items-center justify-end border-b border-zinc-200 bg-zinc-50 px-1">
        <button
          type="button"
          aria-label="Close details"
          className="nodrag nopan inline-flex h-3.5 w-3.5 items-center justify-center text-zinc-400 transition hover:text-zinc-950"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true">
            <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 py-1.5 pr-4">
        <pre className="whitespace-pre-wrap break-all font-mono text-[9px] leading-tight text-zinc-700">
          {JSON.stringify(json, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function ToolGlyph({ glyph }: { glyph: string }) {
  switch (glyph) {
    case 'cross':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M9 4h6v5h5v6h-5v5H9v-5H4V9h5z" />
        </svg>
      );

    case 'diamond':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <rect x="7" y="7" width="10" height="10" transform="rotate(45 12 12)" />
        </svg>
      );

    case 'square':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <rect x="7" y="7" width="10" height="10" />
        </svg>
      );

    case 'triangle':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M12 5l8 14H4z" />
        </svg>
      );

    case 'star':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M12 3l2.4 5.7 6.1.5-4.6 4 1.4 6-5.3-3.1-5.3 3.1 1.4-6-4.6-4 6.1-.5z" />
        </svg>
      );

    case 'wye':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M10 4h4v6l5.2-3 2 3.5-5.2 3 5.2 3-2 3.5-7.2-4.2-7.2 4.2-2-3.5 5.2-3-5.2-3 2-3.5 5.2 3z" />
        </svg>
      );

    case 'plus':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z" />
        </svg>
      );

    case 'times':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M6.8 4L12 9.2 17.2 4 20 6.8 14.8 12 20 17.2 17.2 20 12 14.8 6.8 20 4 17.2 9.2 12 4 6.8z" />
        </svg>
      );

    default:
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <circle cx="12" cy="12" r="5" />
        </svg>
      );
  }
}

function RepeatEdge(props: GraphEdgeProps) {
  const {
    id,
    source,
    target,
    sourceX,
    sourceY,
    targetX,
    targetY,
    markerEnd,
    data,
  } = props;
  const repeats = data?.repeats;
  const edgeStyle = data?.color
    ? { stroke: data.color, strokeWidth: 2 }
    : undefined;

  let path = '';
  let labelX = (sourceX + targetX) / 2;
  let labelY = (sourceY + targetY) / 2;

  if (source === target) {
    const radiusX = Math.max(Math.abs(sourceX - targetX) * 0.6, 50);
    const radiusY = 50;
    path = `M ${sourceX} ${sourceY} A ${radiusX} ${radiusY} 0 1 0 ${targetX + 2} ${targetY}`;
    labelX = Math.min(sourceX, targetX) + radiusX * 2;
    labelY = Math.max(sourceY, targetY) - radiusY * 0.35;
  } else {
    path = `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={edgeStyle}
      />
      {typeof repeats === 'number' && <EdgeBadge x={labelX} y={labelY} label={repeats} />}
    </>
  );
}

function SequentialEdge(props: GraphEdgeProps) {
  const {
    id,
    source,
    target,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition = Position.Bottom,
    targetPosition = Position.Top,
    markerEnd,
    data,
  } = props;
  const edgeStyle = data?.color
    ? {
        stroke: data.color,
        strokeWidth: data.strokeWidth ?? 2,
        opacity: data.opacity,
        strokeDasharray: data.strokeDasharray,
      }
    : undefined;

  if (source === target) {
    const loopOffset = data?.curveOffset ?? 1;
    const radiusX = 50 + (loopOffset - 1) * 12;
    const radiusY = 50 + (loopOffset - 1) * 12;
    const path = `M ${sourceX} ${sourceY} A ${radiusX} ${radiusY} 0 1 0 ${targetX + 2} ${targetY}`;

    return (
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={edgeStyle}
      />
    );
  }

  const horizontalFlow =
    sourcePosition === Position.Right && targetPosition === Position.Left;
  let path = '';

  const curveOffset = data?.curveOffset ?? 0;
  const bend = (data?.curveDirection ?? 1) * curveOffset * EDGE_LAYOUT.curveGap;
  if (horizontalFlow) {
    const controlX1 = sourceX + 40 + curveOffset * 10;
    const controlY1 = sourceY + bend;
    const controlX2 = targetX - 40 - curveOffset * 10;
    const controlY2 = targetY + bend;

    path = `M ${sourceX} ${sourceY} C ${controlX1} ${controlY1} ${controlX2} ${controlY2} ${targetX} ${targetY}`;
  } else {
    const controlX1 = sourceX + bend;
    const controlY1 = sourceY + 40 + curveOffset * 10;
    const controlX2 = targetX + bend;
    const controlY2 = targetY - 40 - curveOffset * 10;

    path = `M ${sourceX} ${sourceY} C ${controlX1} ${controlY1} ${controlX2} ${controlY2} ${targetX} ${targetY}`;
  }

  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={edgeStyle}
    />
  );
}

function normalizeToolCalls(toolCalls: ToolCall[]) {
  return toolCalls.filter((toolCall) => toolCall?.name?.trim());
}

function getToolNames(tracing: Tracing) {
  return normalizeToolCalls(tracing.toolCalls).map((toolCall) => toolCall.name);
}

function uniqueToolNames(toolCalls: ToolCall[]) {
  return Array.from(new Set(toolCalls.map((toolCall) => toolCall.name)));
}

function buildNodeData(
  name: string,
  details?: ComparisonNodeDetail[],
  options: Partial<
    Pick<
      GraphNodeData,
      'glyph' | 'group' | 'color' | 'kind' | 'nodeType' | 'provProperties' | 'traceMembership'
    >
  > = {},
  glyphSystem: GlyphSystem = DEFAULT_GLYPH_SYSTEM
): GraphNodeData {
  const group = options.group ?? glyphSystem.getGroup(name);

  return {
    label: name,
    glyph: options.glyph ?? glyphSystem.getGlyph(name),
    group,
    color: options.color ?? glyphSystem.getGroupColor(group),
    kind: options.kind,
    nodeType: options.nodeType,
    provProperties: options.provProperties,
    traceMembership: options.traceMembership,
    details,
  };
}

function buildComparisonNodeDetail(
  trace: Tracing,
  toolCall: ToolCall,
  step: number,
  traceLabel: string | undefined,
  color: string
): ComparisonNodeDetail {
  return {
    traceId: trace.id,
    traceLabel,
    step,
    color,
    toolCall,
  };
}

function buildTraceNodeDetail(
  trace: Tracing,
  toolCall: ToolCall,
  step: number,
  glyphSystem: GlyphSystem = DEFAULT_GLYPH_SYSTEM
): ComparisonNodeDetail {
  return buildComparisonNodeDetail(
    trace,
    toolCall,
    step,
    undefined,
    glyphSystem.getGroupColor(glyphSystem.getGroup(toolCall.name))
  );
}

function renderCollapsedGraph(
  tracing: Tracing,
  glyphSystem: GlyphSystem = DEFAULT_GLYPH_SYSTEM
) {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const toolCalls = normalizeToolCalls(tracing.toolCalls);

  if (toolCalls.length === 0) {
    return { nodes, edges };
  }

  let previousNode: GraphNode | null = null;
  let runName = toolCalls[0].name;
  let runStartIndex = 0;
  let runLength = 1;

  const pushRun = (name: string, startIndex: number, count: number) => {
    const node: GraphNode = {
      id: `${tracing.id}:${nodes.length}`,
      type: 'tool',
      position: {
        x: COLLAPSED_LAYOUT.x,
        y: COLLAPSED_LAYOUT.y + nodes.length * COLLAPSED_LAYOUT.gapY,
      },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      data: buildNodeData(
        name,
        toolCalls
          .slice(startIndex, startIndex + count)
          .map((toolCall, index) =>
            buildTraceNodeDetail(
              tracing,
              toolCall,
              startIndex + index + 1,
              glyphSystem
            )
          ),
        {},
        glyphSystem
      ),
    };

    nodes.push(node);

    if (previousNode) {
      edges.push({
        id: `${previousNode.id}:${node.id}`,
        type: 'sequential',
        source: previousNode.id,
        target: node.id,
        sourceHandle: null,
        targetHandle: null,
        markerEnd: EDGE_LAYOUT.markerEnd,
      });
    }

    if (count > 1) {
      edges.push({
        id: `${node.id}:repeat`,
        type: 'repeat',
        source: node.id,
        target: node.id,
        sourceHandle: null,
        targetHandle: null,
        data: { repeats: count - 1 },
        markerEnd: EDGE_LAYOUT.markerEnd,
      });
    }

    previousNode = node;
  };

  for (let index = 1; index < toolCalls.length; index += 1) {
    if (toolCalls[index].name === runName) {
      runLength += 1;
      continue;
    }

    pushRun(runName, runStartIndex, runLength);
    runName = toolCalls[index].name;
    runStartIndex = index;
    runLength = 1;
  }

  pushRun(runName, runStartIndex, runLength);

  return { nodes, edges };
}

function renderTreeGraph(
  tracing: Tracing,
  glyphSystem: GlyphSystem = DEFAULT_GLYPH_SYSTEM
) {
  const toolCalls = normalizeToolCalls(tracing.toolCalls);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  if (toolCalls.length === 0) {
    return { nodes, edges };
  }

  const names = uniqueToolNames(toolCalls);
  const toolCallsByName = new Map<
    string,
    Array<{ toolCall: ToolCall; step: number }>
  >();
  const rootName = names[0];
  const nodeIds = new Map<string, string>();
  const childrenByName = new Map(names.map((name) => [name, [] as string[]]));
  const parentByName = new Map<string, string>();
  const positions = new Map<string, { x: number; y: number; depth: number }>();
  const seen = new Set([rootName]);

  toolCalls.forEach((toolCall, index) => {
    const entry = toolCallsByName.get(toolCall.name) ?? [];
    entry.push({ toolCall, step: index + 1 });
    toolCallsByName.set(toolCall.name, entry);
  });

  for (let index = 1; index < toolCalls.length; index += 1) {
    const parentName = toolCalls[index - 1].name;
    const childName = toolCalls[index].name;

    if (seen.has(childName)) {
      continue;
    }

    seen.add(childName);
    parentByName.set(childName, parentName);
    childrenByName.get(parentName)?.push(childName);
  }

  let nextColumn = 0;

  const placeNode = (name: string, depth: number): number => {
    const children = childrenByName.get(name) ?? [];

    if (children.length === 0) {
      const column = nextColumn;
      nextColumn += 1;
      positions.set(name, {
        x: TREE_LAYOUT.x + column * TREE_LAYOUT.gapX,
        y: TREE_LAYOUT.y + depth * TREE_LAYOUT.gapY,
        depth,
      });
      return column;
    }

    const firstColumn = placeNode(children[0], depth + 1);
    let lastColumn = firstColumn;

    for (let index = 1; index < children.length; index += 1) {
      lastColumn = placeNode(children[index], depth + 1);
    }

    const column = (firstColumn + lastColumn) / 2;
    positions.set(name, {
      x: TREE_LAYOUT.x + column * TREE_LAYOUT.gapX,
      y: TREE_LAYOUT.y + depth * TREE_LAYOUT.gapY,
      depth,
    });
    return column;
  };

  placeNode(rootName, 0);

  names.forEach((name) => {
    const id = `${tracing.id}:${name}`;
    const position = positions.get(name);

    nodeIds.set(name, id);
    nodes.push({
      id,
      type: 'tool',
      position: {
        x: position?.x ?? TREE_LAYOUT.x,
        y: position?.y ?? TREE_LAYOUT.y,
      },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      data: buildNodeData(
        name,
        (toolCallsByName.get(name) ?? []).map(({ toolCall, step }) =>
          buildTraceNodeDetail(tracing, toolCall, step, glyphSystem)
        ),
        {},
        glyphSystem
      ),
    });
  });

  const transitionCounts = new Map<string, number>();

  for (let index = 0; index < toolCalls.length - 1; index += 1) {
    const sourceName = toolCalls[index].name;
    const targetName = toolCalls[index + 1].name;
    const transitionKey = `${sourceName}->${targetName}`;
    const transitionCount = transitionCounts.get(transitionKey) ?? 0;
    const sourcePosition = positions.get(sourceName);
    const targetPosition = positions.get(targetName);
    const isTreeEdge =
      parentByName.get(targetName) === sourceName && transitionCount === 0;
    const isBackward =
      (targetPosition?.depth ?? 0) <= (sourcePosition?.depth ?? 0);

    transitionCounts.set(transitionKey, transitionCount + 1);

    edges.push({
      id: `${tracing.id}:tree-step:${index + 1}`,
      type: 'sequential',
      source: nodeIds.get(sourceName) ?? sourceName,
      target: nodeIds.get(targetName) ?? targetName,
      sourceHandle: null,
      targetHandle: null,
      data: {
        curveOffset:
          sourceName === targetName || !isTreeEdge || transitionCount > 0
            ? transitionCount + 1
            : undefined,
        curveDirection: isBackward ? -1 : 1,
      },
      markerEnd: EDGE_LAYOUT.markerEnd,
    });
  }

  return { nodes, edges };
}

function buildLcsPairs(traceA: Tracing, traceB: Tracing) {
  const a = getToolNames(traceA);
  const b = getToolNames(traceB);
  const dp = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0)
  );

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const matches: Array<{ indexes: [number, number]; name: string }> = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      matches.push({ indexes: [i, j], name: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] > dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return { sequences: [a, b], matches };
}

function buildLcsTriples(traceA: Tracing, traceB: Tracing, traceC: Tracing) {
  const a = getToolNames(traceA);
  const b = getToolNames(traceB);
  const c = getToolNames(traceC);
  const dp = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => Array(c.length + 1).fill(0))
  );

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      for (let k = c.length - 1; k >= 0; k -= 1) {
        if (a[i] === b[j] && a[i] === c[k]) {
          dp[i][j][k] = 1 + dp[i + 1][j + 1][k + 1];
        } else {
          dp[i][j][k] = Math.max(
            dp[i + 1][j][k],
            dp[i][j + 1][k],
            dp[i][j][k + 1]
          );
        }
      }
    }
  }

  const matches: Array<{ indexes: [number, number, number]; name: string }> = [];
  let i = 0;
  let j = 0;
  let k = 0;

  while (i < a.length && j < b.length && k < c.length) {
    if (a[i] === b[j] && a[i] === c[k]) {
      matches.push({ indexes: [i, j, k], name: a[i] });
      i += 1;
      j += 1;
      k += 1;
      continue;
    }

    const nextA = dp[i + 1][j][k];
    const nextB = dp[i][j + 1][k];
    const nextC = dp[i][j][k + 1];

    if (nextA >= nextB && nextA >= nextC) {
      i += 1;
    } else if (nextB >= nextC) {
      j += 1;
    } else {
      k += 1;
    }
  }

  return { sequences: [a, b, c], matches };
}

function getComparisonLaneYs(count: number) {
  if (count === 3) {
    return [
      COMPARE_LAYOUT.y - COMPARE_LAYOUT.gapY * 2,
      COMPARE_LAYOUT.y + COMPARE_LAYOUT.gapY * 2,
      COMPARE_LAYOUT.y + COMPARE_LAYOUT.gapY * 4,
    ];
  }

  return [
    COMPARE_LAYOUT.y - COMPARE_LAYOUT.gapY,
    COMPARE_LAYOUT.y + COMPARE_LAYOUT.gapY,
  ];
}

function renderComparisonGraph(
  traces: Tracing[],
  glyphSystem: GlyphSystem = DEFAULT_GLYPH_SYSTEM
) {
  const comparison =
    traces.length === 3
      ? buildLcsTriples(traces[0], traces[1], traces[2])
      : buildLcsPairs(traces[0], traces[1]);
  const traceToolCalls = traces.map((trace) => normalizeToolCalls(trace.toolCalls));
  const traceLabels = ['A', 'B', 'C'];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const comparisonId = traces.map((trace) => trace.id).join(':');
  const sharedNodeIds = comparison.matches.map(
    (_, index) => `${comparisonId}:shared:${index}`
  );
  const sharedXs = comparison.matches.map(
    (_, index) => COMPARE_LAYOUT.x + index * COMPARE_LAYOUT.gapX
  );

  comparison.matches.forEach((match, index) => {
    nodes.push({
      id: sharedNodeIds[index],
      type: 'tool',
      position: {
        x: sharedXs[index],
        y: COMPARE_LAYOUT.y,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: buildNodeData(
        match.name,
        traces.map((trace, traceIndex) =>
          buildComparisonNodeDetail(
            trace,
            traceToolCalls[traceIndex][match.indexes[traceIndex]],
            match.indexes[traceIndex] + 1,
            traceLabels[traceIndex],
            traceColor(traceIndex).edge
          )
        ),
        {},
        glyphSystem
      ),
    });

    if (index > 0) {
      edges.push({
        id: `${sharedNodeIds[index - 1]}:${sharedNodeIds[index]}`,
        type: 'sequential',
        source: sharedNodeIds[index - 1],
        target: sharedNodeIds[index],
        sourceHandle: null,
        targetHandle: null,
        markerEnd: EDGE_LAYOUT.markerEnd,
      });
    }
  });

  const addBranch = (
    sequence: string[],
    toolCalls: ToolCall[],
    matchIndexes: number[],
    trace: Tracing,
    laneY: number,
    traceLabel: string,
    colors: TraceColor
  ) => {
    let previousMatch = -1;

    for (let sharedIndex = 0; sharedIndex <= matchIndexes.length; sharedIndex += 1) {
      const nextMatch =
        sharedIndex < matchIndexes.length ? matchIndexes[sharedIndex] : sequence.length;
      const startIndex = previousMatch + 1;
      const items = sequence.slice(startIndex, nextMatch);

      if (items.length > 0) {
        const leftAnchorIndex = sharedIndex - 1;
        const rightAnchorIndex = sharedIndex < sharedXs.length ? sharedIndex : null;
        const leftAnchorId = leftAnchorIndex >= 0 ? sharedNodeIds[leftAnchorIndex] : null;
        const rightAnchorId =
          rightAnchorIndex === null ? null : sharedNodeIds[rightAnchorIndex];
        const leftX = leftAnchorIndex >= 0 ? sharedXs[leftAnchorIndex] : null;
        const rightX = rightAnchorIndex === null ? null : sharedXs[rightAnchorIndex];

        const branchNodeIds = items.map((name, itemIndex) => {
          let x = COMPARE_LAYOUT.x + itemIndex * COMPARE_LAYOUT.gapX;

          if (leftX !== null && rightX !== null) {
            x = leftX + ((rightX - leftX) * (itemIndex + 1)) / (items.length + 1);
          } else if (leftX !== null) {
            x = leftX + COMPARE_LAYOUT.gapX * (itemIndex + 1);
          } else if (rightX !== null) {
            x = rightX - COMPARE_LAYOUT.gapX * (items.length - itemIndex);
          }

          const sequenceIndex = startIndex + itemIndex;
          const id = `${trace.id}:compare:${sharedIndex}:${itemIndex}`;

          nodes.push({
            id,
            type: 'tool',
            position: { x, y: laneY },
            sourcePosition: Position.Right,
            targetPosition: Position.Left,
            data: buildNodeData(
              name,
              [
                buildComparisonNodeDetail(
                  trace,
                  toolCalls[sequenceIndex],
                  sequenceIndex + 1,
                  traceLabel,
                  colors.edge
                ),
              ],
              {},
              glyphSystem
            ),
            style: {
              backgroundColor: colors.fill,
              borderColor: colors.border,
            },
          });

          return id;
        });

        if (leftAnchorId) {
          edges.push({
            id: `${leftAnchorId}:${branchNodeIds[0]}`,
            type: 'sequential',
            source: leftAnchorId,
            target: branchNodeIds[0],
            sourceHandle: null,
            targetHandle: null,
            data: { color: colors.edge },
            markerEnd: EDGE_LAYOUT.markerEnd,
          });
        }

        for (let itemIndex = 1; itemIndex < branchNodeIds.length; itemIndex += 1) {
          edges.push({
            id: `${branchNodeIds[itemIndex - 1]}:${branchNodeIds[itemIndex]}`,
            type: 'sequential',
            source: branchNodeIds[itemIndex - 1],
            target: branchNodeIds[itemIndex],
            sourceHandle: null,
            targetHandle: null,
            data: { color: colors.edge },
            markerEnd: EDGE_LAYOUT.markerEnd,
          });
        }

        if (rightAnchorId) {
          edges.push({
            id: `${branchNodeIds[branchNodeIds.length - 1]}:${rightAnchorId}`,
            type: 'sequential',
            source: branchNodeIds[branchNodeIds.length - 1],
            target: rightAnchorId,
            sourceHandle: null,
            targetHandle: null,
            data: { color: colors.edge },
            markerEnd: EDGE_LAYOUT.markerEnd,
          });
        }
      }

      previousMatch = nextMatch;
    }
  };

  const laneYs = getComparisonLaneYs(traces.length);

  traces.forEach((trace, index) => {
    addBranch(
      comparison.sequences[index],
      traceToolCalls[index],
      comparison.matches.map((match) => match.indexes[index]),
      trace,
      laneYs[index],
      traceLabels[index],
      traceColor(index)
    );
  });

  if (nodes.length === 0) {
    traces.forEach((trace, traceIndex) => {
      const colors = traceColor(traceIndex);

      comparison.sequences[traceIndex].forEach((name, index) => {
        nodes.push({
          id: `${trace.id}:compare:none:${index}`,
          type: 'tool',
          position: {
            x: COMPARE_LAYOUT.x + index * COMPARE_LAYOUT.gapX,
            y: laneYs[traceIndex],
          },
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: buildNodeData(
            name,
            [
              buildComparisonNodeDetail(
                trace,
                traceToolCalls[traceIndex][index],
                index + 1,
                traceLabels[traceIndex],
                colors.edge
              ),
            ],
            {},
            glyphSystem
          ),
          style: {
            backgroundColor: colors.fill,
            borderColor: colors.border,
          },
        });

        if (index > 0) {
          edges.push({
            id: `${trace.id}:compare:none:${index - 1}:${index}`,
            type: 'sequential',
            source: `${trace.id}:compare:none:${index - 1}`,
            target: `${trace.id}:compare:none:${index}`,
            sourceHandle: null,
            targetHandle: null,
            data: { color: colors.edge },
            markerEnd: EDGE_LAYOUT.markerEnd,
          });
        }
      });
    });
  }

  return { nodes, edges };
}

function renderProvenanceGraph(
  tracing: Tracing,
  mode: GraphMode,
  glyphSystem: GlyphSystem = DEFAULT_GLYPH_SYSTEM
) {
  if (mode === 'tree') {
    return renderTreeGraph(tracing, glyphSystem);
  }

  return renderCollapsedGraph(tracing, glyphSystem);
}

function formatProvEdge(edge: AgentDag['edges'][number], direction: 'from' | 'to') {
  const relation = edge.relation ?? 'edge';
  const peer = direction === 'from' ? edge.source : edge.target;
  const evidence = edge.evidence
    ?.flatMap((item) => item.shared ?? [])
    .slice(0, 6)
    .join(', ');

  return evidence
    ? `${relation} ${direction} ${peer} [${evidence}]`
    : `${relation} ${direction} ${peer}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function provNodeLabel(node: AgentDag['nodes'][number]) {
  if (node.kind === 'Activity') {
    return node.tool;
  }

  return entityResponseLabel(node.response) ?? node.entityType;
}

function entityResponseLabel(response: unknown) {
  if (!isRecord(response)) {
    return undefined;
  }

  const candidates = [response, ...Object.values(response).filter(isRecord)];

  for (const candidate of candidates) {
    const name = candidate.name;
    if (name) {
      return String(name);
    }

    const path = candidate.path;
    if (path) {
      return String(path).split('/').pop() ?? String(path);
    }

    const id = candidate.id;
    if (id) {
      return String(id);
    }
  }

  return undefined;
}

function propertyValue(value: unknown): string | string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value;
  }

  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value) ?? 'undefined';
}

function buildCompactNodeLevels(
  nodeIds: string[],
  edges: Array<{ source: string; target: string }>
) {
  const levels = new Map(nodeIds.map((nodeId) => [nodeId, 0]));
  const incomingCounts = new Map(nodeIds.map((nodeId) => [nodeId, 0]));
  const outgoingByNode = new Map(nodeIds.map((nodeId) => [nodeId, [] as string[]]));

  for (const edge of edges) {
    if (
      edge.source === edge.target
      || !incomingCounts.has(edge.source)
      || !incomingCounts.has(edge.target)
    ) {
      continue;
    }

    incomingCounts.set(edge.target, (incomingCounts.get(edge.target) ?? 0) + 1);
    outgoingByNode.get(edge.source)?.push(edge.target);
  }

  const placed = new Set<string>();
  const queue = nodeIds.filter((nodeId) => incomingCounts.get(nodeId) === 0);
  let queueIndex = 0;

  const drainQueue = () => {
    while (queueIndex < queue.length) {
      const nodeId = queue[queueIndex];
      queueIndex += 1;

      if (placed.has(nodeId)) {
        continue;
      }

      placed.add(nodeId);

      for (const target of outgoingByNode.get(nodeId) ?? []) {
        if (placed.has(target)) {
          continue;
        }

        levels.set(target, Math.max(levels.get(target) ?? 0, (levels.get(nodeId) ?? 0) + 1));
        incomingCounts.set(target, (incomingCounts.get(target) ?? 0) - 1);

        if (incomingCounts.get(target) === 0) {
          queue.push(target);
        }
      }
    }
  };

  drainQueue();
  nodeIds.forEach((nodeId) => {
    if (!placed.has(nodeId)) {
      queue.push(nodeId);
      drainQueue();
    }
  });

  return levels;
}

function buildProvProperties(
  node: AgentDag['nodes'][number],
  incoming: string[],
  outgoing: string[]
) {
  const properties: Array<{ name: string; value: string | string[] }> = [
    { name: 'id', value: node.id },
    { name: 'kind', value: node.kind },
  ];

  if (node.kind === 'Activity') {
    properties.push(
      { name: 'toolCallId', value: node.toolCallId },
      { name: 'tool', value: node.tool },
      { name: 'timeIndex', value: String(node.timeIndex) },
      { name: 'args', value: propertyValue(node.args) }
    );
  } else {
    properties.push({ name: 'entityType', value: node.entityType });
    if (node.response !== undefined) {
      properties.push({ name: 'response', value: propertyValue(node.response) });
    }
  }

  if (incoming.length > 0) {
    properties.push({ name: 'incoming', value: incoming });
  }

  if (outgoing.length > 0) {
    properties.push({ name: 'outgoing', value: outgoing });
  }

  return properties;
}

function renderAgentDagGraph(
  dag: AgentDag,
  glyphSystem: GlyphSystem = DEFAULT_GLYPH_SYSTEM
) {
  const nodeLevels = buildCompactNodeLevels(
    dag.nodes.map((node) => node.id),
    dag.edges
  );
  const rowsByLevel = new Map<number, number>();
  const incomingByNode = new Map<string, string[]>();
  const outgoingByNode = new Map<string, string[]>();

  dag.edges.forEach((edge) => {
    incomingByNode.set(edge.target, [
      ...(incomingByNode.get(edge.target) ?? []),
      formatProvEdge(edge, 'from'),
    ]);
    outgoingByNode.set(edge.source, [
      ...(outgoingByNode.get(edge.source) ?? []),
      formatProvEdge(edge, 'to'),
    ]);
  });

  const nodes: GraphNode[] = dag.nodes.map((node) => {
    const level = nodeLevels.get(node.id) ?? 0;
    const row = rowsByLevel.get(level) ?? 0;
    rowsByLevel.set(level, row + 1);

    return {
      id: node.id,
      type: 'tool',
      className:
        node.kind === 'Entity' ? 'prov-node--entity' : 'prov-node--activity',
      position: {
        x: AGENT_DAG_LAYOUT.x + level * AGENT_DAG_LAYOUT.gapX,
        y: AGENT_DAG_LAYOUT.y + row * AGENT_DAG_LAYOUT.gapY,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data:
        node.kind === 'Entity'
          ? buildNodeData(
              provNodeLabel(node),
              undefined,
              {
                glyph: 'circle',
                group: node.entityType,
                color: glyphSystem.getGroupColor(node.entityType),
                kind: 'Entity',
                nodeType: node.entityType,
                provProperties: buildProvProperties(
                  node,
                  incomingByNode.get(node.id) ?? [],
                  outgoingByNode.get(node.id) ?? []
                ),
              },
              glyphSystem
            )
          : buildNodeData(
              provNodeLabel(node),
              undefined,
              {
                kind: 'Activity',
                nodeType: node.tool,
                provProperties: buildProvProperties(
                  node,
                  incomingByNode.get(node.id) ?? [],
                  outgoingByNode.get(node.id) ?? []
                ),
              },
              glyphSystem
            ),
    };
  });
  const edgeCounts = new Map<string, number>();
  const edges: GraphEdge[] = dag.edges.map((edge, index) => {
    const edgeKey = `${edge.source}:${edge.target}`;
    const count = edgeCounts.get(edgeKey) ?? 0;
    edgeCounts.set(edgeKey, count + 1);

    return {
      id: `${edgeKey}:${index}`,
      type: 'sequential',
      source: edge.source,
      target: edge.target,
      sourceHandle: null,
      targetHandle: null,
      data: {
        color:
          edge.relation === 'usedBy'
            ? '#0284c7'
            : edge.relation === 'generatedBy'
              ? '#16a34a'
              : '#64748b',
        curveOffset: count > 0 ? count + 1 : undefined,
        curveDirection: count % 2 === 0 ? 1 : -1,
      },
      markerEnd: EDGE_LAYOUT.markerEnd,
    };
  });

  return { nodes, edges };
}

function formatJoinedEdge(
  edge: JoinedProvenanceGraph['edges'][number],
  direction: 'from' | 'to'
) {
  const relation = edge.relationTypes.join('/') || 'edge';
  const peer = direction === 'from' ? edge.source : edge.target;

  return `${relation} ${direction} ${peer} (${edge.supportCount})`;
}

function buildJoinedProperties(
  node: JoinedProvenanceGraph['nodes'][number],
  incoming: string[],
  outgoing: string[]
) {
  const properties: Array<{ name: string; value: string | string[] }> = [
    { name: 'id', value: node.id },
    { name: 'kind', value: node.kind },
    { name: 'supportTraces', value: node.supportTraces },
    { name: 'supportCount', value: String(node.supportCount) },
    { name: 'multiplicityByTrace', value: propertyValue(node.multiplicityByTrace) },
    { name: 'confidence', value: String(node.confidence) },
    { name: 'scoreSummary', value: propertyValue(node.scoreSummary) },
    { name: 'rootSetsByTrace', value: propertyValue(node.rootSetsByTrace) },
    { name: 'representativeSignature', value: propertyValue(node.representativeSignature) },
    { name: 'members', value: propertyValue(node.members) },
  ];

  if (incoming.length > 0) {
    properties.push({ name: 'incoming', value: incoming });
  }

  if (outgoing.length > 0) {
    properties.push({ name: 'outgoing', value: outgoing });
  }

  return properties;
}

function traceColor(index: number): TraceColor {
  const base = COMPARISON_TRACE_COLORS[index];
  if (base) {
    return base;
  }

  const hue = (index * 137.508) % 360;
  return {
    edge: `hsl(${hue} 70% 42%)`,
    fill: `hsl(${hue} 86% 94%)`,
    border: `hsl(${hue} 66% 72%)`,
  };
}

function supportRatio(count: number, maxCount: number) {
  return maxCount <= 1 ? 0 : (count - 1) / (maxCount - 1);
}

function joinedNodeSize(count: number, maxCount: number) {
  const ratio = supportRatio(count, maxCount);
  return Math.round(72 + ratio * 48);
}

function joinedEdgeWidth(count: number, maxCount: number) {
  return 2 + supportRatio(count, maxCount) * 9;
}

function joinedTraceColors(supportTraces: string[], traceIds: string[]) {
  return traceIds
    .map((traceId, index) =>
      supportTraces.includes(traceId)
        ? traceColor(index)
        : null
    )
    .filter((colors): colors is TraceColor => colors !== null);
}

function joinedTraceMembership(supportTraces: string[], traceIds: string[]) {
  return traceIds.map((traceId, index) => ({
    id: traceId,
    color: traceColor(index).edge,
    active: supportTraces.includes(traceId),
  }));
}

function joinedTraceRing(supportTraces: string[], traceIds: string[]) {
  if (traceIds.length === 0) {
    return '#e4e4e7';
  }

  const supportSet = new Set(supportTraces);
  const step = 360 / traceIds.length;
  const segments = traceIds.map((traceId, index) => {
    const color = supportSet.has(traceId) ? traceColor(index).edge : '#e4e4e7';
    const start = index * step;
    const end = (index + 1) * step;
    return `${color} ${start}deg ${end}deg`;
  });

  return `conic-gradient(${segments.join(', ')})`;
}

function joinedPrimaryTool(node: JoinedProvenanceGraph['nodes'][number]) {
  const member = node.members.find(
    (item): item is { tool?: unknown } =>
      item !== null && typeof item === 'object' && 'tool' in item
  );
  const tool = typeof member?.tool === 'string' ? member.tool : node.label.split('/')[0];
  return tool.trim() || node.label;
}

function joinedPatternScore(item: {
  scoreSummary?: { maxScore?: number | null };
}) {
  const score = item.scoreSummary?.maxScore;
  return typeof score === 'number' ? score : null;
}

function hasLowJoinedPattern(
  item: { supportCount: number; scoreSummary?: { maxScore?: number | null } },
  filters: JoinedFilters
) {
  const score = joinedPatternScore(item);
  return (
    item.supportCount < filters.minSupport ||
    (filters.minMaxScore > 0
      && (score === null || score < filters.minMaxScore))
  );
}

function renderJoinedProvenanceGraph(
  graph: JoinedProvenanceGraph,
  traceIds: string[],
  filters: JoinedFilters,
  glyphSystem: GlyphSystem = DEFAULT_GLYPH_SYSTEM
) {
  const lowNodeIds = new Set(
    graph.nodes
      .filter((node) => hasLowJoinedPattern(node, filters))
      .map((node) => node.id)
  );
  const graphNodes =
    filters.mode === 'prune'
      ? graph.nodes.filter((node) => !lowNodeIds.has(node.id))
      : graph.nodes;
  const nodeIds = new Set(graphNodes.map((node) => node.id));
  const graphEdges = graph.edges.filter(
    (edge) =>
      nodeIds.has(edge.source) && nodeIds.has(edge.target)
      && (filters.mode === 'fade'
        || (!lowNodeIds.has(edge.source)
          && !lowNodeIds.has(edge.target)
          && !hasLowJoinedPattern(edge, filters)))
  );
  const nodeLevels = buildCompactNodeLevels(
    graphNodes.map((node) => node.id),
    graphEdges
  );
  const rowsByLevel = new Map<number, number>();
  const incomingByNode = new Map<string, string[]>();
  const outgoingByNode = new Map<string, string[]>();
  const maxNodeSupport = Math.max(...graphNodes.map((node) => node.supportCount), 1);
  const maxEdgeSupport = Math.max(...graphEdges.map((edge) => edge.supportCount), 1);

  graphEdges.forEach((edge) => {
    incomingByNode.set(edge.target, [
      ...(incomingByNode.get(edge.target) ?? []),
      formatJoinedEdge(edge, 'from'),
    ]);
    outgoingByNode.set(edge.source, [
      ...(outgoingByNode.get(edge.source) ?? []),
      formatJoinedEdge(edge, 'to'),
    ]);
  });

  const nodes: GraphNode[] = graphNodes.map((node) => {
    const level = nodeLevels.get(node.id) ?? 0;
    const row = rowsByLevel.get(level) ?? 0;
    const anomaly = Boolean(node.scoreSummary?.isAnomaly);
    const maxScore = joinedPatternScore(node);
    const size = joinedNodeSize(node.supportCount, maxNodeSupport);
    const primaryTool = node.kind === 'JoinedActivity' ? joinedPrimaryTool(node) : node.label;
    const lowPattern = lowNodeIds.has(node.id);
    rowsByLevel.set(level, row + 1);

    return {
      id: node.id,
      type: 'tool',
      className:
        node.kind === 'Root' ? 'prov-node--root' : 'prov-node--activity',
      position: {
        x: JOINED_LAYOUT.x + level * JOINED_LAYOUT.gapX,
        y: JOINED_LAYOUT.y + row * JOINED_LAYOUT.gapY,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: buildNodeData(
        node.label,
        undefined,
        {
          glyph: node.kind === 'Root' ? 'diamond' : glyphSystem.getGlyph(primaryTool),
          group: node.kind === 'Root' ? node.kind : glyphSystem.getGroup(primaryTool),
          kind: node.kind,
          nodeType:
            node.kind === 'Root'
              ? `${node.supportCount} traces`
              : [
                  `${node.supportCount} traces`,
                  `${Math.round(node.confidence * 100)}%`,
                  maxScore === null ? '' : `max ${maxScore.toFixed(2)}`,
                  anomaly ? 'anomaly' : '',
                ].filter(Boolean).join(', '),
          provProperties: buildJoinedProperties(
            node,
            incomingByNode.get(node.id) ?? [],
            outgoingByNode.get(node.id) ?? []
          ),
          traceMembership: joinedTraceMembership(node.supportTraces, traceIds),
        },
        glyphSystem
      ),
      style: {
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        border: 'none',
        borderRadius: 9999,
        background: joinedTraceRing(node.supportTraces, traceIds),
        boxShadow: '0 3px 8px rgba(15, 23, 42, 0.12)',
        opacity: lowPattern ? 0.2 : 1,
        padding: 4,
      },
    };
  });
  const edgeCounts = new Map<string, number>();
  const edges: GraphEdge[] = graphEdges.map((edge) => {
    const edgeKey = `${edge.source}:${edge.target}`;
    const count = edgeCounts.get(edgeKey) ?? 0;
    const colors = joinedTraceColors(edge.supportTraces, traceIds);
    const lowPattern =
      lowNodeIds.has(edge.source)
      || lowNodeIds.has(edge.target)
      || hasLowJoinedPattern(edge, filters);
    edgeCounts.set(edgeKey, count + 1);

    return {
      id: edge.id,
      type: 'sequential',
      source: edge.source,
      target: edge.target,
      sourceHandle: null,
      targetHandle: null,
      data: {
        color:
          colors.length === 1
            ? colors[0].edge
            : colors.length > 1
              ? '#475569'
              : '#94a3b8',
        strokeWidth: joinedEdgeWidth(edge.supportCount, maxEdgeSupport),
        opacity: lowPattern
          ? 0.2
          : 0.3 + supportRatio(edge.supportCount, maxEdgeSupport) * 0.38,
        strokeDasharray: edge.scoreSummary?.isAnomaly ? '6 5' : undefined,
        curveOffset: count > 0 ? count + 1 : undefined,
        curveDirection: count % 2 === 0 ? 1 : -1,
      },
    };
  });

  if (nodes.length === 0) {
    return { nodes, edges };
  }

  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const normalizedNodes = nodes.map((node) => ({
    ...node,
    position: {
      x: node.position.x - minX,
      y: node.position.y - minY,
    },
  }));

  return { nodes: normalizedNodes, edges };
}

function FlowGraph({
  graph,
  graphKey,
  emptyMessage,
  heightClass = 'h-96',
  fitPadding = 0.2,
}: {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  graphKey: string;
  emptyMessage: string;
  heightClass?: string;
  fitPadding?: number;
}) {
  if (graph.nodes.length === 0) {
    return <div className="text-sm text-zinc-600">{emptyMessage}</div>;
  }

  return (
    <FlowGraphBody
      key={graphKey}
      graph={graph}
      graphKey={graphKey}
      heightClass={heightClass}
      fitPadding={fitPadding}
    />
  );
}

function FlowGraphAutoFit({
  graphKey,
  fitPadding,
}: {
  graphKey: string;
  fitPadding: number;
}) {
  const nodesInitialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  const centerGraph = () => {
    fitView({ padding: fitPadding, duration: 160 });
  };

  useEffect(() => {
    if (!nodesInitialized) {
      return;
    }

    let timeout: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      fitView({ padding: fitPadding, duration: 0 });
      timeout = window.setTimeout(() => {
        fitView({ padding: fitPadding, duration: 120 });
      }, 80);
    });

    return () => {
      window.cancelAnimationFrame(frame);
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
      }
    };
  }, [fitPadding, fitView, graphKey, nodesInitialized]);

  return (
    <Panel position="top-right">
      <button
        type="button"
        className="nodrag nopan border border-zinc-300 bg-white/95 px-2 py-1 text-[11px] font-medium text-zinc-600 shadow-sm transition hover:text-zinc-950"
        onClick={centerGraph}
      >
        Center
      </button>
    </Panel>
  );
}

function FlowGraphBody({
  graph,
  graphKey,
  heightClass,
  fitPadding,
}: {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  graphKey: string;
  heightClass: string;
  fitPadding: number;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const [openNodeIds, setOpenNodeIds] = useState<string[]>([]);

  useEffect(() => {
    setNodes(graph.nodes);
  }, [graph.nodes, graphKey, setNodes]);

  const displayNodes = nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      tooltipOpen: openNodeIds.includes(node.id),
      onCloseDetails: () => {
        setOpenNodeIds((current) =>
          current.filter((openNodeId) => openNodeId !== node.id)
        );
      },
    },
  }));

  return (
    <div className={heightClass}>
      <ReactFlow
        key={graphKey}
        nodes={displayNodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => {
          if (!node.data.details?.length && !node.data.provProperties?.length) {
            return;
          }

          setOpenNodeIds((current) =>
            current.includes(node.id) ? current : [...current, node.id]
          );
        }}
        fitView
        fitViewOptions={{ padding: fitPadding, minZoom: 0.65, maxZoom: 1.15 }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <FlowGraphAutoFit graphKey={graphKey} fitPadding={fitPadding} />
        <Background />
      </ReactFlow>
    </div>
  );
}

function ProvenanceGraphView({
  tracing,
  mode,
  toolSets = {},
}: {
  tracing: Tracing;
  mode: GraphMode;
  toolSets?: ToolSets;
}) {
  const graph = renderProvenanceGraph(tracing, mode, createGlyphSystem(toolSets));
  return (
    <FlowGraph
      graph={graph}
      graphKey={`${tracing.id}:${mode}`}
      emptyMessage="No tool calls."
    />
  );
}

function TracingComparisonView({
  traces,
  toolSets = {},
}: {
  traces: Tracing[];
  toolSets?: ToolSets;
}) {
  const graph = renderComparisonGraph(traces, createGlyphSystem(toolSets));

  return (
    <FlowGraph
      graph={graph}
      graphKey={`${traces.map((trace) => trace.id).join(':')}:compare`}
      emptyMessage="No comparable tool calls."
      heightClass={traces.length === 3 ? 'h-[40rem]' : 'h-[28rem]'}
    />
  );
}

function AgentDagGraphView({
  dag,
  toolSets = {},
}: {
  dag: AgentDag;
  toolSets?: ToolSets;
}) {
  return (
    <FlowGraph
      graph={renderAgentDagGraph(dag, createGlyphSystem(toolSets))}
      graphKey={`agent-dag:${dag.nodes.map((node) => node.id).join(':')}`}
      emptyMessage="No tool calls."
      heightClass="h-[28rem]"
    />
  );
}

function JoinedProvenanceGraphView({
  graph,
  traceIds,
  toolSets = {},
}: {
  graph: JoinedProvenanceGraph;
  traceIds: Array<string | number>;
  toolSets?: ToolSets;
}) {
  const [filterMode, setFilterMode] = useState<JoinedFilterMode>('fade');
  const [minSupport, setMinSupport] = useState(1);
  const [minMaxScore, setMinMaxScore] = useState(0);
  const maxSupport = Math.max(
    ...graph.nodes.map((node) => node.supportCount),
    ...graph.edges.map((edge) => edge.supportCount),
    1
  );
  const maxScore = Math.max(
    ...graph.nodes.map((node) => joinedPatternScore(node) ?? 0),
    ...graph.edges.map((edge) => joinedPatternScore(edge) ?? 0),
    graph.scoreSummary?.max ?? 0,
    1
  );
  const supportThreshold = Math.min(minSupport, maxSupport);
  const scoreThreshold = Math.min(minMaxScore, maxScore);
  const filters: JoinedFilters = {
    mode: filterMode,
    minSupport: supportThreshold,
    minMaxScore: scoreThreshold,
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-600">
        <div className="inline-flex overflow-hidden border border-zinc-300 bg-white">
          {(['fade', 'prune'] as JoinedFilterMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`px-2 py-1 font-medium capitalize transition ${
                filterMode === mode
                  ? 'bg-zinc-900 text-white'
                  : 'text-zinc-600 hover:bg-zinc-100'
              }`}
              onClick={() => setFilterMode(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
        <label className="inline-flex items-center gap-1">
          Support {'>='} {supportThreshold}
          <input
            type="range"
            min={1}
            max={maxSupport}
            step={1}
            value={supportThreshold}
            className="w-36 accent-zinc-900"
            onChange={(event) =>
              setMinSupport(Math.max(1, Math.floor(Number(event.target.value) || 1)))
            }
          />
        </label>
        <label className="inline-flex items-center gap-1">
          Max score {'>='} {scoreThreshold.toFixed(2)}
          <input
            type="range"
            min={0}
            max={maxScore}
            step={0.05}
            value={scoreThreshold}
            className="w-40 accent-zinc-900"
            onChange={(event) =>
              setMinMaxScore(Math.min(maxScore, Math.max(0, Number(event.target.value) || 0)))
            }
          />
        </label>
      </div>
      <FlowGraph
        graph={renderJoinedProvenanceGraph(
          graph,
          traceIds.map(String),
          filters,
          createGlyphSystem(toolSets)
        )}
        graphKey={`joined:${traceIds.map(String).join(':')}:${filterMode}:${supportThreshold}:${scoreThreshold}:${graph.nodes.map((node) => node.id).join(':')}:${graph.edges.length}`}
        emptyMessage="No joined provenance graph."
        heightClass="h-[30rem]"
        fitPadding={0.08}
      />
    </div>
  );
}

export {
  AgentDagGraphView,
  JoinedProvenanceGraphView,
  ProvenanceGraphView,
  TracingComparisonView,
  renderProvenanceGraph,
};
