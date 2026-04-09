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
  getBezierPath,
} from '@xyflow/react';
import type { ToolCall, Tracing } from './types';

type GraphNodeData = {
  label: string;
};

type GraphEdgeData = {
  repeats?: number;
};

type GraphNode = Node<GraphNodeData, 'tool'>;
type GraphEdge = Edge<GraphEdgeData, 'repeat' | 'sequential'>;
type GraphNodeProps = NodeProps<GraphNode>;
type GraphEdgeProps = EdgeProps<GraphEdge>;

const NODE_X = 240;
const NODE_Y_START = 48;
const NODE_Y_GAP = 50;

const nodeTypes = { tool: ToolNode };
const edgeTypes = { repeat: RepeatEdge, sequential: SequentialEdge };

function RepeatButton({
  x,
  y,
  repeats,
}: {
  x: number;
  y: number;
  repeats: number;
}) {
  const [open, setOpen] = useState(false);
  const toggleRepeats = () => {};

  return (
    <EdgeLabelRenderer>
      <div
        className="button-edge__label"
        style={{
          position: 'absolute',
          transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
          pointerEvents: 'all',
        }}
      >
        <button
          type="button"
          className="button-edge__button nodrag nopan"
          aria-pressed={open}
          onClick={() => {
            setOpen((value) => !value);
            toggleRepeats();
          }}
        >
          {repeats}
        </button>
      </div>
    </EdgeLabelRenderer>
  );
}

function ToolNode({ data }: GraphNodeProps) {
  return (
    <>
      <Handle type="target" position={Position.Top} />
      {data.label}
      <Handle type="source" position={Position.Bottom} />
    </>
  );
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

  let path = '';
  let labelX = (sourceX + targetX) / 2;
  let labelY = (sourceY + targetY) / 2;

  if (source === target) {
    const radiusX = Math.max(Math.abs(sourceX - targetX) * 0.6, 40);
    const radiusY = 50;
    path = `M ${sourceX} ${sourceY} A ${radiusX} ${radiusY} 0 1 0 ${targetX + 2} ${targetY}`;
    labelX = Math.max(sourceX, targetX) + radiusX * 0.55;
    labelY = Math.min(sourceY, targetY) - radiusY * 0.6;
  } else {
    [path, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
      />
      {typeof repeats === 'number' && <RepeatButton x={labelX} y={labelY} repeats={repeats} />}
    </>
  );
}

function SequentialEdge(props: GraphEdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, markerEnd, data } =
    props;
  const repeats = data?.repeats;
  const path = `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  const labelX = (sourceX + targetX) / 2;
  const labelY = (sourceY + targetY) / 2;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
      />
      {typeof repeats === 'number' && repeats > 1 && (
        <RepeatButton x={labelX} y={labelY} repeats={repeats} />
      )}
    </>
  );
}

function normalizeToolCalls(toolCalls: ToolCall[]) {
  return toolCalls.filter((toolCall) => toolCall?.name?.trim());
}

function renderProvenanceGraph(tracing: Tracing) {
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
      position: { x: NODE_X, y: NODE_Y_START + nodes.length * NODE_Y_GAP },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      data: { label: name },
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
        markerEnd: { type: MarkerType.ArrowClosed },
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
        markerEnd: { type: MarkerType.ArrowClosed },
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

function ProvenanceGraphView({ tracing }: { tracing: Tracing }) {
  const graph = renderProvenanceGraph(tracing);
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const [edges, setEdges] = useState(graph.edges);

  useEffect(() => {
    const nextGraph = renderProvenanceGraph(tracing);
    setNodes(nextGraph.nodes);
    setEdges(nextGraph.edges);
  }, [tracing, setNodes]);

  if (nodes.length === 0) {
    return <div className="text-sm text-zinc-600">No tool calls.</div>;
  }

  return (
    <div className="h-96">
      <ReactFlow
        key={String(tracing.id)}
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

export { ProvenanceGraphView, renderProvenanceGraph };
