'use client';

import { useEffect, useState } from 'react';
import {
  Background,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  NodeToolbar,
  Position,
  ReactFlow,
  useNodesState,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import type { ToolCall, Tracing } from './types';
import { createGlyphSystem } from './visualization_shared';

type GraphMode = 'collapsed' | 'tree';

type ComparisonNodeDetail = {
  traceId: Tracing['id'];
  traceLabel: string;
  step: number;
  color: string;
  toolCall: ToolCall;
};

type GraphNodeData = {
  label: string;
  glyph: string;
  group: string;
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
};

type GraphNode = Node<GraphNodeData, 'tool'>;
type GraphEdge = Edge<GraphEdgeData, 'repeat' | 'sequential'>;
type GraphNodeProps = NodeProps<GraphNode>;
type GraphEdgeProps = EdgeProps<GraphEdge>;

const COLLAPSED_LAYOUT = { x: 0, y: 0, gapY: 50 };
const TREE_LAYOUT = { x: 0, y: 0, gapX: 176, gapY: 112 };
const COMPARE_LAYOUT = { x: 0, y: 0, gapX: 176, gapY: 112 };
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

  return (
    <>
      {data.details?.length ? (
        <NodeToolbar isVisible={data.tooltipOpen} position={Position.Top} offset={8}>
          <ComparisonNodeDetails
            details={data.details}
            onClose={data.onCloseDetails ?? (() => {})}
          />
        </NodeToolbar>
      ) : null}
      <Handle type="target" position={targetPosition} />
      <div className="provenance-node" title={data.label}>
        <span
          className="provenance-node__glyph"
          style={{ color }}
          aria-hidden="true"
        >
          <ToolGlyph glyph={data.glyph} />
        </span>
        <span className="provenance-node__label">{data.label}</span>
      </div>
      <Handle type="source" position={sourcePosition} />
    </>
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
    sourcePosition = Position.Bottom,
    targetPosition = Position.Top,
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
    ? { stroke: data.color, strokeWidth: 2 }
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
  details?: ComparisonNodeDetail[]
): GraphNodeData {
  return {
    label: name,
    glyph: GLYPH_SYSTEM.getGlyph(name),
    group: GLYPH_SYSTEM.getGroup(name),
    details,
  };
}

function buildComparisonNodeDetail(
  trace: Tracing,
  toolCall: ToolCall,
  step: number,
  traceLabel: string,
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

function formatDetailValue(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return '—';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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
  let runLength = 1;

  const pushRun = (name: string) => {
    const node: GraphNode = {
      id: `${tracing.id}:${nodes.length}`,
      type: 'tool',
      position: {
        x: COLLAPSED_LAYOUT.x,
        y: COLLAPSED_LAYOUT.y + nodes.length * COLLAPSED_LAYOUT.gapY,
      },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      data: buildNodeData(name),
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

    if (runLength > 1) {
      edges.push({
        id: `${node.id}:repeat`,
        type: 'repeat',
        source: node.id,
        target: node.id,
        sourceHandle: null,
        targetHandle: null,
        data: { repeats: runLength - 1 },
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

    pushRun(runName);
    runName = toolCalls[index].name;
    runLength = 1;
  }

  pushRun(runName);

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
  const rootName = names[0];
  const nodeIds = new Map<string, string>();
  const childrenByName = new Map(names.map((name) => [name, [] as string[]]));
  const parentByName = new Map<string, string>();
  const positions = new Map<string, { x: number; y: number; depth: number }>();
  const seen = new Set([rootName]);

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

    let firstColumn = placeNode(children[0], depth + 1);
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
      data: buildNodeData(name),
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

function ComparisonNodeDetails({
  details,
  onClose,
}: {
  details: ComparisonNodeDetail[];
  onClose: () => void;
}) {
  const horizontal = details.length > 1;

  return (
    <div
      className="nodrag nopan relative min-h-[4rem] min-w-[11rem] resize overflow-auto rounded-md border border-zinc-200 bg-white px-1.5 py-1 shadow-sm"
      style={horizontal ? { width: `${details.length * 9}rem` } : undefined}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label="Close details"
        className="nodrag nopan absolute right-1.5 top-1.5 inline-flex h-3.5 w-3.5 items-center justify-center text-zinc-400 transition hover:text-zinc-950"
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
      <div
        className={horizontal ? 'grid gap-1 pr-4' : 'space-y-1 pr-4'}
        style={horizontal ? { gridTemplateColumns: `repeat(${details.length}, minmax(0, 1fr))` } : undefined}
      >
        {details.map((detail) => {
          const status =
            typeof (detail.toolCall as { status?: unknown }).status === 'string'
              ? (detail.toolCall as { status?: string }).status
              : null;

          return (
            <div
              key={`${detail.traceLabel}:${detail.traceId}:${detail.step}`}
              className={
                horizontal
                  ? 'min-w-0 border-l border-zinc-200 pl-1 first:border-l-0 first:pl-0'
                  : 'border-t border-zinc-200 pt-1 first:border-t-0 first:pt-0'
              }
            >
              <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[9px] leading-tight">
                <span className="font-semibold" style={{ color: detail.color }}>
                  Trace {detail.traceLabel}
                </span>
                <span className="text-zinc-500">run #{String(detail.traceId)}</span>
                <span className="text-zinc-500">step {detail.step}</span>
                {status ? <span className="text-zinc-500">status: {status}</span> : null}
              </div>
              <div className="mt-1">
                <pre className="w-full min-w-0 overflow-hidden font-mono text-[9px] leading-tight text-zinc-700 whitespace-pre-wrap break-all">
                  {formatDetailValue(detail.toolCall.args)}
                </pre>
              </div>
              {detail.toolCall.response !== undefined && detail.toolCall.response !== null ? (
                <div className="mt-1">
                  <pre className="w-full min-w-0 overflow-hidden font-mono text-[9px] leading-tight text-zinc-700 whitespace-pre-wrap break-all">
                    {formatDetailValue(detail.toolCall.response)}
                  </pre>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FlowGraph({
  graph,
  graphKey,
  emptyMessage,
  heightClass = 'h-96',
}: {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  graphKey: string;
  emptyMessage: string;
  heightClass?: string;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const [edges, setEdges] = useState(graph.edges);
  const [openNodeIds, setOpenNodeIds] = useState<string[]>([]);

  useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
    setOpenNodeIds([]);
  }, [graph, setNodes]);

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

  if (nodes.length === 0) {
    return <div className="text-sm text-zinc-600">{emptyMessage}</div>;
  }

  return (
    <div className={heightClass}>
      <ReactFlow
        key={graphKey}
        nodes={displayNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => {
          if (!node.data.details?.length) {
            return;
          }

          setOpenNodeIds((current) =>
            current.includes(node.id) ? current : [...current, node.id]
          );
        }}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
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

export { ProvenanceGraphView, TracingComparisonView, renderProvenanceGraph };
export type { GraphMode };
