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
  ToolCall,
  Tracing,
} from './types';
import { createGlyphSystem } from './visualization_shared';

type ComparisonNodeDetail = ToolCallTooltipDetail;

type GraphNodeData = {
  label: string;
  glyph: string;
  group: string;
  kind?: 'Activity' | 'Entity' | 'Root' | 'JoinedActivity';
  nodeType?: string;
  provProperties?: Array<{ name: string; value: string | string[] }>;
  details?: ComparisonNodeDetail[];
  tooltipOpen?: boolean;
  onCloseDetails?: () => void;
};

type GraphEdgeData = {
  repeats?: number;
  label?: string;
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

const COLLAPSED_LAYOUT = { x: 0, y: 0, gapY: 50 };
const TREE_LAYOUT = { x: 0, y: 0, gapX: 176, gapY: 112 };
const COMPARE_LAYOUT = { x: 0, y: 0, gapX: 176, gapY: 112 };
const AGENT_DAG_LAYOUT = { x: 0, y: 0, gapX: 248, gapY: 128 };
const JOINED_LAYOUT = { x: 0, y: 0, gapX: 170, gapY: 74 };
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
const COMPARISON_TRACE_COLORS = [TRACE_A_COLORS, TRACE_B_COLORS, TRACE_C_COLORS] as const;
const GLYPH_SYSTEM = createGlyphSystem();

const nodeTypes = { tool: ToolNode };
const edgeTypes = { repeat: RepeatEdge, sequential: SequentialEdge };

function getPathMidpoint(path: string, fallbackX: number, fallbackY: number) {
  if (typeof document === 'undefined') {
    return { x: fallbackX, y: fallbackY };
  }

  const pathNode = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pathNode.setAttribute('d', path);
  const midpoint = pathNode.getPointAtLength(pathNode.getTotalLength() / 2);

  return { x: midpoint.x, y: midpoint.y };
}

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
  const color = GLYPH_SYSTEM.getGroupColor(data.group);
  const title = data.nodeType ? `${data.label} (${data.nodeType})` : data.label;
  const hasTooltip = Boolean(data.details?.length || data.provProperties?.length);
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
      <div className={`provenance-node provenance-node--${variant}`} title={title}>
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
  const label = data?.label;
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
    const labelX = Math.min(sourceX, targetX) + radiusX * 2;
    const labelY = Math.max(sourceY, targetY) - radiusY * 0.35;

    return (
      <>
        <BaseEdge
          id={id}
          path={path}
          markerEnd={markerEnd}
          style={edgeStyle}
        />
        {label && <EdgeBadge x={labelX} y={labelY} label={label} />}
      </>
    );
  }

  const horizontalFlow =
    sourcePosition === Position.Right && targetPosition === Position.Left;
  let path = '';
  let labelX = (sourceX + targetX) / 2;
  let labelY = (sourceY + targetY) / 2;

  {
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
    ({ x: labelX, y: labelY } = getPathMidpoint(
      path,
      (sourceX + targetX) / 2,
      (sourceY + targetY) / 2
    ));
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={edgeStyle}
      />
      {label && <EdgeBadge x={labelX} y={labelY} label={label} />}
    </>
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
    Pick<GraphNodeData, 'glyph' | 'group' | 'kind' | 'nodeType' | 'provProperties'>
  > = {}
): GraphNodeData {
  return {
    label: name,
    glyph: options.glyph ?? GLYPH_SYSTEM.getGlyph(name),
    group: options.group ?? GLYPH_SYSTEM.getGroup(name),
    kind: options.kind,
    nodeType: options.nodeType,
    provProperties: options.provProperties,
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
  step: number
): ComparisonNodeDetail {
  return buildComparisonNodeDetail(
    trace,
    toolCall,
    step,
    undefined,
    GLYPH_SYSTEM.getGroupColor(toolCall.name)
  );
}

function renderCollapsedGraph(tracing: Tracing) {
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
            buildTraceNodeDetail(tracing, toolCall, startIndex + index + 1)
          )
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

function renderTreeGraph(tracing: Tracing) {
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
          buildTraceNodeDetail(tracing, toolCall, step)
        )
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
        label: String(index + 1),
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

function renderComparisonGraph(traces: Tracing[]) {
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
            COMPARISON_TRACE_COLORS[traceIndex].edge
          )
        )
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
    colors: typeof TRACE_A_COLORS
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
            data: buildNodeData(name, [
              buildComparisonNodeDetail(
                trace,
                toolCalls[sequenceIndex],
                sequenceIndex + 1,
                traceLabel,
                colors.edge
              ),
            ]),
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
      COMPARISON_TRACE_COLORS[index]
    );
  });

  if (nodes.length === 0) {
    traces.forEach((trace, traceIndex) => {
      const colors = COMPARISON_TRACE_COLORS[traceIndex];

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
          data: buildNodeData(name, [
            buildComparisonNodeDetail(
              trace,
              traceToolCalls[traceIndex][index],
              index + 1,
              traceLabels[traceIndex],
              colors.edge
            ),
          ]),
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

function renderProvenanceGraph(tracing: Tracing, mode: GraphMode) {
  if (mode === 'tree') {
    return renderTreeGraph(tracing);
  }

  return renderCollapsedGraph(tracing);
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

function renderAgentDagGraph(dag: AgentDag) {
  const nodeLevels = new Map(dag.nodes.map((node) => [node.id, 0]));
  const rowsByLevel = new Map<number, number>();
  const incomingByNode = new Map<string, string[]>();
  const outgoingByNode = new Map<string, string[]>();

  for (let pass = 0; pass < dag.nodes.length; pass += 1) {
    let changed = false;

    dag.edges.forEach((edge) => {
      const nextLevel = (nodeLevels.get(edge.source) ?? 0) + 1;

      if (nextLevel > (nodeLevels.get(edge.target) ?? 0)) {
        nodeLevels.set(edge.target, nextLevel);
        changed = true;
      }
    });

    if (!changed) {
      break;
    }
  }

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
          ? buildNodeData(provNodeLabel(node), undefined, {
              glyph: 'circle',
              group: node.entityType,
              kind: 'Entity',
              nodeType: node.entityType,
              provProperties: buildProvProperties(
                node,
                incomingByNode.get(node.id) ?? [],
                outgoingByNode.get(node.id) ?? []
              ),
            })
          : buildNodeData(provNodeLabel(node), undefined, {
              kind: 'Activity',
              nodeType: node.tool,
              provProperties: buildProvProperties(
                node,
                incomingByNode.get(node.id) ?? [],
                outgoingByNode.get(node.id) ?? []
              ),
            }),
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
        label: edge.relation,
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

function joinedTraceColors(supportTraces: string[], traceIds: string[]) {
  return traceIds
    .map((traceId, index) =>
      supportTraces.includes(traceId)
        ? COMPARISON_TRACE_COLORS[index]
        : null
    )
    .filter((colors): colors is typeof COMPARISON_TRACE_COLORS[number] => colors !== null);
}

function joinedNodeBackground(colors: Array<typeof COMPARISON_TRACE_COLORS[number]>) {
  if (colors.length === 0) {
    return undefined;
  }

  if (colors.length === 1) {
    return colors[0].fill;
  }

  const step = 100 / colors.length;
  return `linear-gradient(90deg, ${colors
    .map((colors, index) => {
      const start = Math.round(index * step);
      const end = Math.round((index + 1) * step);
      return `${colors.fill} ${start}% ${end}%`;
    })
    .join(', ')})`;
}

function renderJoinedProvenanceGraph(graph: JoinedProvenanceGraph, traceIds: string[]) {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const graphEdges = graph.edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)
  );
  const nodeLevels = new Map(graph.nodes.map((node) => [node.id, 0]));
  const rowsByLevel = new Map<number, number>();
  const incomingByNode = new Map<string, string[]>();
  const outgoingByNode = new Map<string, string[]>();

  for (let pass = 0; pass < graph.nodes.length; pass += 1) {
    let changed = false;

    graphEdges.forEach((edge) => {
      const nextLevel = (nodeLevels.get(edge.source) ?? 0) + 1;

      if (nextLevel > (nodeLevels.get(edge.target) ?? 0)) {
        nodeLevels.set(edge.target, nextLevel);
        changed = true;
      }
    });

    if (!changed) {
      break;
    }
  }

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

  const nodes: GraphNode[] = graph.nodes.map((node) => {
    const level = nodeLevels.get(node.id) ?? 0;
    const row = rowsByLevel.get(level) ?? 0;
    const anomaly = Boolean(node.scoreSummary?.isAnomaly);
    const highScore = Boolean(node.scoreSummary?.highScoreTraces.length);
    const colors = joinedTraceColors(node.supportTraces, traceIds);
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
      data: buildNodeData(node.label, undefined, {
        glyph: node.kind === 'Root' ? 'diamond' : 'circle',
        group: node.kind,
        kind: node.kind,
        nodeType:
          node.kind === 'Root'
            ? `${node.supportCount} traces`
            : [
                `${node.supportCount} traces`,
                `${Math.round(node.confidence * 100)}%`,
                highScore ? 'high score' : '',
                anomaly ? 'anomaly' : '',
              ].filter(Boolean).join(', '),
        provProperties: buildJoinedProperties(
          node,
          incomingByNode.get(node.id) ?? [],
          outgoingByNode.get(node.id) ?? []
        ),
      }),
      style: {
        borderColor:
          colors.length === 1
            ? colors[0].border
            : colors.length > 1
              ? '#71717a'
              : undefined,
        borderWidth: anomaly || highScore ? 2 : undefined,
        borderStyle: anomaly ? 'dashed' : undefined,
        background: joinedNodeBackground(colors),
        boxShadow: highScore ? '0 0 0 3px rgba(34, 197, 94, 0.18)' : undefined,
      },
    };
  });
  const edgeCounts = new Map<string, number>();
  const edges: GraphEdge[] = graphEdges.map((edge) => {
    const edgeKey = `${edge.source}:${edge.target}`;
    const count = edgeCounts.get(edgeKey) ?? 0;
    const colors = joinedTraceColors(edge.supportTraces, traceIds);
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
        strokeWidth: Math.min(2 + edge.supportCount * 2.5, 12),
        opacity: edge.supportCount > 1 ? 0.78 : 0.42,
        strokeDasharray: edge.scoreSummary?.isAnomaly ? '6 5' : undefined,
        curveOffset: count > 0 ? count + 1 : undefined,
        curveDirection: count % 2 === 0 ? 1 : -1,
      },
    };
  });

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
    setOpenNodeIds([]);
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
}: {
  tracing: Tracing;
  mode: GraphMode;
}) {
  const graph = renderProvenanceGraph(tracing, mode);
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
}: {
  traces: Tracing[];
}) {
  const graph = renderComparisonGraph(traces);

  return (
    <FlowGraph
      graph={graph}
      graphKey={`${traces.map((trace) => trace.id).join(':')}:compare`}
      emptyMessage="No comparable tool calls."
      heightClass={traces.length === 3 ? 'h-[40rem]' : 'h-[28rem]'}
    />
  );
}

function AgentDagGraphView({ dag }: { dag: AgentDag }) {
  return (
    <FlowGraph
      graph={renderAgentDagGraph(dag)}
      graphKey={`agent-dag:${dag.nodes.map((node) => node.id).join(':')}`}
      emptyMessage="No tool calls."
      heightClass="h-[28rem]"
    />
  );
}

function JoinedProvenanceGraphView({
  graph,
  traceIds,
}: {
  graph: JoinedProvenanceGraph;
  traceIds: Array<string | number>;
}) {
  return (
    <FlowGraph
      graph={renderJoinedProvenanceGraph(graph, traceIds.map(String))}
      graphKey={`joined:${traceIds.map(String).join(':')}:${graph.nodes.map((node) => node.id).join(':')}:${graph.edges.length}`}
      emptyMessage="No joined provenance graph."
      heightClass="h-[30rem]"
      fitPadding={0.08}
    />
  );
}

export {
  AgentDagGraphView,
  JoinedProvenanceGraphView,
  ProvenanceGraphView,
  TracingComparisonView,
  renderProvenanceGraph,
};
