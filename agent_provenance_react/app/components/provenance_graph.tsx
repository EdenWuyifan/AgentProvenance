'use client';

import { useEffect, useState } from 'react';
import {
  Background,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
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

type GraphNodeData = {
  label: string;
  glyph: string;
  group: string;
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

function buildNodeData(name: string): GraphNodeData {
  return {
    label: name,
    glyph: GLYPH_SYSTEM.getGlyph(name),
    group: GLYPH_SYSTEM.getGroup(name),
  };
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

  const pairs: Array<[number, number, string]> = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j, a[i]]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] > dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return { a, b, pairs };
}

function renderComparisonGraph(traceA: Tracing, traceB: Tracing) {
  const { a, b, pairs } = buildLcsPairs(traceA, traceB);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const sharedNodeIds = pairs.map((_, index) => `${traceA.id}:${traceB.id}:shared:${index}`);
  const sharedXs = pairs.map(
    (_, index) => COMPARE_LAYOUT.x + index * COMPARE_LAYOUT.gapX
  );

  pairs.forEach(([, , name], index) => {
    nodes.push({
      id: sharedNodeIds[index],
      type: 'tool',
      position: {
        x: sharedXs[index],
        y: COMPARE_LAYOUT.y,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: buildNodeData(name),
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
    matchIndexes: number[],
    traceId: Tracing['id'],
    laneY: number,
    colors: typeof TRACE_A_COLORS
  ) => {
    let previousMatch = -1;

    for (let sharedIndex = 0; sharedIndex <= matchIndexes.length; sharedIndex += 1) {
      const nextMatch =
        sharedIndex < matchIndexes.length ? matchIndexes[sharedIndex] : sequence.length;
      const items = sequence.slice(previousMatch + 1, nextMatch);

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

          const id = `${traceId}:compare:${sharedIndex}:${itemIndex}`;

          nodes.push({
            id,
            type: 'tool',
            position: { x, y: laneY },
            sourcePosition: Position.Right,
            targetPosition: Position.Left,
            data: buildNodeData(name),
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

  addBranch(
    a,
    pairs.map(([index]) => index),
    traceA.id,
    COMPARE_LAYOUT.y - COMPARE_LAYOUT.gapY,
    TRACE_A_COLORS
  );
  addBranch(
    b,
    pairs.map(([, index]) => index),
    traceB.id,
    COMPARE_LAYOUT.y + COMPARE_LAYOUT.gapY,
    TRACE_B_COLORS
  );

  if (nodes.length === 0) {
    a.forEach((name, index) => {
      nodes.push({
        id: `${traceA.id}:compare:none:${index}`,
        type: 'tool',
        position: {
          x: COMPARE_LAYOUT.x + index * COMPARE_LAYOUT.gapX,
          y: COMPARE_LAYOUT.y - COMPARE_LAYOUT.gapY,
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        data: buildNodeData(name),
        style: {
          backgroundColor: TRACE_A_COLORS.fill,
          borderColor: TRACE_A_COLORS.border,
        },
      });

      if (index > 0) {
        edges.push({
          id: `${traceA.id}:compare:none:${index - 1}:${index}`,
          type: 'sequential',
          source: `${traceA.id}:compare:none:${index - 1}`,
          target: `${traceA.id}:compare:none:${index}`,
          sourceHandle: null,
          targetHandle: null,
          data: { color: TRACE_A_COLORS.edge },
          markerEnd: EDGE_LAYOUT.markerEnd,
        });
      }
    });

    b.forEach((name, index) => {
      nodes.push({
        id: `${traceB.id}:compare:none:${index}`,
        type: 'tool',
        position: {
          x: COMPARE_LAYOUT.x + index * COMPARE_LAYOUT.gapX,
          y: COMPARE_LAYOUT.y + COMPARE_LAYOUT.gapY,
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        data: buildNodeData(name),
        style: {
          backgroundColor: TRACE_B_COLORS.fill,
          borderColor: TRACE_B_COLORS.border,
        },
      });

      if (index > 0) {
        edges.push({
          id: `${traceB.id}:compare:none:${index - 1}:${index}`,
          type: 'sequential',
          source: `${traceB.id}:compare:none:${index - 1}`,
          target: `${traceB.id}:compare:none:${index}`,
          sourceHandle: null,
          targetHandle: null,
          data: { color: TRACE_B_COLORS.edge },
          markerEnd: EDGE_LAYOUT.markerEnd,
        });
      }
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

  useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
  }, [graph, setNodes]);

  if (nodes.length === 0) {
    return <div className="text-sm text-zinc-600">{emptyMessage}</div>;
  }

  return (
    <div className={heightClass}>
      <ReactFlow
        key={graphKey}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
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
  traceA,
  traceB,
}: {
  traceA: Tracing;
  traceB: Tracing;
}) {
  const graph = renderComparisonGraph(traceA, traceB);

  return (
    <FlowGraph
      graph={graph}
      graphKey={`${traceA.id}:${traceB.id}:compare`}
      emptyMessage="No comparable tool calls."
      heightClass="h-[28rem]"
    />
  );
}

export { ProvenanceGraphView, TracingComparisonView, renderProvenanceGraph };
export type { GraphMode };
