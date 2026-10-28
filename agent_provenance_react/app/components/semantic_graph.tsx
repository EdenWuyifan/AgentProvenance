'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ViewportPortal,
  getSmoothStepPath,
  getBezierPath,
  useNodesInitialized,
  useStore,
  getViewportForBounds,
  useNodesState,
  useReactFlow,
  useViewport,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import { connectionPorts } from './graph_ports';
import { exportGraphPng } from './graph_export';
import { stageChronology, layoutChronologicalGroups } from './graph_chronology';
import { createGraphWorkspace, layoutWorkflowLanes, workflowGeometry, workflowSizeSignature, workflowFrameIds, routeOrthogonal, routePath, curvedRoutePath, type Box, type GraphWorkspace, type Point, type WorkflowLayout, type WorkflowNodeContext } from './graph_layout';
import { importanceBackground, importanceMaximum, importanceValue, type ImportanceAxis } from './graph_importance';
import { DEFAULT_GRAPH_FILTERS, GRAPH_VIEW_PRESETS, focusSelection, matchFamilies, workflowOverview, resultFlowSelection, type GraphFilters } from './graph_search';
import { DEFAULT_RUN_RESULT, summarizeRunResults, type RunResultConfig } from './run_result';
import { RunResultControls } from './run_result_controls';
import { InlineProv } from './inline_prov';
import { buildProvCluster, groupProvEntities, layoutProvCluster, type ProvCluster } from './prov_cluster';
import { projectToolStages } from './graph_tool_stages';
import { stageSummary, workflowStageGroups, humanToolTitle, stageParameterCount, type WorkflowStageGroup } from './graph_stages';
import { displayMotifs, type DisplayMotif } from './graph_motifs';
import { GraphLegend } from './graph_legend';
import { workflowCurve, cubicPath, type CubicCurve } from './workflow_curve';
import { actionBelongsToGraph, graphScope, type GraphCommand, type GraphHighlight, type GraphViewState } from './graph_controls';
import { JsonField } from './tool_call_tooltip';
import type {
  ActivityNode,
  AgentDag,
  EntityNode,
  JoinedProvenanceEdge,
  JoinedProvenanceGraph,
  JoinedProvenanceNode,
  ToolCall,
  Tracing,
  WorkflowInsights,
} from './types';

type DisplayGroup = DisplayMotif | WorkflowStageGroup;

type InspectorTab = 'overview' | 'importance' | 'calls' | 'connections';
type OperationGroup = JoinedProvenanceNode['operationGroups'][number];
type OperationMember = OperationGroup['members'][number];
type OperationMemberView = {
  member: OperationMember;
  dag: AgentDag;
  activity: ActivityNode;
  call: ToolCall;
  outputs: EntityNode[];
};
type Inspectable =
  | { kind: 'family'; family: JoinedProvenanceNode }
  | { kind: 'operation'; family: JoinedProvenanceNode; operation: OperationGroup; members: OperationMemberView[] }
  | { kind: 'connection'; edge: JoinedProvenanceEdge; witness?: JoinedProvenanceEdge['witnesses'][number]; rawEdges?: AgentDag['edges']; dag?: AgentDag; rawEdgeWitnesses?: Array<{ run: string; edges: AgentDag['edges']; dag: AgentDag }> };

type SemanticNodeData =
  | {
      kind: 'family';
      motif?: DisplayGroup;
      variedImportance?: boolean;
      summary: ReturnType<typeof stageSummary>;
      runResult:ReturnType<typeof summarizeRunResults>;
      onProv: () => void;
      inlineProv?: {resultConfig:RunResultConfig;cluster:ProvCluster;traceDags:Record<string,AgentDag>;traces:Tracing[];highlightRun?:string;includeSupporting:boolean;onSupporting:()=>void};
      label: string;
      intent: string;
      subject?: string;
      comparison?: string;
      sourceLabel?: string;
      decision: JoinedProvenanceNode['importance']['decision'];
      semanticLevel: 'key' | 'supporting' | 'unknown';
      resultStatus: JoinedProvenanceNode['importance']['result']['status'];
      scoreSignal: boolean;
      failure: boolean;
      recordedOutcome: boolean;
      supportCount: number;
      totalTraceCount: number;
      resultBackbone: boolean;
      directResult: boolean;
      supportTraces: string[];
      callCount: number;
      toolNames: string[];
      toolTitle: string;
      parameterVariantCount: number;
      occurrenceCount: number;
      stepRange: string;
      occurrences: string[];
      expandable: boolean;
      expanded: boolean;
      promoted: boolean;
      presentation: 'point' | 'compact' | 'card' | 'publication';
      background: string;
      importanceLabel: string;
      onToggle: () => void;
      inspectable: Inspectable;
      workflowContext?: WorkflowNodeContext;
      workflowMode?: boolean;
      workflowLabel?: string;
      workflowSummary?: string;
      eventCount?: number;
      workflowCategory?: string;
      assessmentStatus?: string;
      assessmentReason?: string;
      assessedSupportCount?: number;
      keySupportCount?: number;
    }
  | {
      kind: 'operation';
      label: string;
      sublabel: string;
      supportCount: number;
      totalTraceCount: number;
      supportTraces: string[];
      callCount: number;
      semanticLevel: 'key' | 'supporting' | 'unknown';
      background: string;
      failure: boolean;
      workflowMode?: boolean;
      inspectable: Inspectable;
    };

type SemanticNode = Node<SemanticNodeData>;
type SemanticEdgeData = {
  relation?: string;
  inferred: boolean;
  inferenceKind?: 'recorded' | 'inferred' | 'mixed';
  resultPath?: boolean;
  critical?: boolean;
  shared?: boolean;
  resultPathTraces?: string[];
  supportTraces: string[];
  semanticEdge?: JoinedProvenanceEdge;
  memberEdges?: JoinedProvenanceEdge[];
  witness?: JoinedProvenanceEdge['witnesses'][number];
  rawEdges?: AgentDag['edges'];
  dag?: AgentDag;
  rawEdgeWitnesses?: Array<{ run: string; edges: AgentDag['edges']; dag: AgentDag }>;
  relevance?: 'relevant' | 'context' | 'unknown';
  jointGroupIds?: string[];
  route?: Point[];
  curve?: CubicCurve;
  portDeltas?: {source:Point;target:Point};
  edgeLabel?:string;
};
type SemanticEdge = Edge<SemanticEdgeData>;
type TraceColor = { edge: string; pale: string };

const TRACE_COLORS: TraceColor[] = [
  { edge: '#0284c7', pale: '#e0f2fe' },
  { edge: '#ea580c', pale: '#ffedd5' },
  { edge: '#16a34a', pale: '#dcfce7' },
  { edge: '#7c3aed', pale: '#ede9fe' },
];
const FAILURE_BORDER = '#dc2626';
const FAILURE_BACKGROUND = '#fef2f2';
const RESULT_PATH_COLOR = '#2563eb';

const COLLAPSED_SIZE = { width: 208, height: 76 };
const PUBLICATION_SIZE = { width: 224, height: 100 };
const COMPACT_SIZE = { width: 208, height: 76 };
const WORKFLOW_CARD_SIZE = { width: 272, height: 144 };
const WORKFLOW_FIT_PADDING = { top: '96px', right: '36px', bottom: '28px', left: '216px' } as const;
const SUPPORTING_DOT_SIZE = { width: 28, height: 28 };
const ARROW = { type: MarkerType.ArrowClosed, width: 11, height: 11, markerUnits: 'userSpaceOnUse', strokeWidth: 1 };
const WORKFLOW_ARROW = { ...ARROW, width: 7, height: 7 };
const CONTEXT_ARROW = { ...ARROW, width: 5, height: 5 };

function traceColor(index: number): TraceColor {
  const color = TRACE_COLORS[index];
  if (color) return color;
  const hue = (index * 137.508) % 360;
  return { edge: `hsl(${hue} 70% 42%)`, pale: `hsl(${hue} 86% 95%)` };
}

function toolHeading(family: JoinedProvenanceNode) {
  const names = [...new Set(family.instances.flatMap((instance) => instance.calls.map((call) => call.tool)))];
  return names.length > 2 ? `${names.slice(0, 2).join(' · ')} +${names.length - 2}` : names.join(' · ');
}

function workflowBehavior(family: JoinedProvenanceNode) {
  const kind = family.semanticRole.toLowerCase().replaceAll('-', '_');
  if (kind === 'information_reception') return 'Receive';
  if (kind === 'information_publication') return 'Publish';
  if (kind === 'experiment') return 'Experiment';
  return 'Event';
}

function semanticLevelLabel(level: 'key' | 'supporting' | 'unknown') {
  return level === 'key' ? 'Key analysis' : level === 'supporting' ? 'Supporting' : 'Unreviewed / uncertain';
}

function relationLabel(relation: string) {
  if (relation === 'present_in_prompt') return 'Present in prompt · exposure, not a causal handoff';
  if (relation === 'delivered_to') return 'Delivered to · exposure, not a causal handoff';
  if (relation === 'used_shared_evidence') return 'Present in decision context · contextual match';
  if (relation === 'used_local_evidence') return 'Present in local context · contextual match';
  return relation;
}

function supportLeftBorder(supportCount: number) {
  return Math.min(25, 5 + Math.max(0, supportCount - 1) * 4);
}

function supportEdgeWidth(supportCount: number, resultPath: boolean) {
  return Math.min(8.5, 1.5 + Math.max(0, supportCount - 1) * 1.75) + (resultPath ? 0.5 : 0);
}

function sourceDisplayLabel(label: string) {
  return label.length > 20 ? `…${label.slice(-19)}` : label;
}

function instanceSubject(family: JoinedProvenanceNode) {
  const boundSubjects = family.variants.flatMap((variant) => Object.entries(variant.roleBindings)
    .filter(([key, value]) => /subject|target|gene|dataset|query|input/i.test(key) && typeof value === 'string' && value.trim())
    .map(([, value]) => String(value).replace(/[_-]+/g, ' ')));
  const parameterSubjects = family.variants.flatMap((variant) => {
    const values: string[] = [];
    const visit = (value: unknown, key = '') => {
      if (Array.isArray(value)) {
        value.forEach((entry) => visit(entry, key));
      } else if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (typeof record.column === 'string' && /gene|pathway|term|target|subject/i.test(record.column) && typeof record.value === 'string') values.push(record.value);
        Object.entries(record).forEach(([childKey, child]) => visit(child, childKey));
      } else if (typeof value === 'string' && /^(gene_list|genes|term|query|pathway|subject|target|context_term|disease)$/i.test(key) && !/^<.*>$/.test(value)) {
        values.push(value);
      }
    };
    visit(variant.parameters);
    return values;
  });
  const subjects = [...new Set([...boundSubjects, ...parameterSubjects].map((value) => value.trim()).filter(Boolean))];
  return subjects.length <= 3 ? subjects.join(', ') : `${subjects.slice(0, 3).join(', ')} +${subjects.length - 3}`;
}

function entitySummary(node: EntityNode) {
  const response = node.response;
  if (Array.isArray(response)) return `${response.length} items`;
  if (response && typeof response === 'object') {
    const value = response as Record<string, unknown>;
    const rows = value.row_count ?? value.rowCount ?? value.total_rows ?? value.rows;
    if (typeof rows === 'number') {
      const storage = value.storage_entry && typeof value.storage_entry === 'object' ? value.storage_entry as Record<string, unknown> : undefined;
      const storedName = storage?.name;
      return `${rows} rows${typeof storedName === 'string' ? ` · ${storedName.split(/[\\/]/).at(-1)}` : ''}`;
    }
    const status = value.status;
    if (typeof status === 'string') return status;
    const name = value.name ?? value.filename ?? value.path;
    if (typeof name === 'string') return name.split(/[\\/]/).at(-1) ?? name;
  }
  return node.entityType;
}

function getLevels(ids: string[], edges: Array<{ source: string; target: string }>) {
  const levels = new Map(ids.map((id) => [id, 0]));
  const incoming = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, [] as string[]]));
  edges.forEach(({ source, target }) => {
    if (!incoming.has(source) || !incoming.has(target) || source === target) return;
    incoming.set(target, (incoming.get(target) ?? 0) + 1);
    outgoing.get(source)?.push(target);
  });
  const queue = ids.filter((id) => incoming.get(id) === 0);
  const placed = new Set<string>();
  let cursor = 0;
  const drain = () => {
    while (cursor < queue.length) {
      const id = queue[cursor++];
      if (placed.has(id)) continue;
      placed.add(id);
      for (const target of outgoing.get(id) ?? []) {
        if (placed.has(target)) continue;
        levels.set(target, Math.max(levels.get(target) ?? 0, (levels.get(id) ?? 0) + 1));
        incoming.set(target, (incoming.get(target) ?? 0) - 1);
        if (incoming.get(target) === 0) queue.push(target);
      }
    }
  };
  drain();
  ids.forEach((id) => {
    if (!placed.has(id)) {
      queue.push(id);
      drain();
    }
  });
  return levels;
}

function dagFor(traceDags: Record<string, AgentDag>, run: string) {
  return traceDags[run]!;
}

function resultPathEdges(dag: AgentDag, instance: JoinedProvenanceNode['instances'][number]) {
  const activities = dag.nodes.filter((node): node is ActivityNode => node.kind === 'Activity');
  const byCall = new Map(activities.map((node) => [node.toolCallId, node.id]));
  const incoming = new Map<string, AgentDag['edges']>();
  dag.edges.forEach((edge) => incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]));
  const queue = instance.resultTargets.flatMap((callId) => byCall.has(callId) ? [byCall.get(callId)!] : []);
  const seen = new Set(queue);
  const pathEdges = new Set<string>();
  while (queue.length) {
    const target = queue.shift()!;
    for (const edge of incoming.get(target) ?? []) {
      pathEdges.add(`${edge.source}\0${edge.target}`);
      if (!seen.has(edge.source)) {
        seen.add(edge.source);
        queue.push(edge.source);
      }
    }
  }
  return pathEdges;
}

function activityForCall(dag: AgentDag, callId: string) {
  return dag.nodes.find((node): node is ActivityNode => node.kind === 'Activity' && node.toolCallId === callId)!;
}

function operationMemberView(
  member: OperationMember,
  traceDags: Record<string, AgentDag>,
  traces: Tracing[],
): OperationMemberView {
  const trace = traces.find((candidate) => String(candidate.id) === member.run)!;
  const dag = dagFor(traceDags, member.run);
  const activity = activityForCall(dag, member.callId);
  return {
    member,
    dag,
    activity,
    call: trace.toolCalls[member.step - 1]!,
    outputs: member.outputEntityIds.map((id) => dag.nodes.find((node): node is EntityNode => node.id === id && node.kind === 'Entity')!),
  };
}

function operationLane(
  family: JoinedProvenanceNode,
  traceDags: Record<string, AgentDag>,
  traces: Tracing[],
  axis: ImportanceAxis,
  maximum: number,
  workflowMode = false,
) {
  const operations = [...family.operationGroups].sort((a, b) => Math.min(...a.members.map((m) => m.step)) - Math.min(...b.members.map((m) => m.step)) || a.id.localeCompare(b.id)).map((operation) => ({
    operation,
    members: operation.members.map((member) => operationMemberView(member, traceDags, traces)),
  }));
  const callToOperation = new Map<string, string>();
  operations.forEach(({ operation }) => operation.members.forEach((member) => callToOperation.set(`${member.run}\0${member.callId}`, operation.id)));
  const edgeMap = new Map<string, { source: string; target: string; supportTraces: string[]; resultPathTraces: string[]; evidence: Array<{ run: string; edges: AgentDag['edges']; dag: AgentDag }> }>();
  operations.forEach(({ operation }) => operation.members.forEach((member) => {
    member.inputEntityIds.forEach((inputId) => {
      const producer = operations.find(({ operation: candidate }) => candidate.members.some((sourceMember) => sourceMember.run === member.run && sourceMember.outputEntityIds.includes(inputId)));
      if (!producer || producer.operation.id === operation.id) return;
      const dag = dagFor(traceDags, member.run);
      const sourceActivity = activityForCall(dag, producer.operation.members.find((sourceMember) => sourceMember.run === member.run && sourceMember.outputEntityIds.includes(inputId))!.callId);
      const targetActivity = activityForCall(dag, member.callId);
      const rawEdges = dag.edges.filter((edge) => (edge.source === sourceActivity.id && edge.target === inputId && edge.relation === 'generatedBy') || (edge.source === inputId && edge.target === targetActivity.id && edge.relation === 'usedBy'));
      if (!rawEdges.some((edge) => edge.relation === 'generatedBy') || !rawEdges.some((edge) => edge.relation === 'usedBy')) return;
      const key = `${producer.operation.id}\0${operation.id}`;
      const instance = family.instances.find((candidate) => candidate.run === member.run && candidate.calls.some((call) => call.id === member.callId))!;
      const pathEdges = resultPathEdges(dag, instance);
      const current = edgeMap.get(key) ?? { source: producer.operation.id, target: operation.id, supportTraces: [], resultPathTraces: [], evidence: [] };
      if (rawEdges.every((edge) => pathEdges.has(`${edge.source}\0${edge.target}`)) && !current.resultPathTraces.includes(member.run)) current.resultPathTraces.push(member.run);
      if (!current.supportTraces.includes(member.run)) current.supportTraces.push(member.run);
      current.evidence.push({ run: member.run, edges: rawEdges, dag });
      edgeMap.set(key, current);
    });
  }));
  const operationEdges = Array.from(edgeMap.values());
  const levels = getLevels(operations.map(({ operation }) => operation.id), operationEdges);
  const rows = new Map<number, number>();
  const parallelColumns = workflowMode && !operationEdges.length ? Math.min(3, operations.length) : 0;
  const columnWidths = Array.from({ length: parallelColumns || Math.max(...Array.from(levels.values()), 0) + 1 }, () => 240);
  const columnX: number[] = [];
  columnWidths.forEach((width, index) => { columnX[index] = index === 0 ? 24 : columnX[index - 1] + columnWidths[index - 1] + 36; });
  const children: SemanticNode[] = [];
  const edges: SemanticEdge[] = [];
  const heightByLevel = new Map<number, number>();
  operations.forEach(({ operation, members }, index) => {
    const level = parallelColumns ? index % parallelColumns : levels.get(operation.id) ?? 0;
    const rowY = rows.get(level) ?? 0;
    const failed = operation.failure;
    const memberRuns = [...new Set(operation.members.map((member) => member.run))];
    const x = columnX[level];
    const y = 80 + rowY;
    const id = `operation:${family.id}:${operation.id}`;
    const operationInspectable: Inspectable = { kind: 'operation', family, operation, members };
    children.push({
      id, type: 'semanticOperation', parentId: family.id, extent: 'parent',
      position: { x, y }, style: { width: 216, height: 64, padding: 0, border: 'none', background: 'transparent', boxShadow: 'none' },
      data: {
        kind: 'operation', label: operation.tool,
        sublabel: operation.parameterVariants.length ? `${operation.parameterVariants.length} parameter variant${operation.parameterVariants.length === 1 ? '' : 's'}` : `Steps ${Math.min(...operation.members.map((member) => member.step))}–${Math.max(...operation.members.map((member) => member.step))}`,
        supportCount: memberRuns.length, totalTraceCount: traces.length, callCount: operation.members.length, semanticLevel: workflowMode ? family.assessment!.level : family.importance.semantic.level,
        supportTraces: memberRuns,
        background: importanceBackground(importanceValue(family, axis, operation.tool), maximum),
        failure: failed, workflowMode, inspectable: operationInspectable,
      },
    });
    const rowHeight = 86;
    rows.set(level, rowY + rowHeight);
    heightByLevel.set(level, (heightByLevel.get(level) ?? 0) + rowHeight);
  });
  operationEdges.forEach((edge) => {
    const rawEdgeWitnesses = edge.evidence;
    const supportTraces = [...new Set(edge.supportTraces)];
    const dependencyKinds = rawEdgeWitnesses.flatMap(({ edges: raw }) => raw
      .filter((item) => item.relation === 'usedBy')
      .map((item) => Boolean(item.inferred)));
    const inferredCount = dependencyKinds.filter(Boolean).length;
    const inferenceKind = inferredCount === dependencyKinds.length ? 'inferred' : inferredCount ? 'mixed' : 'recorded';
    edges.push({
      id: `operation-flow:${family.id}:${edge.source}:${edge.target}`,
      source: `operation:${family.id}:${edge.source}`, target: `operation:${family.id}:${edge.target}`,
      type: 'workflow', markerEnd: ARROW,
      data: {
        inferred: inferenceKind === 'inferred', inferenceKind,
        relation: 'operation flow', supportTraces, rawEdgeWitnesses,
        resultPathTraces: edge.resultPathTraces, resultPath: edge.resultPathTraces.length > 0,
      },
    });
  });
  return {
    nodes: children,
    edges,
    width: columnWidths.reduce((sum, width) => sum + width, 0) + Math.max(0, columnWidths.length - 1) * 36 + 48,
    height: Math.max(176, ...Array.from(heightByLevel.values()).map((height) => height + 148)),
    operationByCall: callToOperation,
  };
}

function semanticGraph(
  graph: JoinedProvenanceGraph,
  expandedFamilies: Set<string>,
  traceDags: Record<string, AgentDag>,
  traces: Tracing[],
  selectedTraceId: string | undefined,
  onToggle: (familyId: string) => void,
  onProv: (id: string) => void,
  axis: ImportanceAxis,
  focusedFamilies: Set<string>|undefined,
  publication: boolean,
  resultConfig:RunResultConfig,
) {
  const workflow = (graph as JoinedProvenanceGraph & { workflow?: WorkflowLayout }).workflow;
  const familySummaries = new Map(graph.nodes.map(family => [family.id, stageSummary([family], traces)]));
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const graphNodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const contexts = new Map(graph.nodes.flatMap((node) => {
    const context = (node as JoinedProvenanceNode & { executionContext?: WorkflowNodeContext }).executionContext;
    return context ? [[node.id, context] as const] : [];
  }));
  const summaries = new Map(graph.nodes.flatMap((node) => {
    const summary = (node as JoinedProvenanceNode & { eventSummary?: { eventCount: number; diagnostics: string[]; outcomes: Array<{ name: string; value: number }> } }).eventSummary;
    return summary ? [[node.id, summary] as const] : [];
  }));
  const assessments = new Map(graph.nodes.flatMap((node) => {
    const assessment = node.assessment;
    return assessment ? [[node.id, assessment] as const] : [];
  }));
  const graphEdges = graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  const labelCounts = new Map<string, number>();
  graph.nodes.forEach((node) => labelCounts.set(node.label, (labelCounts.get(node.label) ?? 0) + 1));
  const comparisonLabels = new Map<string, string>();
  if (!workflow) graph.nodes.filter((node) => !node.source && labelCounts.get(node.label)! > 1).forEach((node) => {
    const parents = [...new Set(graphEdges.filter((edge) => edge.target === node.id && edge.witnesses.some((witness) => !witness.inferred))
      .map((edge) => graphNodesById.get(edge.source)!).map((parent) => parent.source ? 'original input' : parent.label))];
    const peers = graph.nodes.filter((other) => other.label === node.label);
    const parameters = node.operationGroups.flatMap((operation) => operation.parameterVariants.map((variant) => variant.parameters as Record<string, unknown>));
    const peerParameters = peers.flatMap((peer) => peer.operationGroups.flatMap((operation) => operation.parameterVariants.map((variant) => variant.parameters as Record<string, unknown>)));
    const differences = [...new Set(parameters.flatMap((params) => Object.entries(params)
      .filter(([key, value]) => value !== '<artifact>' && value !== '<location>' && peerParameters.some((peer) => JSON.stringify(peer[key]) !== JSON.stringify(value)))
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value)}`)))];
    comparisonLabels.set(node.id, [...(parents.length ? [`Input: ${parents.join(' + ')}`] : []), ...differences].join(' · '));
  });
  const finalOutcomeCalls = new Set((graph.structuredOutcomes ?? []).flatMap(({ run, outcomes }) => outcomes
    .filter((outcome) => outcome.scope !== 'participant' && (outcome.terminal || outcome.kind === 'final'))
    .map((outcome) => `${run}\0${outcome.eventId}`)));
  const eventCount = (family: JoinedProvenanceNode) => Math.max(family.eventSummary?.eventCount ?? 0,
    family.instances.reduce((count, instance) => count + instance.calls.length, 0), family.instances.length);
  const hasRecordedOutcome = (family: JoinedProvenanceNode) => family.instances.some((instance) =>
    instance.resultTargets.length > 0 || instance.calls.some((call) => finalOutcomeCalls.has(`${instance.run}\0${call.id}`)))
    || Boolean(family.eventSummary?.outcomes.length);
  const hasDirectResult = (family: JoinedProvenanceNode) => hasRecordedOutcome(family)
    || family.importance.result.status === 'supported' || family.importance.result.status === 'contradicted';
  const hasFailure = (family: JoinedProvenanceNode) => family.importance.tier === 'failure'
    || familySummaries.get(family.id)!.errors > 0;
  const hasReviewedFlow = (family: JoinedProvenanceNode) => family.importance.facets.some((facet) => facet.id === 'reviewed-flow');
  const firstStep = (family: JoinedProvenanceNode) => Math.min(...family.instances.flatMap((instance) => instance.calls.map((call) => call.step)), Infinity);
  const orderedFamilies = [...graph.nodes].sort((a, b) => firstStep(a) - firstStep(b) || a.label.localeCompare(b.label));
  const maximum = importanceMaximum(graph, axis);
  const expandedGroups = new Set(graph.nodes.filter((family) => workflow && (family.operationGroups.length > 1
    || workflow && eventCount(family) > 1)
    && expandedFamilies.has(family.id)).map((family) => family.id));
  const expandedContents = new Map<string, ReturnType<typeof operationLane>>();
  const groupSizes = new Map<string, { width: number; height: number }>();
  const presentations = new Map<string, 'point' | 'compact' | 'card' | 'publication'>();
  graph.nodes.forEach((family) => {
    const assessment = assessments.get(family.id);
    const assessmentLevel = assessment?.level === 'key' || assessment?.level === 'supporting' || assessment?.level === 'unknown'
      ? assessment.level : workflow ? 'unknown' : family.importance.semantic.level;
    if (!expandedGroups.has(family.id)) {
      const input = Boolean(family.source);
      const inputPoint = input && !hasFailure(family);
      if (publication && !workflow && !inputPoint) {
        presentations.set(family.id, 'publication');
        groupSizes.set(family.id, PUBLICATION_SIZE);
        return;
      }
      const point = inputPoint || !workflow && assessmentLevel === 'supporting' && family.methods.length>1 && eventCount(family) > 1 && !hasFailure(family) || Boolean(workflow) && assessmentLevel !== 'key' && !hasDirectResult(family)
        && !hasFailure(family) && !hasReviewedFlow(family) && !focusedFamilies?.has(family.id);
      const compact = !workflow && !hasFailure(family) && !focusedFamilies?.has(family.id)
        && (input || !hasDirectResult(family) && !family.resultBackbone
          && (assessmentLevel !== 'key' || traces.length > 1 && family.supportTraces.length === 1
            && family.instances.length === 1 && family.operationGroups.length === 1));
      presentations.set(family.id, point ? 'point' : compact ? 'compact' : 'card');
      groupSizes.set(family.id, point ? SUPPORTING_DOT_SIZE : compact ? COMPACT_SIZE : workflow ? WORKFLOW_CARD_SIZE : COLLAPSED_SIZE);
      return;
    }
    const lane = operationLane(family, traceDags, traces, axis, maximum, Boolean(workflow));
    expandedContents.set(family.id, lane);
    groupSizes.set(family.id, {
      width: Math.max(COLLAPSED_SIZE.width, lane.width + 24),
      height: lane.height,
    });
  });
  const groupNodes: SemanticNode[] = orderedFamilies.map((family) => {
    const assessment = assessments.get(family.id);
    const assessmentLevel = assessment?.level === 'key' || assessment?.level === 'supporting' || assessment?.level === 'unknown'
      ? assessment.level : workflow ? 'unknown' : family.importance.semantic.level;
    const size = groupSizes.get(family.id)!;
    const sourceLabel = family.source?.label ?? family.instances.find((instance) => instance.source)?.source?.label;
    const groupEventCount = eventCount(family);
    const directResult = hasDirectResult(family);
    const failure = hasFailure(family);
    const expandable = family.operationGroups.length > 1 || Boolean(workflow && groupEventCount > 1);
    const presentation = presentations.get(family.id) ?? 'card';
    const supportingDot = presentation === 'point';
    const supportCount = new Set(family.supportTraces).size;
    const operation = family.operationGroups.length === 1 ? family.operationGroups[0] : undefined;
    return {
      id: family.id,
      type: 'semanticFamily',
      position: { x: 0, y: 0 },
      style: {
        width: size.width,
        height: size.height,
        padding: 0,
        border: 'none',
        borderRadius: supportingDot ? '50%' : 12,
        background: workflow && supportingDot ? 'transparent' : family.importance.tier === 'failure' ? FAILURE_BACKGROUND : workflow && axis === 'semantic' ? assessmentLevel === 'key' ? '#e8edff' : assessmentLevel === 'supporting' ? '#f3f6fc' : '#ffffff' : importanceBackground(importanceValue(family, axis), maximum),
        boxShadow: workflow ? 'none' : supportingDot ? '0 1px 5px rgb(15 23 42 / 0.16)' : '0 3px 14px rgb(15 23 42 / 0.08)',
      },
      data: {
        kind: 'family',
        summary: familySummaries.get(family.id)!,
        runResult:summarizeRunResults(family.supportTraces,traces,resultConfig),
        parameterVariantCount:stageParameterCount([family]),
        onProv: () => onProv(family.id),
        label: workflow ? assessment?.semanticLabel || family.label || 'Workflow event' : toolHeading(family),
        intent: sourceLabel ? 'Input' : family.label,
        subject: sourceLabel ? sourceDisplayLabel(sourceLabel) : instanceSubject(family),
        comparison: comparisonLabels.get(family.id),
        sourceLabel,
        decision: family.importance.decision,
        semanticLevel: workflow ? (assessment?.level === 'key' || assessment?.level === 'supporting' || assessment?.level === 'unknown' ? assessment.level : 'unknown') : family.importance.semantic.level,
        resultStatus: family.importance.result.status,
        scoreSignal: family.importance.facets.some((facet) => facet.id === 'predictive-focus'),
        failure,
        recordedOutcome: hasRecordedOutcome(family),
        supportCount,
        totalTraceCount: traces.length,
        resultBackbone: workflow ? hasReviewedFlow(family) : family.resultBackbone,
        directResult,
        supportTraces: family.supportTraces,
        callCount: family.instances.reduce((count, instance) => count + instance.calls.length, 0),
        toolNames: [...new Set(family.instances.flatMap((instance) => instance.calls.map((call) => call.tool)))],
        toolTitle: family.methods.length===1?humanToolTitle(family.methods[0],graph.nodes.flatMap(node=>node.methods)):toolHeading(family),
        occurrenceCount: family.instances.length,
        stepRange: (() => {
          const steps = family.instances.flatMap((instance) => instance.calls.map((call) => call.step));
          return steps.length ? `Steps ${Math.min(...steps)}–${Math.max(...steps)}` : '';
        })(),
        occurrences: family.instances.map((instance) => {
          const steps = instance.calls.map((call) => call.step);
          const tools = [...new Set(instance.calls.map((call) => call.tool))].join(' · ');
          return `Run ${instance.run} · Steps ${Math.min(...steps)}–${Math.max(...steps)} · ${tools}`;
        }),
        expandable,
        expanded: expandedGroups.has(family.id),
        promoted: Boolean(focusedFamilies?.has(family.id)),
        presentation,
        background: family.importance.tier === 'failure' ? FAILURE_BACKGROUND : workflow && axis === 'semantic' ? assessmentLevel === 'key' ? '#e8edff' : assessmentLevel === 'supporting' ? '#f3f6fc' : '#ffffff' : importanceBackground(importanceValue(family, axis), maximum),
        importanceLabel: workflow ? '' : axis === 'outcome' ? importanceValue(family, axis) === null ? 'O —' : `O ${importanceValue(family, axis)!.toFixed(3)}σ`
          : axis === 'evidence' ? `${importanceValue(family, axis)} claims` : '',
        onToggle: () => onToggle(family.id),
        inspectable: operation && !workflow ? { kind: 'operation', family, operation, members: operation.members.map((member) => operationMemberView(member, traceDags, traces)) } : { kind: 'family', family },
        workflowContext: contexts.get(family.id),
        workflowMode: Boolean(workflow),
        workflowCategory: workflow ? workflowBehavior(family) : undefined,
        assessmentStatus: assessment?.status,
        assessmentReason: assessment?.reason,
        assessedSupportCount: assessment?.assessedSupportCount,
        keySupportCount: assessment?.keySupportCount,
        eventCount: groupEventCount,
        workflowLabel: workflow?.lanes.find((lane) => lane.id === contexts.get(family.id)?.laneId)?.label,
        workflowSummary: (() => { const summary = summaries.get(family.id); if (!summary) return ''; return [summary.diagnostics.slice(0, 1).join(', '), summary.outcomes.slice(0, 2).map((outcome) => `${outcome.name} ${outcome.value}`).join(' · ')].filter(Boolean).join(' · '); })(),
      },
    };
  });
  const childNodes = Array.from(expandedContents.values()).flatMap((lane) => lane.nodes);
  const internalEdges = Array.from(expandedContents.values()).flatMap((lane) => lane.edges);
  const operationByCall = new Map<string, { familyId: string; operationId: string }>();
  expandedContents.forEach((lane, familyId) => lane.operationByCall.forEach((operationId, callKey) => {
    operationByCall.set(callKey, { familyId, operationId });
  }));
  const crossEdgesByKey = new Map<string, SemanticEdge>();
  graphEdges.forEach((edge) => {
    edge.witnesses.forEach((witness) => {
      const sourceFamily = graphNodesById.get(edge.source)!;
      const targetFamily = graphNodesById.get(edge.target)!;
      const expandedSource = expandedGroups.has(sourceFamily.id);
      const expandedTarget = expandedGroups.has(targetFamily.id);
      const path = witness.callPath;
      let source = sourceFamily.id;
      let target = targetFamily.id;
      const sourceOperation = operationByCall.get(`${witness.run}\0${path[0]}`);
      const targetOperation = operationByCall.get(`${witness.run}\0${path[path.length - 1]}`);
      if (expandedSource && sourceOperation) source = `operation:${sourceFamily.id}:${sourceOperation.operationId}`;
      if (expandedTarget && targetOperation) target = `operation:${targetFamily.id}:${targetOperation.operationId}`;
      const bucketKey = `${edge.id}:${source}:${target}`;
      const current = crossEdgesByKey.get(bucketKey);
      if (current) {
        current.data!.semanticEdge!.witnesses.push(witness);
        if (!current.data!.supportTraces.includes(witness.run)) current.data!.supportTraces.push(witness.run);
        current.data!.inferred = current.data!.inferred || witness.inferred;
        current.data!.resultPath = current.data!.resultPath || witness.highlighted;
        current.data!.semanticEdge!.inferred = current.data!.inferred;
        current.data!.semanticEdge!.supportCount = current.data!.supportTraces.length;
        current.data!.semanticEdge!.supportTraces = current.data!.supportTraces;
        const inferredCount = current.data!.semanticEdge!.witnesses.filter((item) => item.inferred).length;
        current.data!.inferenceKind = inferredCount === current.data!.semanticEdge!.witnesses.length ? 'inferred' : inferredCount ? 'mixed' : 'recorded';
      } else {
        const supportTraces = [witness.run];
        const id = `semantic:${edge.id}:${bucketKey}`;
        crossEdgesByKey.set(bucketKey, {
          id,
          source,
          target,
          type: 'workflow',
          markerEnd: ARROW,
          data: {
            inferred: witness.inferred,
            inferenceKind: witness.inferred ? 'inferred' : 'recorded',
            resultPath: witness.highlighted,
            supportTraces,
            witness,
            semanticEdge: { ...edge, witnesses: [witness], supportTraces, supportCount: supportTraces.length, inferred: witness.inferred },
          },
        });
      }
    });
  });
  const crossEdges = Array.from(crossEdgesByKey.values());
  const dimmedGroups = selectedTraceId
    ? groupNodes.map((node) => {
        if (node.data.kind !== 'family') return node;
        return {
          ...node,
          style: {
            ...node.style,
            opacity: node.data.supportTraces.includes(selectedTraceId) ? 1 : 0.12,
          },
        };
      })
    : groupNodes;
  const dimmedChildren = childNodes.map((node) => {
    if (node.data.kind === 'family' || !selectedTraceId) return node;
    const supportTraces = node.data.supportTraces;
    return { ...node, style: { ...node.style, opacity: supportTraces.includes(selectedTraceId) ? 1 : 0.12 } };
  });
  const allNodes = [...dimmedGroups, ...dimmedChildren];
  const edges = [...internalEdges, ...crossEdges].map((edge) => {
    const supportTraces = [...new Set(edge.data?.supportTraces ?? [])];
    const shared = supportTraces.length > 1;
    const selectedSupport = selectedTraceId ? supportTraces.includes(selectedTraceId) : false;
    const selectedResultPath = selectedTraceId
      ? Boolean(edge.data?.semanticEdge?.witnesses.some((witness) => witness.run === selectedTraceId && witness.highlighted)
        || (selectedSupport && (edge.data?.resultPathTraces?.includes(selectedTraceId) ?? false)))
      : Boolean(edge.data?.resultPath);
    const witnesses = edge.data?.semanticEdge?.witnesses ?? [];
    const jointGroupIds = [...new Set(witnesses.flatMap((witness) => witness.jointGroupIds ?? []))];
    const relevance: SemanticEdgeData['relevance'] = witnesses.some((witness) => witness.relevance === 'relevant') ? 'relevant'
      : witnesses.some((witness) => witness.relevance === 'context') ? 'context' : 'unknown';
    const critical = selectedResultPath || relevance === 'relevant' || jointGroupIds.length > 0;
    const strong = critical || shared;
    const inferenceKind = edge.data?.inferenceKind ?? 'recorded';
    return {
      ...edge,
      markerEnd: workflow ? strong ? WORKFLOW_ARROW : CONTEXT_ARROW : ARROW,
      ariaLabel: `${supportTraces.length} supporting traces · ${inferenceKind === 'mixed' ? 'recorded support with inferred supplements' : inferenceKind === 'inferred' ? 'inferred support only' : 'recorded support'}`,
      data: { ...edge.data!, critical, shared, relevance, jointGroupIds },
      style: {
        ...edge.style,
        stroke: selectedTraceId && !selectedSupport ? '#cbd5e1' : strong ? RESULT_PATH_COLOR : workflow ? relevance === 'unknown' ? '#cbd5e1' : '#94a3b8' : '#64748b',
        strokeWidth: workflow && !strong ? Math.min(1.6, supportEdgeWidth(supportTraces.length, false) * 0.55) : supportEdgeWidth(supportTraces.length, selectedResultPath),
        opacity: selectedTraceId && !selectedSupport ? 0.05 : critical ? 0.95 : workflow ? shared ? 0.4 : relevance === 'unknown' ? 0.07 : 0.2 : inferenceKind === 'inferred' ? 0.65 : 0.8,
        // Relevance is an assessment; only absence of recorded support makes a link dashed.
        strokeDasharray: inferenceKind === 'inferred' ? '6 4' : undefined,
      },
      label: undefined,
      zIndex: selectedResultPath ? 3 : 0,
    };
  });
  return { nodes: allNodes, edges, workflow, contexts };
}

function WorkflowPorts() {
  const style = { width: 0, height: 0, minWidth: 0, minHeight: 0, border: 0, opacity: 0 };
  return <><Handle type="target" position={Position.Left} style={style} /><Handle type="source" position={Position.Right} style={style} />{(['top', 'bottom'] as const).map((side) => <span key={side}>
    <Handle id={`in-${side}`} type="target" position={side === 'top' ? Position.Top : Position.Bottom} style={style} />
    <Handle id={`out-${side}`} type="source" position={side === 'top' ? Position.Top : Position.Bottom} style={style} />
  </span>)}</>;
}

function motifDisplay(rendered: ReturnType<typeof semanticGraph>, motifs: DisplayGroup[], expanded: Set<string>, onToggle: (id: string) => void) {
  const folded = motifs.filter((motif) => !expanded.has(motif.id));
  const membership = new Map(folded.flatMap((motif) => motif.memberIds.map((id) => [id, motif.id] as const)));
  const nodes = rendered.nodes.filter((node) => !membership.has(node.id));
  for (const motif of folded) {
    const first = rendered.nodes.find((node) => node.id === motif.memberIds[0])!;
    if (first.data.kind !== 'family') continue;
    nodes.push({ ...first, id: motif.id, style: { ...first.style, width: 208, height: 76, background: 'transparent', boxShadow: 'none' },
      data: { ...first.data, motif, onToggle: () => onToggle(motif.id) } });
  }
  return { ...rendered, nodes, edges: rendered.edges.map((edge) => ({ ...edge,
    source: membership.get(edge.source) ?? edge.source, target: membership.get(edge.target) ?? edge.target })) };
}

function stageDisplay(rendered: ReturnType<typeof semanticGraph>, graph: JoinedProvenanceGraph, traces: Tracing[], onProv: (id: string) => void, axis: ImportanceAxis, selectedRun: string | undefined, resultConfig:RunResultConfig) {
  if (!rendered.nodes.some(node => node.data.kind === 'family' && node.data.motif)) return rendered;
  const nodes = rendered.nodes.map(node => {
    if (node.data.kind !== 'family' || !node.data.motif) return node;
    const group = node.data.motif;
    const members = graph.nodes.filter(family => group.memberIds.includes(family.id));
    const summary = stageSummary(members, traces);
    const point = group.toolNames.length>1 && members.every(family => family.importance.semantic.level === 'supporting') && !summary.errors;
    const values = members.map(family => importanceValue(family, axis));
    const variedImportance = new Set(values).size > 1;
    const background = variedImportance ? '#ffffff' : importanceBackground(values[0], importanceMaximum(graph, axis));
    return { ...node, style: { ...node.style, width: point ? 32 : 208, height: point ? 32 : summary.errors&&(summary.success||summary.failure)?88:76,
      background: 'transparent', boxShadow: 'none', opacity: !selectedRun || members.some(family => family.supportTraces.includes(selectedRun)) ? 1 : 0.12 }, data: { ...node.data, summary, runResult:summarizeRunResults(members.flatMap(family=>family.supportTraces),traces,resultConfig),
      presentation: point ? 'point' as const : 'card' as const, background, variedImportance,
      supportCount: summary.runs, callCount: summary.calls, toolNames: group.toolNames,
      parameterVariantCount:stageParameterCount(members),
      toolTitle: group.toolNames.length===1?humanToolTitle(group.toolNames[0],graph.nodes.flatMap(node=>node.methods)):'Supporting steps',
      label: group.toolNames.length > 1 ? 'Supporting steps' : node.data.label,
      supportTraces: [...new Set(members.flatMap(family => family.supportTraces))],
      failure: summary.errors === summary.calls && summary.calls>0, onProv: () => onProv(group.id) } };
  });
  const edges = new Map<string, SemanticEdge>();
  for (const edge of rendered.edges) {
    if (edge.source === edge.target) continue; // Original internal witnesses remain in the expanded stage.
    const key = edge.data?.semanticEdge ? `${edge.source}\0${edge.target}\0${edge.data.relation ?? ''}` : edge.id;
    const current = edges.get(key);
    if (!current) { edges.set(key, { ...edge, data: { ...edge.data!, memberEdges: edge.data?.semanticEdge ? [edge.data.semanticEdge] : [] } }); continue; }
    current.data!.memberEdges!.push(...edge.data?.semanticEdge ? [edge.data.semanticEdge] : []);
    const supportTraces = [...new Set([...current.data!.supportTraces, ...edge.data!.supportTraces])];
    const members = current.data!.memberEdges!;
    const recorded = members.some(member => member.witnesses.some(witness => !witness.inferred));
    const inferred = members.some(member => member.witnesses.some(witness => witness.inferred));
    const inferenceKind = recorded && inferred ? 'mixed' : recorded ? 'recorded' : 'inferred';
    const resultPath = current.data!.resultPath || edge.data!.resultPath;
    const shared = supportTraces.length > 1;
    current.data = { ...current.data!, supportTraces, inferenceKind, inferred: !recorded, shared, resultPath };
    current.ariaLabel = `${supportTraces.length} supporting runs · ${inferenceKind} · ${members.length} original connections`;
    current.style = { ...current.style, stroke: shared || resultPath ? RESULT_PATH_COLOR : '#94a3b8',
      strokeWidth: 1.4 + Math.sqrt(supportTraces.length - 1) * 1.1, strokeDasharray: recorded ? undefined : '6 4', opacity: selectedRun && !supportTraces.includes(selectedRun) ? 0.05 : 0.85 };
  }
  return { ...rendered, nodes, edges: [...edges.values()] };
}

function inlineDisplay(rendered: Omit<ReturnType<typeof semanticGraph>, 'edges'> & {edges:SemanticEdge[]}, graph: JoinedProvenanceGraph, traceDags: Record<string,AgentDag>, traces: Tracing[], expanded: Set<string>, onOpen: (id:string)=>void, onSupporting:(id:string)=>void, resultConfig:RunResultConfig, highlightRun?:string) {
  if(rendered.workflow)return rendered;
  return {...rendered,nodes:rendered.nodes.map(node=>{
    if(node.data.kind!=='family')return node;
    const open=expanded.has(node.data.motif?`prov:${node.id}`:node.id);
    const base={...node.data,onProv:()=>onOpen(node.id),onToggle:()=>onOpen(node.id)};
    if(!open)return {...node,data:base};
    const ids=new Set(node.data.motif?.memberIds??[node.id]);
    const families=graph.nodes.filter(family=>ids.has(family.id));
    const includeSupporting=expanded.has(`support:${node.id}`);
    const cluster=buildProvCluster(families,traceDags,includeSupporting),layout=layoutProvCluster(groupProvEntities(cluster));
    return {...node,style:{...node.style,width:Math.max(500,Math.min(800,layout.width+64)),height:Math.min(360,layout.height)+180,background:'transparent',boxShadow:'none'},
      data:{...base,expanded:true,presentation:'card' as const,inlineProv:{resultConfig,cluster,traceDags,traces,highlightRun,includeSupporting,onSupporting:()=>onSupporting(node.id)}}};
  })};
}

function WorkflowCard({ data }: { data: Extract<SemanticNodeData, { kind: 'family' }> }) {
  const uncertain = data.semanticLevel === 'unknown';
  const border = data.failure ? FAILURE_BORDER : data.recordedOutcome || data.semanticLevel === 'key' ? '#4f6bd8' : '#b5c2d5';
  return <div aria-label={`${data.workflowLabel} · Round ${(data.workflowContext?.roundStart ?? 0) + 1} · ${data.label}`} className="flex h-full w-full flex-col overflow-hidden rounded-2xl shadow-[0_3px_12px_#24375908]" style={{ border: `1px ${uncertain && !data.recordedOutcome && !data.failure ? 'dashed' : 'solid'} ${border}`, borderLeftWidth: supportLeftBorder(data.supportCount), background: data.failure ? FAILURE_BACKGROUND : data.background }}>
    <div className="flex h-[76px] shrink-0 flex-col gap-1 px-3 pt-2.5">
      <div className="flex items-center gap-2 text-[9px] font-medium text-slate-500">
        <span className="min-w-0 flex-1 truncate" title={data.toolNames.join(' · ')}>{data.workflowCategory === 'Event' ? data.toolNames[0] : data.workflowCategory}</span>
        <span>R{(data.workflowContext?.roundStart ?? 0) + 1}</span>
        {data.expandable ? <button type="button" aria-label={data.expanded ? 'Collapse semantic group' : 'Expand semantic group'} className="nodrag nopan h-4 w-4 rounded text-xs text-slate-500 hover:bg-white" onClick={(event) => { event.stopPropagation(); data.onToggle(); }} onMouseDown={(event) => event.stopPropagation()}>{data.expanded ? '−' : '+'}</button> : null}
      </div>
      <div className="line-clamp-2 text-[14px] font-medium leading-[18px] tracking-[-0.01em] text-slate-800" title={data.label}>{data.label}</div>
    </div>
    {data.expanded ? <div className="min-h-0 flex-1" /> : <p className="line-clamp-1 px-3 text-[10px] leading-4 text-slate-500" title={data.assessmentReason}>{uncertain ? data.assessedSupportCount ? 'Reviewed · relevance uncertain' : 'Not yet reviewed' : data.assessmentReason}</p>}
    <div data-graph-footer className="mt-auto flex h-12 shrink-0 flex-col justify-center gap-1 border-t border-slate-200/50 px-3 pb-1 text-[9px] text-slate-500">
      {data.workflowSummary ? <div className="truncate text-[11px] font-medium text-slate-700" title={data.workflowSummary}>{data.workflowSummary}</div> : null}
      <div className="flex items-center gap-2">
        <span className={data.failure ? 'font-medium text-red-700' : data.recordedOutcome ? 'font-semibold text-indigo-700' : data.semanticLevel === 'key' ? 'font-medium text-indigo-600' : ''}>{data.failure ? 'Failure' : data.recordedOutcome ? 'Recorded outcome' : data.semanticLevel === 'key' ? 'Key activity' : uncertain ? 'Uncertain context' : 'Supporting context'}</span>
        {data.recordedOutcome && uncertain ? <span>Not reviewed</span> : null}
        {data.totalTraceCount > 1 ? <span className="ml-auto">{data.supportCount}/{data.totalTraceCount} traces</span> : null}
      </div>
    </div>
    <WorkflowPorts />
  </div>;
}

function FamilyNode({ data }: NodeProps<SemanticNode>) {
  const [hovered, setHovered] = useState(false);
  if (data.kind !== 'family') return null;
  if(data.inlineProv){
    const detail=data.inlineProv;
    const activities=detail.cluster.nodes.filter(node=>node.kind==='Activity').length;
    const title=data.toolNames.length===1?data.toolTitle:data.sourceLabel?'Input preparation':data.label;
    return <div aria-label={`Expanded cluster: ${title}`} className="flex h-full w-full flex-col overflow-hidden rounded-xl border bg-[#f8faff] shadow-[0_3px_14px_#253c6510]" style={{borderColor:data.failure?FAILURE_BORDER:'#9fb4d8',borderLeftWidth:Math.min(10,3+data.supportCount)}}>
      <header className="flex h-[60px] shrink-0 items-center gap-3 border-b border-slate-200/80 bg-white/90 px-3"><div className="min-w-0 flex-1"><strong className="block truncate text-[14px] text-slate-900" title={data.toolNames.join(' · ')}>{title}</strong><span className="text-[10px] text-slate-500">{detail.cluster.rawActivityCount} calls → {activities} A · {detail.cluster.rawEntityCount} data records · {data.summary.runs}/{data.totalTraceCount} runs</span></div><button type="button" aria-label="Collapse Activity–Entity graph" className="nodrag nopan flex h-6 w-6 items-center justify-center rounded border border-slate-300 bg-white text-lg text-slate-600" onClick={event=>{event.stopPropagation();data.onProv();}}>−</button></header>
      <InlineProv key={JSON.stringify(detail.cluster.nodes.map(node=>node.members))} cluster={detail.cluster} traceDags={detail.traceDags} traces={detail.traces} resultConfig={detail.resultConfig} highlightRun={detail.highlightRun}/>
      <footer className="nodrag nopan flex h-8 shrink-0 items-center justify-between border-t border-slate-200/70 bg-white/70 px-3 text-[10px] text-slate-500" onClick={event=>event.stopPropagation()}><span>Aligned calls · grouped data · original witnesses</span>{data.summary.covered>data.summary.calls?<label className="flex items-center gap-1"><input aria-label="Include supporting activities" type="checkbox" checked={detail.includeSupporting} onChange={detail.onSupporting}/>Supporting steps</label>:null}</footer>
      <Handle type="target" position={Position.Left} style={{opacity:0}}/><Handle type="source" position={Position.Right} style={{opacity:0}}/>
    </div>;
  }
  const supportingDot = data.presentation === 'point';
  if (supportingDot) {
    const label = data.sourceLabel ? `Input: ${data.sourceLabel}` : data.label;
    return (
      <div aria-label={label} title={label} tabIndex={0}
        className="relative flex h-full w-full items-center justify-center"
        onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)} onBlur={() => setHovered(false)}>
        <span aria-hidden="true" className="h-3.5 w-3.5 rounded-full border border-slate-500" style={{
            borderStyle: data.semanticLevel === 'unknown' ? 'dashed' : 'solid',
            borderWidth: data.semanticLevel === 'unknown' ? 1 : Math.min(4, 1 + Math.max(0, data.supportCount - 1) * 0.75),
            background: data.sourceLabel ? data.background : data.semanticLevel === 'unknown' ? '#fff' : '#bfdbfe' }} />
        {!data.workflowMode ? <button type="button" aria-label="Expand Activity–Entity graph"
          className="nodrag nopan absolute -right-2 -top-1 flex h-4 w-4 items-center justify-center rounded border border-slate-300 bg-white text-xs text-slate-600 hover:bg-blue-50"
          onClick={(event) => { event.stopPropagation(); data.onProv(); }} onMouseDown={(event) => event.stopPropagation()}>+</button>
          : (data.eventCount ?? 0) > 1 ? <span className="absolute -right-1 -top-0.5 rounded bg-white/90 px-0.5 text-[8px] text-slate-500">{data.eventCount! > 99 ? '99+' : data.eventCount}</span> : null}
        {data.workflowMode ? <WorkflowPorts /> : <><Handle type="target" position={Position.Left} style={{opacity:0}}/><Handle type="source" position={Position.Right} style={{opacity:0}}/></>}
        {hovered ? <div role="tooltip" className="pointer-events-none absolute bottom-8 left-0 z-50 w-64 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] shadow-lg">
          <div className="break-words font-medium text-slate-700">{label}</div>
          <div className="mt-1 text-[9px] text-slate-500">{data.sourceLabel
            ? `${data.toolNames.join(' · ')} · ${data.callCount} calls · ${data.supportCount}/${data.totalTraceCount} runs`
            : data.workflowMode ? `${data.workflowLabel} · R${(data.workflowContext?.roundStart ?? 0) + 1}` : `${data.callCount} calls · ${data.supportCount}/${data.totalTraceCount} runs`}</div>
          <div className="mt-1 text-[9px] text-slate-400">Click for details{!data.workflowMode ? ' · + for Activity–Entity graph' : ''}</div>
        </div> : null}
      </div>
    );
  }
  if (data.workflowMode) return <WorkflowCard data={data} />;
  const description = data.comparison ?? data.sourceLabel ?? [data.intent, data.subject && !data.intent.toLowerCase().includes(data.subject.toLowerCase()) ? data.subject : ''].filter(Boolean).join(' · ');
  if (!data.expanded && data.presentation !== 'publication') {
    const tool = data.motif?.toolNames.length === 1 ? data.motif.toolNames[0] : data.toolNames.length === 1 ? data.toolNames[0] : null;
    const title = tool ? data.toolTitle : data.semanticLevel === 'supporting' ? 'Supporting steps' : data.label;
    const subtitle = data.motif ? `${data.parameterVariantCount>1?`${data.parameterVariantCount} parameter sets · `:''}${data.summary.calls} calls` : description;
    return <div aria-label={`${title} · ${semanticLevelLabel(data.semanticLevel)} · ${data.summary.runs}/${data.totalTraceCount} runs${data.summary.errors ? ` · ${data.summary.errors} tool errors` : ''}`} className="flex h-full w-full flex-col rounded-lg border bg-white px-2.5 py-2 shadow-[0_2px_7px_#0f172a08]" style={{borderColor:data.failure ? FAILURE_BORDER : '#b6c4db', borderLeftWidth:Math.min(10,3+data.supportCount), background:data.failure ? FAILURE_BACKGROUND : data.background}}>
      <div className="flex min-w-0 items-center gap-2"><strong className="min-w-0 flex-1 truncate text-[14px] font-semibold leading-4 text-slate-900" title={data.toolNames.join(' · ')}>{title}</strong><button type="button" aria-label="Expand Activity–Entity graph" title="See original activities, entities and parameters" className="nodrag nopan flex h-5 w-5 shrink-0 items-center justify-center rounded border border-slate-300 bg-white/90 text-sm text-slate-600 hover:border-blue-400 hover:text-blue-700" onClick={event=>{event.stopPropagation();data.onProv();}}>+</button></div>
      <p className="mt-1 truncate text-[11px] leading-4 text-slate-500" title={subtitle}>{subtitle}</p>
      <div className="mt-auto flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] leading-3"><span className="mr-auto whitespace-nowrap text-slate-500">{data.summary.runs}/{data.totalTraceCount} runs{data.variedImportance ? ' · varied' : ''}</span>{data.summary.errors ? <span className="whitespace-nowrap font-medium text-red-700">{data.summary.errors} {data.summary.errors===1?'error':'errors'}</span> : null}<span className={`max-w-[140px] shrink-0 truncate rounded px-1 ${data.runResult.kind==='success'?'bg-emerald-50 text-emerald-700':data.runResult.kind==='failure'?'bg-rose-50 text-rose-700':'bg-slate-50 text-slate-600'}`} title="Result of the supporting runs; separate from tool error">{data.runResult.label}</span></div>
      <Handle type="target" position={Position.Left} style={{opacity:0}}/><Handle type="source" position={Position.Right} style={{opacity:0}}/>
    </div>;
  }
  if (data.presentation === 'publication') return <div className="flex h-full w-full flex-col rounded-lg border border-slate-400 px-2.5 py-2" style={{fontFamily: 'Arial, sans-serif', borderLeftWidth: supportLeftBorder(data.supportCount), background: data.background}}>
    <div className="truncate text-[17px] font-semibold leading-5 text-slate-900" title={data.label}>{data.sourceLabel ? 'Input preparation' : data.label}</div>
    <div className="mt-1 line-clamp-2 break-words text-[15px] leading-[18px] text-slate-600" title={description}>{data.sourceLabel ? data.toolNames.join(' · ') : description}</div>
    <div className="mt-auto flex justify-between gap-1 text-[13px] leading-4 text-slate-600"><span>{data.semanticLevel === 'key' ? 'Key' : data.semanticLevel === 'supporting' ? 'Supporting' : 'Unreviewed'}</span><span>{data.callCount} {data.callCount === 1 ? 'call' : 'calls'} · {data.supportCount}/{data.totalTraceCount} runs</span></div>
    <Handle type="target" position={Position.Left} style={{opacity:0}}/><Handle type="source" position={Position.Right} style={{opacity:0}}/>
  </div>;
  if (data.presentation === 'compact') return <div aria-label={`${data.sourceLabel ? `Input ${data.sourceLabel}` : data.label} · ${semanticLevelLabel(data.semanticLevel)} · ${data.supportCount}/${data.totalTraceCount} runs`}
    className="flex h-full w-full flex-col justify-center gap-1 rounded-lg border border-slate-400 px-2.5 py-1.5 shadow-sm" style={{ borderLeftWidth: supportLeftBorder(data.supportCount), background: data.background }}>
    <div className="flex items-center gap-1.5 text-[10px] leading-3 text-slate-500">
      <span className="min-w-0 flex-1 truncate font-semibold text-slate-800">{data.sourceLabel ? 'Input' : data.label}</span>
      <span className="shrink-0 text-[9px]">{data.supportCount}/{data.totalTraceCount} runs</span>
      {data.expandable ? <button type="button" className="nodrag nopan flex h-4 w-4 shrink-0 items-center justify-center rounded border border-slate-300 bg-white/70 text-xs text-slate-600 hover:bg-white"
        aria-label={data.sourceLabel ? 'Expand input preparation' : 'Expand semantic group'} title="Expand original activities"
        onClick={(event) => { event.stopPropagation(); data.onToggle(); }} onMouseDown={(event) => event.stopPropagation()}>+</button> : null}
    </div>
    <div className="line-clamp-2 break-words text-[11px] font-medium leading-[14px] text-slate-900" title={description}>{description}</div>
    <div className="flex items-center gap-2 text-[9px] leading-3 text-slate-500">
      <span className="min-w-0 flex-1 truncate" title={data.toolNames.join(' · ')}>{data.sourceLabel ? data.toolNames.join(' · ') : semanticLevelLabel(data.semanticLevel)}</span>
      <span className="shrink-0">{data.callCount} {data.callCount === 1 ? 'call' : 'calls'}</span>
    </div>
    <Handle type="target" position={Position.Left} style={{opacity:0}}/><Handle type="source" position={Position.Right} style={{opacity:0}}/>
  </div>;
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-[11px]" style={{ border: `1px solid ${data.failure ? FAILURE_BORDER : data.resultBackbone ? RESULT_PATH_COLOR : '#64748b'}`, borderLeftWidth: supportLeftBorder(data.supportCount), background: data.failure ? FAILURE_BACKGROUND : data.background }}>
      <div className="flex h-16 shrink-0 items-start gap-2 border-b border-zinc-200/40 px-3 py-2">
        <span aria-hidden="true" className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-slate-100 text-[9px] font-medium text-slate-600">{data.sourceLabel ? '↳' : data.expandable ? 'Σ' : 'A'}</span>
        <div className="min-w-0 flex-1">
          <div className={`${data.comparison ? 'truncate' : 'line-clamp-2 break-words'} text-[12px] font-medium leading-4 text-zinc-900`} title={data.label}>{data.label}</div>
          <div className={`${data.comparison ? 'line-clamp-2 break-words' : 'truncate'} pt-0.5 text-[10px] font-normal leading-3 text-zinc-500`} title={description}>{description}</div>
        </div>
        {data.expandable ? <button
          type="button"
          className="nodrag nopan inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-zinc-300 text-sm text-zinc-700 hover:bg-zinc-100"
          aria-label={data.sourceLabel ? data.expanded ? 'Collapse input preparation' : 'Expand input preparation' : data.expanded ? 'Collapse semantic group' : 'Expand semantic group'}
          title={data.expanded ? 'Collapse group' : 'Expand group'}
          onClick={(event) => { event.stopPropagation(); data.onToggle(); }}
          onMouseDown={(event) => event.stopPropagation()}
        >{data.expanded ? '−' : '+'}</button> : null}
      </div>
      {data.expanded ? <div className="min-h-0 flex-1" /> : null}
      <div data-graph-footer className="mt-auto flex h-12 shrink-0 flex-wrap content-center items-center gap-x-1.5 gap-y-0.5 overflow-hidden border-t border-zinc-200/40 px-3 py-1 text-[9px] text-zinc-600">
        <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">{semanticLevelLabel(data.semanticLevel)}</span>
        {data.scoreSignal ? <span className="shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-semibold text-violet-800">Score signal</span> : null}
        {data.failure ? <span className="shrink-0 rounded-full bg-red-100 px-1.5 py-0.5 font-semibold text-red-800">Failure</span> : null}
        {data.resultBackbone && !data.directResult && !data.failure ? <span className="shrink-0 rounded-full bg-slate-200 px-1.5 py-0.5 font-semibold text-slate-900">Result path</span> : null}
        {data.importanceLabel ? <span className="font-medium text-indigo-900">{data.importanceLabel}</span> : null}
        <span className="font-medium">{data.callCount} {data.callCount === 1 ? 'call' : 'calls'}</span><span aria-hidden="true">·</span>
        <span>{data.supportCount}/{data.totalTraceCount} runs</span>
      </div>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function OperationNodeView({ data }: NodeProps<SemanticNode>) {
  if (data.kind !== 'operation') return null;
  return (
    <div className="flex h-full w-full items-center gap-2 rounded-lg px-2.5 shadow-sm" style={{ border: `1px solid ${data.failure ? FAILURE_BORDER : '#64748b'}`, borderLeftWidth: supportLeftBorder(data.supportCount), background: data.failure ? FAILURE_BACKGROUND : data.background }}>
      <Handle type="target" position={Position.Left} />
      <span aria-hidden="true" className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-xs ${data.failure ? 'bg-red-100 text-red-700' : 'bg-indigo-50 text-indigo-700'}`}>A</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-zinc-900" title={data.label}>{data.label}</span>
        <span className="block truncate text-[10px] text-zinc-500">{data.sublabel}</span>
        <span className="block truncate text-[9px] text-zinc-500">{semanticLevelLabel(data.semanticLevel)} · {data.supportCount}/{data.totalTraceCount} runs · {data.workflowMode ? `${data.callCount} events` : `${data.callCount} calls`}{data.failure ? ' · Failure' : ''}</span>
      </span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { semanticFamily: FamilyNode, semanticOperation: OperationNodeView };

function InitialFit({ workspace, ready, revision, boxes, initialNodeIds, detailFocus }: { workspace: GraphWorkspace; ready: boolean; revision: number; boxes: Box[]; initialNodeIds?: string[]; detailFocus?: {id:string;nonce:number} | null }) {
  const width = useStore(state => state.width), height = useStore(state => state.height);
  const { setViewport } = useReactFlow();
  const fitted = useRef('');
  const chosen = detailFocus ? boxes.filter(box=>box.id===detailFocus.id) : initialNodeIds?.length ? boxes.filter(box => initialNodeIds.includes(box.id)) : boxes;
  const bounds = chosen.length ? {
    x: Math.min(...chosen.map(box => box.x)), y: Math.min(...chosen.map(box => box.y)),
    width: Math.max(...chosen.map(box => box.x + box.width)) - Math.min(...chosen.map(box => box.x)),
    height: Math.max(...chosen.map(box => box.y + box.height)) - Math.min(...chosen.map(box => box.y)),
  } : null;
  const boundsKey = JSON.stringify([revision, width, height, bounds, detailFocus?.nonce]);
  useEffect(() => {
    if (!ready || !width || !height || !bounds || fitted.current === boundsKey) return;
    const viewport = getViewportForBounds(bounds, width, height, detailFocus || initialNodeIds?.length ? 0.4 : 0.2, detailFocus ? 1 : 1.2, initialNodeIds?.length ? WORKFLOW_FIT_PADDING : 0.14);
    fitted.current = boundsKey; workspace.viewport = viewport;
    void setViewport(viewport, { duration: 0 });
    // Bounds are derived from completed layout positions, not React Flow's previous measurement frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, revision, width, height, boundsKey, workspace, setViewport]);
  return null;
}

function WorkflowEdge(props: EdgeProps<SemanticEdge>) {
  const route = props.data?.route;
  const moved = route && (Math.abs(route[0].x - props.sourceX-(props.data?.portDeltas?.source.x??0)) + Math.abs(route[0].y - props.sourceY-(props.data?.portDeltas?.source.y??0))
    + Math.abs(route[route.length - 1].x - props.targetX-(props.data?.portDeltas?.target.x??0)) + Math.abs(route[route.length - 1].y - props.targetY-(props.data?.portDeltas?.target.y??0)) > 12);
  const path = props.data?.curve ? !moved ? cubicPath(props.data.curve) : getBezierPath(props)[0]
    : route && !moved ? props.data?.critical || props.data?.shared ? routePath(route) : curvedRoutePath(route) : getSmoothStepPath({ ...props, borderRadius: 0 })[0];
  const classes = [props.data?.curve ? 'workflow-curve' : 'orthogonal-flow', props.data?.shared ? 'shared-flow' : 'single-flow'].join(' ');
  return <><title>{props.data?.edgeLabel}</title><path d={path} fill="none" stroke="white" strokeWidth={Number(props.style?.strokeWidth??2)+4} opacity={props.style?.opacity} pointerEvents="none"/><BaseEdge id={props.id} path={path} className={classes} style={props.style} markerEnd={props.markerEnd} interactionWidth={14}/>{route&&props.data?.portDeltas?<circle cx={route[0].x} cy={route[0].y} r="2.8" fill={String(props.style?.stroke??"#64748b")} stroke="white" opacity={props.style?.opacity} pointerEvents="none"/>:null}</>;
}

const edgeTypes = { workflow: WorkflowEdge };

function routedEdges(nodes: SemanticNode[], edges: SemanticEdge[]): SemanticEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const boxes = new Map<string, Box>();
  nodes.forEach((node) => {
    const parent = node.parentId ? byId.get(node.parentId)! : undefined;
    boxes.set(node.id, { id: node.id, x: node.position.x + (parent?.position.x ?? 0),
      y: node.position.y + (parent?.position.y ?? 0), width: Number(node.style!.width), height: Number(node.style!.height), parentId: node.parentId });
  });
  const roots = nodes.filter((node) => !node.parentId && !node.hidden);
  const contextOf = (node: SemanticNode) => {
    const family = node.parentId ? byId.get(node.parentId)! : node;
    return family.data.kind === 'family' ? family.data.workflowContext : undefined;
  };
  const ordinary=edges.filter(edge=>!edge.hidden&&!contextOf(byId.get(edge.source)!)&&!contextOf(byId.get(edge.target)!));
  const ports=connectionPorts([...boxes.values()].map(box=>{const data=byId.get(box.id)!.data;return {...box,circle:data.kind==='family'&&data.presentation==='point'};}),ordinary);
  const occupied:Point[][]=[];
  return edges.map((edge, index) => {
    if (edge.hidden) return edge;
    const source = boxes.get(edge.source)!, target = boxes.get(edge.target)!;
    const sourceNode = byId.get(edge.source)!;
    const targetNode = byId.get(edge.target)!;
    const sourceContext = contextOf(sourceNode), targetContext = contextOf(targetNode);
    const workflow = Boolean(sourceContext || targetContext);
    const strong = Boolean(edge.data?.critical || edge.data?.shared);
    const sourceParent = source.parentId ?? source.id, targetParent = target.parentId ?? target.id;
    const obstacles = !workflow || strong ? roots.flatMap((root) => {
      const box = boxes.get(root.id)!;
      const childConnection = (source.parentId === root.id || target.parentId === root.id);
      if (!childConnection || (root.id !== sourceParent && root.id !== targetParent)) return [box];
      return [{ ...box, id: `${box.id}:header`, height: workflow ? 76 : 64 },
        { ...box, id: `${box.id}:footer`, y: box.y + box.height - 48, height: 48 },
        ...nodes.filter((node) => node.parentId === root.id && !node.hidden).map((node) => boxes.get(node.id)!)];
    }) : [];
    // Support/evidence styling is shared by all graphs; lanes only change geometry.
    if (workflow) {
      const verticalPorts = workflow && sourceContext?.laneId !== targetContext?.laneId && !source.parentId && !target.parentId;
      const nearby = obstacles.filter((box) => box.id !== source.id && box.id !== target.id
        && box.x + box.width >= Math.min(source.x, target.x) - 512 && box.x <= Math.max(source.x + source.width, target.x + target.width) + 512
        && box.y + box.height >= Math.min(source.y, target.y) - 512 && box.y <= Math.max(source.y + source.height, target.y + target.height) + 512);
      const connection = workflowCurve(source, target, verticalPorts, nearby);
      return { ...edge, sourceHandle: connection.sourceHandle, targetHandle: connection.targetHandle,
        data: { ...edge.data!, curve: connection.curve, route: [connection.curve[0], connection.curve.at(-1)!] } };
    }
    const port=ports.get(edge.id)!;
    const route=routeOrthogonal(port.source,port.target,obstacles,index%4,occupied);occupied.push(route);
    const name=(node:SemanticNode)=>node.data.kind==='family'?node.data.toolTitle:node.data.label;
    const edgeLabel=`${name(sourceNode)} → ${name(targetNode)} · ${edge.data?.supportTraces.length??1} runs · ${edge.data?.inferenceKind??'recorded'}`;
    return {...edge,ariaLabel:edgeLabel,data:{...edge.data!,route,portDeltas:{source:port.sourceDelta,target:port.targetDelta},edgeLabel}};
  });
}

function traceIdentity(traces: Tracing[], id: string) {
  const index = traces.findIndex((trace) => String(trace.id) === id);
  return { index, color: traceColor(index < 0 ? 0 : index).edge };
}

function RawDetails({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  return <details className="mt-2 rounded border border-zinc-200 bg-white px-2 py-1" onToggle={(event) => setOpen(event.currentTarget.open)}><summary className="cursor-pointer text-[11px] font-medium text-zinc-600">{label}</summary>{open ? <div className="mt-2 max-h-64 overflow-auto"><JsonField name={label} value={value} /></div> : null}</details>;
}

function dagNodeLabel(dag: AgentDag, id: string) {
  const node = dag.nodes.find((candidate) => candidate.id === id);
  if (!node) return 'Unknown record';
  return node.kind === 'Activity' ? node.tool : entitySummary(node);
}

function rawEdgeKind(edge: AgentDag['edges'][number]) {
  if (edge.inferred) return 'Model-inferred link';
  if (edge.evidence?.some((item) => item.kind === 'reference')) return 'Recorded/reference link';
  return 'Recorded link';
}

function semanticNodeLabel(graph: JoinedProvenanceGraph, id: string) {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  return node ? `${node.methods.join(' / ')} · ${node.label}` : 'Semantic step';
}

function witnessCallLabel(graph: JoinedProvenanceGraph, run: string, callId: string, index: number) {
  const call = graph.nodes.flatMap((node) => node.instances.filter((instance) => instance.run === run).flatMap((instance) => instance.calls)).find((candidate) => candidate.id === callId);
  return `Step ${call?.step ?? index + 1} · ${call?.tool ?? 'Tool call'}`;
}

function witnessEvidenceLabel(graph: JoinedProvenanceGraph, run: string, evidence: NonNullable<JoinedProvenanceEdge['witnesses'][number]['evidence']>[number], index: number) {
  const call = graph.nodes.flatMap((node) => node.instances.filter((instance) => instance.run === run).flatMap((instance) => instance.calls)).find((candidate) => candidate.id === evidence.callId);
  return { ...evidence, location: `Step ${call?.step ?? index + 1} · ${call?.tool ?? 'Tool call'} · ${evidence.field}${evidence.path ? evidence.path : ''}` };
}

function ProvStructure({ members, graph }: { members: OperationMemberView[]; graph: JoinedProvenanceGraph }) {
  const [limit, setLimit] = useState(10);
  return <details className="rounded border border-zinc-200 bg-white p-2 text-xs">
    <summary className="cursor-pointer font-medium text-zinc-800">PROV structure · Activity and Entity records</summary>
    <div className="mt-2 space-y-2">{members.slice(0, limit).map(({ member, dag, activity }) => {
      const inputs = member.inputEntityIds.map((id) => dag.nodes.find((node): node is EntityNode => node.kind === 'Entity' && node.id === id)).filter((node): node is EntityNode => Boolean(node));
      const outputs = member.outputEntityIds.map((id) => dag.nodes.find((node): node is EntityNode => node.kind === 'Entity' && node.id === id)).filter((node): node is EntityNode => Boolean(node));
      const inferred = graph.edges.flatMap((edge) => edge.witnesses.filter((witness) => witness.inferred && witness.run === member.run && witness.callPath.at(-1) === member.callId));
      return <div key={`${member.run}:${member.callId}`} className="rounded border border-zinc-200 p-2">
        <div className="mb-2 text-[10px] text-zinc-500">Run {member.run} · step {member.step}</div>
        <div className="rounded border border-indigo-300 bg-indigo-50 px-2 py-1.5"><span className="mr-2 rounded bg-white px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-indigo-700">Activity</span><span className="font-medium text-zinc-900">{activity.tool}</span></div>
        <div className="ml-3 border-l border-zinc-200 pl-3 pt-2">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500">Inputs · used(activity, entity)</div>
          {inputs.length ? inputs.map((entity) => <div key={entity.id} className="mb-1 flex flex-wrap items-center gap-2"><span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1 text-zinc-700"><span className="mr-1 text-[9px] font-semibold uppercase text-slate-500">Entity</span>{entitySummary(entity)}</span><span className="text-[10px] text-zinc-500">used({activity.tool}, entity)</span><RawDetails label="Input entity data" value={entity.response} /></div>) : <div className="text-zinc-500">No recorded input entities.</div>}
          {inferred.length ? <div className="my-2 rounded border border-dashed border-indigo-200 bg-indigo-50/40 p-2"><div className="font-medium text-indigo-900">Inferred input context</div><p className="text-[10px] text-zinc-500">Possible inspiration; not a recorded used relation.</p>{inferred.map((witness, index) => <div key={index} className="mt-1"><p className="text-zinc-700">{witness.reason}</p><RawDetails label="Source and input evidence" value={witness.evidence} /></div>)}</div> : null}
          <div className="mb-1 mt-2 text-[10px] font-medium uppercase tracking-wide text-zinc-500">Outputs · wasGeneratedBy(entity, activity)</div>
          {outputs.length ? outputs.map((entity) => <div key={entity.id} className="mb-1 flex flex-wrap items-center gap-2"><span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-1 text-zinc-700"><span className="mr-1 text-[9px] font-semibold uppercase text-emerald-700">Entity</span>{entitySummary(entity)}</span><span className="text-[10px] text-zinc-500">wasGeneratedBy(entity, {activity.tool})</span><RawDetails label="Output entity data" value={entity.response} /></div>) : <div className="text-zinc-500">No recorded output entities.</div>}
        </div>
      </div>;
    })}{members.length > limit ? <button className="text-indigo-700 underline" onClick={() => setLimit((value) => value + 10)}>Show more activities ({members.length - limit})</button> : null}</div>
  </details>;
}

function OverviewTab({ item, graph, traces, traceDags }: { item: Inspectable; graph: JoinedProvenanceGraph; traces: Tracing[]; traceDags: Record<string, AgentDag> }) {
  const [operationLimit, setOperationLimit] = useState(20);
  if (item.kind === 'family') {
    const { family } = item;
    const assessmentTraces = family.assessment?.perTrace ?? [];
    const assessedCount = family.assessment?.assessedSupportCount ?? assessmentTraces.filter((entry) => entry.level !== 'unknown').length;
    const keyCount = family.assessment?.keySupportCount ?? assessmentTraces.filter((entry) => entry.level === 'key').length;
    const supportingCount = assessmentTraces.length ? assessmentTraces.filter((entry) => entry.level === 'supporting').length : Math.max(0, assessedCount - keyCount);
    const unknownCount = assessmentTraces.length ? assessmentTraces.filter((entry) => entry.level === 'unknown').length : Math.max(0, family.supportCount - assessedCount);
    const jointIds = new Set(family.assessment?.jointGroupIds ?? []);
    const jointContexts = graph.workflowAssessment?.jointGroups.filter((group) => jointIds.has(group.id)) ?? [];
    const callsByRun = new Map<string, Set<string>>();
    family.instances.forEach((instance) => callsByRun.set(instance.run, new Set([...(callsByRun.get(instance.run) ?? []), ...instance.calls.map((call) => call.id)])));
    return <div className="space-y-3 text-xs">
      <div className="text-base font-semibold text-zinc-950">{family.source?.label ?? family.label}</div>
      <ProvStructure graph={graph} members={family.operationGroups.flatMap((operation) => operation.members.map((member) => operationMemberView(member, traceDags, traces)))} />
      {family.evidenceReview?.length ? <RawDetails label={`Backward evidence review · ${family.evidenceReview.filter((item) => item.status === 'assessed').length}/${family.evidenceReview.length} calls reviewed`} value={family.evidenceReview} /> : null}
      {family.assessment ? <div className="rounded border border-slate-200 bg-slate-50 p-2"><div className="font-medium">{family.assessment.level === 'key' ? 'Key event' : family.assessment.level === 'supporting' ? 'Supporting event' : 'Not assessed'}</div>{family.assessment.reason ? <p className="mt-1 text-zinc-600">{family.assessment.reason}</p> : null}{family.assessment.assessedSupportCount !== undefined || assessmentTraces.length ? <p className="mt-1 text-zinc-500">Across {family.supportCount} runs: {assessedCount} assessed{family.assessment.keySupportCount !== undefined || assessmentTraces.length ? ` · ${keyCount} key · ${supportingCount} supporting · ${unknownCount} unassessed` : ''}</p> : null}{family.assessment.evidence.length ? <RawDetails label={`Assessment evidence (${family.assessment.evidence.length})`} value={family.assessment.evidence} /> : null}</div> : null}
      {jointContexts.length ? <div className="space-y-1"><div className="font-medium text-blue-900">Joint evidence context</div>{jointContexts.map((group) => <details key={group.id} className="rounded border border-blue-200 bg-blue-50/50 p-2"><summary className="cursor-pointer font-medium">{group.label} · {group.sourceCallIds.length} inputs</summary><p className="mt-1 text-zinc-600">{group.reason}</p><ul className="mt-1 space-y-1 text-zinc-600">{group.sourceCallIds.map((id) => {
        const trace = traces.find((trace) => String(trace.id) === group.run);
        const call = trace?.toolCalls.find((item) => item.id === id);
        const delivery = trace?.eventLinks?.find((link) => link.target === id && link.relation === 'delivered_to');
        const sender = delivery ? trace?.toolCalls.find((item) => item.id === delivery.source)?.agentId : undefined;
        return <li key={id}>{sender ? `${sender} → ` : ''}{call?.agentId ?? 'Agent'}{call?.round !== undefined ? ` · Round ${call.round + 1}` : ''} · {call?.name ?? 'Source activity'}</li>;
      })}</ul><p className="mt-2 text-[10px] text-zinc-500">Recorded inputs considered together; this does not demonstrate a causal effect.</p><RawDetails label="Joint source evidence" value={group.evidence} /></details>)}</div> : null}
      <EvidencePanel graph={graph} callsByRun={callsByRun} />
      <InputSourcesPanel graph={graph} callsByRun={callsByRun} />
      <div><div className="mb-1 font-medium text-zinc-700">Runs</div><TracePills runs={family.supportTraces} traces={traces} /></div>
      <div><div className="mb-1 font-semibold text-zinc-700">Run variants</div><div className="space-y-1">{family.variants.map((variant, index) => { const instance = family.instances.find((candidate) => candidate.id === variant.instanceId); const steps = instance?.calls.map((call) => call.step) ?? []; const stepLabel = steps.length ? ` · steps ${Math.min(...steps)}–${Math.max(...steps)}` : ''; return <RawDetails key={`${variant.run}:${variant.instanceId}`} label={`Run ${variant.run} · instance ${index + 1}${stepLabel}`} value={{ roleBindings: variant.roleBindings, parameters: variant.parameters, diagnostics: variant.diagnostics, evidence: variant.evidence, instance: instance ? { internalFlow: instance.internalFlow, resultTargets: instance.resultTargets, resultBackbone: instance.resultBackbone, background: instance.background, targetEvidence: instance.targetEvidence } : null }} />; })}</div></div>
    </div>;
  }
  if (item.kind === 'operation') {
    const callsByRun = new Map<string, Set<string>>();
    item.members.forEach(({ member }) => callsByRun.set(member.run, new Set([...(callsByRun.get(member.run) ?? []), member.callId])));
    return <div className="space-y-3 text-xs">
    <div className="text-base font-semibold">{item.operation.tool}</div>
    <ProvStructure graph={graph} members={item.members} />
    {item.operation.failure ? <div className="rounded border border-red-300 bg-red-50 px-2 py-1 font-medium text-red-800">Recorded failure</div> : null}
    <div className="grid grid-cols-2 gap-2"><Metric label="Traces" value={new Set(item.members.map(({ member }) => member.run)).size} /><Metric label="Calls" value={item.members.length} /></div>
    <EvidencePanel graph={graph} callsByRun={callsByRun} />
    <InputSourcesPanel graph={graph} callsByRun={callsByRun} />
    <div><div className="mb-1 font-medium">Calls by trace</div><div className="space-y-1">{item.members.slice(0, operationLimit).map(({ member, activity, call }) => <div key={`${member.run}:${member.callId}`} className={`rounded border p-2 ${item.operation.failure ? 'border-red-300 bg-red-50' : 'border-zinc-200'}`}><div className="font-medium">Run {member.run} · step {member.step}{activity.status || call.status ? ` · ${activity.status ?? call.status}` : ''}</div><div className="text-zinc-500">{call.name}</div></div>)}</div>{operationLimit < item.members.length ? <button className="mt-2 rounded border px-2 py-1 text-zinc-600" onClick={() => setOperationLimit((count) => count + 20)}>Show more calls ({item.members.length - operationLimit} remaining)</button> : null}</div>
    <div><div className="mb-1 font-medium">Parameter variants</div>{item.operation.parameterVariants.map((variant, index) => <RawDetails key={`${item.operation.id}:params:${index}`} label={`Variant ${index + 1} · ${variant.members.map((member) => `Run ${member.run}`).join(', ')}`} value={variant.parameters} />)}</div>
    <div><div className="mb-1 font-medium">Outputs</div>{item.members.flatMap(({ member, outputs }) => outputs.map((output) => <RawDetails key={`${member.run}:${output.id}`} label={`Run ${member.run} · ${entitySummary(output)}`} value={output.response} />))}</div>
    </div>;
  }
  const inferred = item.edge.witnesses.filter((witness) => witness.inferred);
  const recorded = item.edge.witnesses.length - inferred.length;
  const relations = [...new Set([item.edge.relation, ...[...(item.rawEdges ?? []), ...(item.rawEdgeWitnesses ?? []).flatMap((entry) => entry.edges)].map((edge) => edge.eventRelation ?? edge.relation)].filter((relation): relation is string => Boolean(relation)))];
  const exposureLabels = relations.filter((relation) => ['present_in_prompt', 'delivered_to', 'used_shared_evidence', 'used_local_evidence'].includes(relation)).map(relationLabel);
  return <div className="space-y-2 text-xs"><div className="text-base font-semibold">Connection</div><p className="text-zinc-600">{semanticNodeLabel(graph, item.edge.source)} → {semanticNodeLabel(graph, item.edge.target)}</p>{exposureLabels.map((label) => <p key={label} className="rounded bg-sky-50 px-2 py-1 text-sky-900">{label}</p>)}<p className="text-zinc-600">{item.edge.supportCount} runs · {recorded ? `${recorded} recorded` : ''}{recorded && inferred.length ? ' · ' : ''}{inferred.length ? `${inferred.length} model-inferred` : ''} support</p>{item.witness ? <p className="text-zinc-600">Run {item.witness.run} · {item.witness.callPath.length} calls in witness path</p> : null}{inferred.map((witness, index) => <div key={`${witness.run}:${index}`} className="rounded border border-amber-200 bg-amber-50 p-2"><div className="font-medium text-amber-950">Model-inferred thought link · Run {witness.run}</div>{witness.reason ? <p className="mt-1 text-amber-900">{witness.reason}</p> : null}{witness.evidence?.length ? <ul className="mt-1 space-y-1 text-amber-950">{witness.evidence.map((evidence, evidenceIndex) => <li key={`${evidence.callId}:${evidence.path}:${evidenceIndex}`}><span className="font-medium">{witnessEvidenceLabel(graph, witness.run, evidence, evidenceIndex).location}</span>{evidence.quote ? <span> · “{evidence.quote}”</span> : null}</li>)}</ul> : null}</div>)}{item.rawEdges?.length ? <RawDetails label="Recorded dependency evidence" value={item.rawEdges.map((edge) => ({ ...edge, relation: relationLabel(edge.relation) }))} /> : null}{item.rawEdgeWitnesses?.length ? item.rawEdgeWitnesses.map(({ run, edges, dag }, index) => <RawDetails key={`${run}:${index}`} label={`Recorded operation handoff · Run ${run}`} value={edges.map((edge) => ({ relation: relationLabel(edge.relation), from: dagNodeLabel(dag, edge.source), to: dagNodeLabel(dag, edge.target), evidence: edge.evidence }))} />) : <RawDetails label="All witnesses" value={item.edge.witnesses} />}</div>;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded border border-zinc-200 px-2 py-1.5"><div className="text-[10px] text-zinc-500">{label}</div><div className="font-semibold text-zinc-900">{value}</div></div>;
}

function TracePills({ runs, traces }: { runs: string[]; traces: Tracing[] }) {
  return <div className="flex flex-wrap gap-1">{runs.map((run) => {
    const { color } = traceIdentity(traces, run);
    return <span key={run} className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2 py-1"><i className="h-2 w-2 rounded-full" style={{ background: color }} />Run {run}</span>;
  })}</div>;
}

function ImportanceTab({ family }: { family: JoinedProvenanceNode }) {
  const outcome = family.importance.outcome;
  const outcomeLabel = outcome.status.replaceAll('_', ' ');
  const semanticLevel = family.assessment?.level ?? family.importance.semantic.level;
  return <div className="space-y-3 text-xs">
    <Dimension label="Semantic role" value={semanticLevel === 'unknown' ? 'Evidence insufficient' : semanticLevel === 'key' ? 'Key analysis' : 'Supporting analysis'} detail={family.assessment?.reason || family.importance.reasons.join(' · ') || 'Based on the role this stage plays in the workflow.'} />
    <Dimension label="Conclusion evidence" value={family.importance.result.status.replaceAll('-', ' ').replaceAll('_', ' ')} detail={`${family.importance.result.supportedClaims.length} supported · ${family.importance.result.contradictedClaims.length} contradicted${family.importance.result.onRecordedPath ? ' · on recorded path' : ''}`} />
    <div className="space-y-2 rounded border border-zinc-200 p-2"><div className="font-semibold">Outcome (O)</div><p className="text-zinc-600">Shapley values explain a score predictor. They describe score associations, without measuring the effect of removing a tool.</p>
      <div><div className="font-medium">Task pattern · {outcomeLabel}</div>{outcome.cohorts.map((cohort) => <p key={cohort.taskId} className="mt-1 text-zinc-500">Task {cohort.taskId}: {cohort.sampleCount} prepared reference runs</p>)}{outcome.status === 'exploratory' ? <p className="mt-1 text-amber-800">Exploratory estimate: limited samples or predictive stability.</p> : null}{outcome.patterns?.length ? <div className="mt-2 space-y-1">{outcome.patterns.map((pattern, patternIndex) => <details key={`${pattern.name}:${patternIndex}`} className="rounded bg-zinc-50 p-2"><summary className="cursor-pointer font-medium">{pattern.name} · mean |Shapley| {pattern.importance.toFixed(3)} σ · {pattern.status} · n={pattern.sampleCount}</summary><ul className="mt-1 space-y-1 text-zinc-600">{pattern.contributions.map((entry, index) => <li key={`${entry.traceId}:${index}`}>Run {entry.traceId}: {entry.value > 0 ? '+' : ''}{entry.value.toFixed(4)} σ</li>)}</ul></details>)}</div> : outcome.contributions?.length ? <details className="mt-1"><summary className="cursor-pointer">Run contributions ({outcome.contributions.length})</summary><ul className="mt-1 space-y-1">{outcome.contributions.map((entry, index) => <li key={`${entry.traceId}:${entry.taskId}:${entry.scoreMetric}:${index}`}>Run {entry.traceId}: {entry.value > 0 ? '+' : ''}{entry.value.toFixed(4)} {entry.scoreMetric} · n={entry.sampleCount} · sign stability {(100 * entry.stability).toFixed(0)}%</li>)}</ul></details> : <p className="mt-1 text-zinc-600">No identifiable task-pattern estimate ({outcomeLabel}).</p>}</div>
      <div className="border-t border-zinc-200 pt-2"><div className="font-medium">Global tool relevance</div><p className="mt-1 text-zinc-500">Scores and tool usage are centered within each task; tasks have equal weight. Relevance is mean |Shapley| in task score standard deviations (σ).</p>{outcome.globalTools.length ? <div className="mt-2 space-y-2">{[...outcome.globalTools].sort((a, b) => b.importance - a.importance).map((entry) => <div key={`${entry.scoreMetric}:${entry.tool}`} className="rounded bg-zinc-50 p-2"><div className="font-medium">{entry.tool} · {entry.importance.toFixed(3)} σ{entry.status === 'exploratory' ? <span className="ml-1 text-amber-800">· exploratory</span> : null}</div><div className="mt-1 text-zinc-600">{entry.sampleCount} runs · {entry.taskCount} tasks · usage varies in {entry.varyingTaskCount} tasks</div><div className="text-zinc-600">Used in {entry.presentCount} runs · absent in {entry.absentCount}</div><div className="text-zinc-600">When used: {entry.meanWhenPresent > 0 ? '+' : ''}{entry.meanWhenPresent.toFixed(3)} σ</div><details className="mt-1"><summary className="cursor-pointer">Run contributions ({entry.contributions.length})</summary>{entry.contributions.map((value) => <div key={value.traceId} className="text-zinc-600">Run {value.traceId}: {value.value > 0 ? '+' : ''}{value.value.toFixed(3)} σ</div>)}</details></div>)}</div> : <p className="mt-1 text-zinc-600">No identifiable tool association in the loaded reference data.</p>}</div>
    </div>
    {family.importance.outcomeStatistics ? <RawDetails label="Outcome cohort details" value={family.importance.outcomeStatistics} /> : null}
  </div>;
}

function lagText(lag?: { count: number; meanRounds: number | null; maxRounds: number | null }) {
  return !lag || lag.count === 0 || lag.meanRounds === null ? 'not observed'
    : `${lag.meanRounds.toFixed(1)} round average · ${lag.maxRounds ?? '—'} max · n=${lag.count}`;
}

function WorkflowInsightsPanel({ insights, onLocate }: { insights?: WorkflowInsights; onLocate: (run: string, eventIds: string[]) => void }) {
  if (!insights) return null;
  const timing = insights.timing?.aggregate;
  const outcomes = (insights.outcomes?.runs ?? []).slice(0, 6);
  const keyStepRows = (insights.keySteps?.runs ?? []).flatMap((run) => run.metrics.map((metric) => ({ run: run.traceId, metric })));
  const keySteps = keyStepRows.filter((item, index) => keyStepRows.findIndex((other) => other.run === item.run && other.metric.eventId === item.metric.eventId) === index).slice(0, 4);
  const skills = (insights.skills ?? []).slice(0, 3);
  return <details className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-700">
    <summary className="cursor-pointer font-medium text-zinc-800">Workflow insights · results, communication, key paths &amp; skills<span className="ml-2 text-[10px] font-normal text-zinc-500">{insights.scope.runCount} runs</span></summary>
    <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
      <div className="rounded bg-slate-50 p-2"><div className="font-medium">Communication timing</div><div className="mt-1">{timing?.publicationCount ?? '—'} publications · {timing?.receptionCount ?? '—'} receptions · {timing?.linkedDeliveryCount ?? '—'} linked deliveries</div><div className="text-zinc-500">Payload mismatches: {timing?.sourcePayloadMismatchCount ?? '—'} source · {timing?.transportMismatchCount ?? '—'} transport</div><div className="text-zinc-500">Delivery lag: {lagText(timing?.deliveryLag)}</div><div className="text-zinc-500">Exposures: {timing?.sharedExposureCount ?? '—'} shared · {timing?.localExposureCount ?? '—'} local</div><div className="text-zinc-500">Matched-context coverage: {timing?.observedReceptionCoverage == null ? 'not observed' : `${(100 * timing.observedReceptionCoverage).toFixed(1)}% (${timing.uniqueExposedReceptionCount}/${timing.receptionCount})`} · selected contexts only</div>{timing?.coverageBasis ? <div className="text-zinc-500">Coverage basis: {timing.coverageBasis}</div> : null}<div className="text-zinc-500">Prompt exposure: {timing?.promptExposureCount ?? '—'} · lag {lagText(timing?.exposureLag)}</div></div>
      <div className="rounded bg-slate-50 p-2"><div className="font-medium">Final results</div>{outcomes.length ? outcomes.map((run) => {
        const terminal = run.metrics.filter((metric) => metric.finalMeaning === 'terminal_outcome' && metric.final);
        const values = terminal.length ? terminal : run.metrics.filter((metric) => metric.final);
        return <div key={run.traceId} className="mt-1">Run {run.traceId}{run.scoreMetric ? ` · ${run.scoreMetric}` : ''}{run.score !== null && run.score !== undefined ? ` · ${run.score.toFixed(2)}` : ''}{values.slice(0, 2).map((metric, index) => <div key={`${metric.name}:${metric.metric}:${metric.scope}:${metric.participantId ?? ''}:${index}`} className="text-zinc-500">{terminal.length ? 'Terminal outcome' : 'Last recorded milestone'} · {metric.name}: {metric.final!.value}{metric.final!.round !== null ? ` · Round ${(metric.final!.observedThroughRound ?? metric.final!.round) + 1}` : ''}{metric.scope ? ` · ${metric.scope}` : ''}{metric.participantId ? ` · ${metric.participantId}` : ''}</div>)}{!values.length ? <div className="text-zinc-500">No terminal outcome or final milestone recorded.</div> : null}</div>;
      }) : <div className="mt-1 text-zinc-500">No final result recorded.</div>}</div>
      <div className="rounded bg-slate-50 p-2"><div className="font-medium">Recorded outcome witnesses</div>{keySteps.length ? keySteps.map(({ run, metric }, index) => <div key={`${run}:${metric.name}:${metric.metric}:${index}`} className="mt-1"><button type="button" className="text-left font-medium text-blue-800 hover:underline" onClick={() => onLocate(run, metric.witness.map((step) => step.eventId))}>Run {run} · {metric.name}: {metric.value}{metric.round !== null ? ` · Round ${metric.round + 1}` : ''} ↗</button><div className="text-zinc-500">{metric.witness.slice(0, 3).map((step, stepIndex) => <span key={`${step.eventId}:${stepIndex}`}>{step.eventType ?? 'Event'}{step.agentId ? ` · ${step.agentId}` : ''}{step.round !== null ? ` · R${step.round + 1}` : ''}{step.relationToNext ? ` —${step.relationToNext}→ ` : stepIndex < Math.min(2, metric.witness.length - 1) ? ' → ' : ''}</span>)}</div></div>) : <div className="mt-1 text-zinc-500">No outcome witness path recorded.</div>}</div>
      <div className="rounded bg-slate-50 p-2"><div className="font-medium">Skill candidates</div><div className="text-[10px] text-zinc-500">Repeated evidence motifs; candidates, not validated capabilities.</div>{skills.length ? skills.map((skill) => <details key={skill.id} className="mt-1"><summary className="cursor-pointer">{skill.label} · {skill.runSupport} runs · {skill.status}{skill.role ? ` · ${skill.role}` : ''}</summary><div className="mt-1 space-y-1 text-zinc-500"><div>{skill.pattern}{skill.patternTypes.length ? ` · ${skill.patternTypes.join(', ')}` : ''}</div>{skill.preconditions?.length ? <div>Preconditions: {skill.preconditions.join('; ')}</div> : null}{skill.procedure?.length ? <div>Procedure: {skill.procedure.join('; ')}</div> : null}{skill.outcomeEvidence ? <div>Outcome evidence: {skill.outcomeEvidence}</div> : null}{skill.applicability ? <div>{skill.applicability}</div> : null}{skill.limitations ? <div>Limits: {skill.limitations}</div> : null}</div></details>) : <div className="mt-1 text-zinc-500">No skill candidates recorded.</div>}</div>
    </div>
  </details>;
}

function Dimension({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="rounded border border-zinc-200 p-2"><div className="font-semibold capitalize">{label}: {value}</div><div className="mt-1 text-zinc-600">{detail}</div></div>;
}

function resultCallLabel(graph: JoinedProvenanceGraph, run: string, callId: string) {
  const call = graph.nodes.flatMap((node) => node.instances.filter((instance) => instance.run === run).flatMap((instance) => instance.calls)).find((candidate) => candidate.id === callId);
  return call ? `${call.tool} · step ${call.step}` : `Tool call ${callId}`;
}

function InputSourcesPanel({ graph, callsByRun }: { graph: JoinedProvenanceGraph; callsByRun: Map<string, Set<string>> }) {
  const activities = (graph.inputSources ?? []).flatMap((run) => run.activities
    .filter((activity) => callsByRun.get(run.run)?.has(activity.callId))
    .map((activity) => ({ ...activity, run: run.run })));
  if (!activities.length) return null;
  return <details className="rounded border border-sky-200 bg-sky-50/40 p-2"><summary className="cursor-pointer font-medium text-sky-950">Input sources · {activities.filter((activity) => activity.sources.some((source) => source.relation === 'input')).length}/{activities.length} matched</summary>
    <p className="mt-2 text-[11px] text-zinc-600">Possible input context, reviewed separately from conclusion support. These links do not prove causal influence.</p>
    {activities.map((activity) => <div key={`${activity.run}:${activity.callId}`} className="mt-2 border-t border-sky-100 pt-2">
      <div className="font-medium">{resultCallLabel(graph, activity.run, activity.callId)} · Run {activity.run}</div>
      {activity.rejectedLinks ? <p className="mt-1 text-amber-800">{activity.rejectedLinks} proposed {activity.rejectedLinks === 1 ? 'link could' : 'links could'} not be verified against both the earlier source and this call’s input arguments.</p> : null}
      {!activity.sources.length ? <p className="mt-1 text-zinc-500">{activity.status === 'not_assessed' ? 'The model did not assess this activity. Retrieved sources remain available below.' : activity.status === 'invalid_evidence' ? 'Input sources remain unverified. Retrieved candidates are available below.' : 'No supported input source found among the retrieved candidates.'}</p> : activity.sources.map((source, index) => <div key={index} className="mt-2">
        <div className="text-sky-900">{source.kind === 'initial_task' ? 'Initial task' : resultCallLabel(graph, activity.run, source.sourceCallId!)} · {source.relation === 'input' ? 'Specific input match' : 'Possible context'}</div>
        <p className="mt-1 text-zinc-600">{source.reason}</p>
        <RawDetails label="Source and input evidence" value={source.evidence} />
      </div>)}
      {activity.candidates.length ? <details className="mt-2 text-zinc-500"><summary className="cursor-pointer">Retrieved candidates · unverified ({activity.candidateCount})</summary>{activity.candidates.map((candidate) => <div key={candidate.sourceCallId} className="mt-2"><div>{resultCallLabel(graph, activity.run, candidate.sourceCallId)} · similarity {candidate.similarity.toFixed(2)}</div><RawDetails label="Retrieved source excerpts" value={candidate.evidence} /></div>)}</details> : null}
    </div>)}
  </details>;
}

function EvidencePanel({ graph, callsByRun }: { graph: JoinedProvenanceGraph; callsByRun?: Map<string, Set<string>> }) {
  const runs = graph.resultEvidence ?? [];
  const structured = (graph.structuredOutcomes ?? []).flatMap((run) => {
    const allowedCalls = callsByRun?.get(run.run);
    if (callsByRun && !allowedCalls) return [];
    return run.outcomes.filter((outcome) => !allowedCalls || allowedCalls.has(outcome.eventId)).map((outcome) => ({ run: run.run, outcome }));
  });
  if (!runs.length && !structured.length) return <div className="rounded border border-zinc-200 p-2 text-zinc-600"><div className="font-semibold">Conclusion evidence</div><p className="mt-1">No final-answer evidence was supplied.</p></div>;
  const coverage = runs.reduce((sum, run) => ({
    considered: sum.considered + (run.coverage?.consideredClaims ?? 0),
    total: sum.total + (run.coverage?.totalClaims ?? 0),
    assessed: sum.assessed + (run.coverage?.assessedClaims ?? 0),
  }), { considered: 0, total: 0, assessed: 0 });
  return <div className="space-y-2 rounded border border-zinc-200 p-2">{structured.length ? <div><div className="font-semibold">Workflow outcomes</div><div className="mt-1 space-y-1">{structured.map(({ run, outcome }) => <div key={`${run}:${outcome.id}`} className="rounded bg-slate-50 px-2 py-1 text-zinc-700">Run {run} · Round {outcome.round + 1} · {outcome.metric}: {outcome.value}{outcome.direction ? ` (${outcome.direction})` : ''}<div className="text-zinc-500">{outcome.name} · source event: {resultCallLabel(graph, run, outcome.eventId)}</div></div>)}</div></div> : null}{runs.length ? <><div className="font-semibold">Conclusion evidence</div><p className="text-zinc-500">Coverage: {coverage.considered}/{coverage.total} fragments searched locally · {coverage.assessed} assessed by a model. Retrieved matches are candidates; support links show partial evidence for claim aspects. Recorded paths are shown separately.</p></> : null}{runs.map((run) => {
    const allowedCalls = callsByRun?.get(run.run);
    const claims = run.claims.map((claim) => ({ ...claim, links: allowedCalls ? claim.links.filter((link) => allowedCalls.has(link.callId)) : claim.links })).filter((claim) => claim.links.length || !callsByRun);
    if (callsByRun && !allowedCalls) return null;
    if (run.status !== 'available') return <div key={run.run} className="rounded bg-amber-50 p-2 text-amber-900">Run {run.run}: {run.status === 'missing-final' ? 'final answer missing' : 'no output candidates found'}</div>;
    const runCoverage = run.coverage;
    const coverageText = runCoverage ? ` · ${runCoverage.consideredClaims}/${runCoverage.totalClaims} searched · ${runCoverage.assessedClaims} assessed` : '';
    return <details key={run.run} className="rounded border border-zinc-200 p-2"><summary className="cursor-pointer font-medium">Run {run.run} · {claims.length} fragments{coverageText}</summary><div className="mt-2 space-y-2">{claims.length ? claims.map((claim) => <details key={claim.id} className="rounded bg-zinc-50 p-2"><summary className="cursor-pointer text-zinc-800">{claim.text.length > 140 ? `${claim.text.slice(0, 140)}…` : claim.text}<span className="ml-1 text-zinc-500">· {claim.assessed ? 'assessed' : 'retrieval only'}</span></summary><blockquote className="mt-2 border-l-2 border-zinc-300 pl-2 text-zinc-600">Final answer · “{claim.source.quote}”</blockquote>{claim.links.map((link, index) => <div key={`${link.bundleId ?? ''}:${link.callId}:${index}`} className="mt-2 border-t border-zinc-200 pt-2"><div className="font-medium">{link.joint && link.bundleId ? 'Joint evidence · ' : ''}{resultCallLabel(graph, run.run, link.callId)} · {link.relation} · {link.reason}</div>{link.evidence.map((evidence, evidenceIndex) => <blockquote key={`${evidence.path}:${evidenceIndex}`} className="mt-1 border-l-2 border-amber-400 pl-2 text-zinc-600">Tool output · {evidence.path}: “{evidence.quote}”</blockquote>)}</div>)}{!claim.links.length ? <details className="mt-2"><summary className="cursor-pointer text-zinc-600">Retrieved candidates · unverified ({claim.retrieved.length})</summary>{claim.retrieved.map((candidate, index) => <div key={index} className="mt-2"><div>{candidate.tool} · step {candidate.step} · similarity only</div><blockquote className="border-l-2 border-zinc-300 pl-2 text-zinc-600">{candidate.path}: “{candidate.quote}”</blockquote></div>)}</details> : null}</details>) : <p className="text-zinc-500">No linked claims in this stage.</p>}</div></details>;
  })}</div>;
}

function CallsTab({ item, traces }: { item: Inspectable; traces: Tracing[] }) {
  const [visibleCount, setVisibleCount] = useState(12);
  const calls = item.kind === 'family'
    ? item.family.instances.flatMap((instance) => {
        const trace = traces.find((entry) => String(entry.id) === instance.run)!;
        return instance.calls.map((call) => ({ run: instance.run, step: call.step, value: trace.toolCalls[call.step - 1]! }));
      })
    : item.kind === 'operation' ? item.members.map(({ member, call }) => ({ run: member.run, step: member.step, value: call })) : [];
  return <div className="space-y-1">{calls.length ? calls.slice(0, visibleCount).map((call, index) => <RawDetails key={`${call.run}:${call.step}:${index}`} label={`Run ${call.run} · step ${call.step} · ${call.value.name}`} value={call.value} />) : <p className="text-xs text-zinc-500">This connection has no direct tool call.</p>}{visibleCount < calls.length ? <button className="mt-2 rounded border px-2 py-1 text-xs text-zinc-600" onClick={() => setVisibleCount((count) => count + 12)}>Show more calls ({calls.length - visibleCount} remaining)</button> : null}</div>;
}

function ConnectionsTab({ item, graph }: { item: Inspectable; graph: JoinedProvenanceGraph }) {
  if (item.kind === 'family' || (item.kind === 'operation' && item.family.operationGroups.length === 1)) {
    const incoming = graph.edges.filter((edge) => edge.target === item.family.id);
    const outgoing = graph.edges.filter((edge) => edge.source === item.family.id);
    return <div className="space-y-2 text-xs">
      <div className="font-semibold">Incoming and outgoing semantic witnesses</div>
      <p className="text-zinc-500">Paths are grouped across runs. Inspect a witness before treating a cross-run path as a single execution.</p>
      {[...incoming.map((edge) => ({ direction: 'From', edge })), ...outgoing.map((edge) => ({ direction: 'To', edge }))].map(({ direction, edge }) => <div key={edge.id} className="rounded border border-zinc-200 p-2"><div className="font-medium">{direction} {semanticNodeLabel(graph, direction === 'From' ? edge.source : edge.target)} · {edge.supportCount} runs</div><RawDetails label="Witness paths and evidence" value={edge.witnesses} /></div>)}
      {incoming.length + outgoing.length === 0 ? <p className="text-zinc-500">No semantic connections.</p> : null}
    </div>;
  }
  if (item.kind === 'operation') {
    return <div className="space-y-2 text-xs"><div className="font-semibold">Recorded operation inputs and outputs</div>{item.members.map(({ member, dag, activity }) => {
      const ids = new Set([...member.inputEntityIds, ...member.outputEntityIds, activity.id]);
      const edges = dag.edges.filter((edge) => ids.has(edge.source) || ids.has(edge.target));
      return <div key={`${member.run}:${member.callId}`} className="rounded border border-zinc-200 p-2"><div className="mb-1 font-medium">Run {member.run} · step {member.step}</div>{edges.length ? edges.map((edge, index) => <div key={`${edge.source}:${edge.target}:${index}`} className="text-zinc-600">{rawEdgeKind(edge)} · {relationLabel(edge.relation)}: {dagNodeLabel(dag, edge.source)} → {dagNodeLabel(dag, edge.target)}<RawDetails label="Evidence" value={{ source: edge.source, target: edge.target, evidence: edge.evidence }} /></div>) : <span className="text-zinc-500">No recorded input or output edges.</span>}</div>;
    })}</div>;
  }
  if (item.rawEdges?.length && item.dag) return <div className="space-y-2 text-xs"><div className="font-semibold">Source provenance connections</div>{item.rawEdges.map((edge, index) => <div key={`${edge.source}:${edge.target}:${index}`} className="rounded border border-zinc-200 p-2"><div>{rawEdgeKind(edge)} · {relationLabel(edge.relation)}: {dagNodeLabel(item.dag!, edge.source)} → {dagNodeLabel(item.dag!, edge.target)}</div><RawDetails label="Evidence" value={{ source: edge.source, target: edge.target, evidence: edge.evidence }} /></div>)}</div>;
  return <div className="space-y-2 text-xs"><div className="font-semibold">Witness path</div>{item.witness ? <ol className="list-decimal pl-5">{item.witness.callPath.map((callId, index) => <li key={`${index}:${callId}`}>{witnessCallLabel(graph, item.witness!.run, callId, index)}</li>)}</ol> : <p>No individual witness selected.</p>}<RawDetails label="All connection witnesses" value={item.edge.witnesses} /></div>;
}

function Inspector({ item, graph, traces, traceDags, nodeData, onClose }: { item: Inspectable | null; graph: JoinedProvenanceGraph; traces: Tracing[]; traceDags: Record<string, AgentDag>; nodeData?: SemanticNodeData; onClose: () => void }) {
  const [collapsedItem, setCollapsedItem] = useState<Inspectable | null>(null);
  const [tab, setTab] = useState<InspectorTab>('overview');
  if (!item) return null;
  const itemKey = item.kind === 'family' ? item.family.id : item.kind === 'operation' ? item.operation.id : item.edge.id;
  const collapsed = collapsedItem === item;
  return <aside className={`nodrag nopan absolute bottom-2 right-2 z-20 flex max-h-[58%] ${collapsed ? 'w-40' : 'w-[min(27rem,calc(100%-1rem))]'} resize flex-col overflow-auto rounded-lg border border-zinc-300 bg-white/95 shadow-xl backdrop-blur`} onMouseDown={(event) => event.stopPropagation()}>
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-200 px-2">
      <span className="flex-1 truncate text-xs font-semibold text-zinc-800">Details</span>
      {nodeData?.kind === 'family' && nodeData.expandable ? <button type="button" className="text-xs font-medium text-blue-700 hover:text-blue-900" onClick={() => { nodeData.onToggle(); onClose(); }}>{nodeData.expanded ? 'Fold group' : 'Expand group'}</button> : null}
      <button type="button" className="text-xs text-zinc-500 hover:text-zinc-900" onClick={() => setCollapsedItem(collapsed ? null : item)}>{collapsed ? 'Expand' : 'Collapse'}</button>
      <button type="button" aria-label="Clear selection" className="text-xs text-zinc-500 hover:text-zinc-900" onClick={onClose}>×</button>
    </div>
    {!collapsed ? <>
      <div className="flex shrink-0 border-b border-zinc-200 px-1">{(['overview', 'importance', 'calls', 'connections'] as const).map((value) => <button key={value} type="button" aria-pressed={tab === value} className={`px-2 py-1.5 text-[10px] capitalize ${tab === value ? 'border-b-2 border-indigo-500 font-semibold text-zinc-900' : 'text-zinc-500'}`} onClick={() => setTab(value)}>{value}</button>)}</div>
      <div className="min-h-20 flex-1 overflow-auto p-3">
        {item.kind!=='connection'&&item.family.displayRecovered?<p className="mb-2 rounded bg-slate-50 p-2 text-[10px] text-slate-500">Source calls restored from the trace; importance has not been assessed.</p>:null}
        {item.kind!=='connection'&&item.family.displayOrigin?<p className="mb-2 rounded bg-slate-50 p-2 text-[10px] text-slate-500">Importance belongs to the original reviewed group; this view separates its operations.</p>:null}
        {tab === 'overview' ? <OverviewTab key={itemKey} item={item} graph={graph} traces={traces} traceDags={traceDags} /> : null}
        {tab === 'importance' ? item.kind === 'family' || item.kind === 'operation' ? <ImportanceTab family={item.family} /> : <p className="text-xs text-zinc-500">Importance is defined for semantic groups.</p> : null}
        {tab === 'calls' ? <CallsTab key={itemKey} item={item} traces={traces} /> : null}
        {tab === 'connections' ? <ConnectionsTab item={item} graph={graph} /> : null}
      </div>
    </> : null}
  </aside>;
}

type FocusState = { direct: Set<string>; nodes: Set<string>; edges: Set<string>; active: boolean; filters: GraphFilters };

function workspaceNodes(items: SemanticNode[], workspace: GraphWorkspace): SemanticNode[] {
  return items.map((node) => {
    const width = Number(node.style!.width), height = Number(node.style!.height);
    // Sizes and ports are fixed by the projection. Supplying them avoids mounting
    // the complete history just to measure offscreen nodes before virtualization.
    const geometry = { measured: { width, height }, handles: [
      { type: 'target' as const, position: Position.Left, x: 0, y: height / 2, width: 0, height: 0 },
      { type: 'source' as const, position: Position.Right, x: width, y: height / 2, width: 0, height: 0 },
      ...(node.data.kind === 'family' && node.data.workflowMode ? (['top', 'bottom'] as const).flatMap((side) =>
        (['source', 'target'] as const).map((type) => ({ type, id: `${type === 'source' ? 'out' : 'in'}-${side}`,
          position: side === 'top' ? Position.Top : Position.Bottom, x: width / 2, y: side === 'top' ? 0 : height, width: 0, height: 0 }))) : []),
    ] };
    let position = !node.parentId || workspace.pinned.has(node.id) ? workspace.positions.get(node.id) ?? node.position : node.position;
    if (!node.parentId) return { ...node, ...geometry, position };
    const parent = items.find((candidate) => candidate.id === node.parentId)!;
    position = { x: Math.max(16, Math.min(position.x, Number(parent.style!.width) - Number(node.style!.width) - 16)),
      y: Math.max(80, Math.min(position.y, Number(parent.style!.height) - Number(node.style!.height) - 56)) };
    return { ...node, ...geometry, position, extent: [[16, 80], [Number(parent.style!.width) - 16, Number(parent.style!.height) - 56]] };
  });
}

function LocateStep({ target, workflow }: { target: { id: string; ids?: string[]; nonce: number } | null; workflow: boolean }) {
  const { fitView } = useReactFlow();
  const initialized = useNodesInitialized();
  const applied = useRef<number | null>(null);
  useEffect(() => {
    if (initialized && target && applied.current !== target.nonce) {
      const frame = requestAnimationFrame(() => {
        applied.current = target.nonce;
        void fitView({ nodes: (target.ids ?? [target.id]).map((id) => ({ id })), padding: workflow ? WORKFLOW_FIT_PADDING : 0.35, maxZoom: 1.2, duration: 0 });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [initialized, target, fitView, workflow]);
  return null;
}

function WorkflowAxes({ workflow, geometry }: { workflow: WorkflowLayout; geometry: ReturnType<typeof workflowGeometry> }) {
  const { x, y, zoom } = useViewport();
  const width = useStore((state) => state.width);
  const ticks: Array<{ round: number; left: number }> = [];
  for (const round of geometry.roundStarts) {
    const left = x + (48 + (geometry.roundOffsets.get(round) ?? 0)) * zoom;
    if (left >= 212 && left <= width - 72 && (!ticks.length || left - ticks[ticks.length - 1].left >= 88)) {
      ticks.push({ round, left });
    }
  }
  return <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden="true">
    <div className="absolute inset-x-0 top-0 h-10 border-b border-slate-200/60 bg-white/85" />
    <div className="absolute bottom-0 left-0 top-10 w-40 bg-gradient-to-r from-[#fafcff] via-[#fafcff]/95 to-transparent" />
    {geometry.laneRows.map((lane) => <div key={lane.id}
      className="absolute left-3 flex w-32 items-center gap-2 rounded-xl border border-slate-200/70 bg-white/95 px-2.5 py-2 shadow-sm shadow-slate-200/30"
      style={{ top: y + (56 + lane.top + (lane.height - 64) / 2) * zoom - 22 }}>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-400"><svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M7 7h10M7 7l5 10 5-10" /><circle cx="7" cy="7" r="2.5" fill="white" /><circle cx="17" cy="7" r="2.5" fill="white" /><circle cx="12" cy="17" r="2.5" fill="white" /></svg></span>
      <span className="min-w-0"><span className="block truncate text-[11px] font-semibold text-slate-700">{lane.label.split(' · ')[0]}</span><span className="block truncate text-[9px] text-slate-400">{lane.label.split(' · ').slice(1).join(' · ') || lane.kind}</span></span>
    </div>)}
    {ticks.map(({ round, left }) => <div key={round}
        className="absolute top-3 whitespace-nowrap text-[10px] font-medium tracking-wide text-slate-400"
        style={{ left }}>{workflow.roundLabel || 'Round'} <span className="text-slate-600">{round + 1}</span></div>)}
  </div>;
}

function SemanticCanvas({ graph:sourceGraph, traces, traceDags, selectedTraceId, workspace, axis, focus:sourceFocus, locate:sourceLocate, expandedFamilies, onToggle, onAxisChange, onInspectionChange, onWitnessLocate, publication, stageOverview, onStageOverview, runResults, onRunResultsChange }: {
  graph: JoinedProvenanceGraph; traces: Tracing[]; traceDags: Record<string, AgentDag>;
  selectedTraceId?: string; workspace: GraphWorkspace; axis: ImportanceAxis;
  onInspectionChange: (selection: { nodeIds: string[]; edgeIds: string[] }) => void;
  onWitnessLocate: (run: string, eventIds: string[]) => void;
  expandedFamilies: Set<string>; onToggle: (id: string) => void; onAxisChange: (axis: ImportanceAxis) => void;
  focus: FocusState; locate: { id: string; ids?: string[]; nonce: number; inspect?: boolean } | null;
  publication: boolean; stageOverview: boolean; onStageOverview: () => void; runResults:RunResultConfig;onRunResultsChange:(value:RunResultConfig)=>void;
}) {
  const projection=useMemo(()=>projectToolStages(sourceGraph,traceDags,stageOverview),[sourceGraph,traceDags,stageOverview]);
  const graph=projection.graph;
  const displayIds=useCallback((ids:Set<string>)=>new Set([...projection.nodeOrigins].filter(([,origin])=>ids.has(origin)).map(([id])=>id)),[projection]);
  const focus=useMemo(()=>{
    const direct=displayIds(sourceFocus.direct);
    if(sourceFocus.filters.text)for(const id of matchFamilies(graph,sourceFocus.filters))if(graph.nodes.find(node=>node.id===id)?.displayRecovered)direct.add(id);
    const edges=new Set(graph.edges.filter(edge=>sourceFocus.edges.has(projection.edgeOrigins.get(edge.id)??'')).map(edge=>edge.id));
    return {...sourceFocus,...focusSelection(graph,direct,edges,sourceFocus.filters),direct};
  },[sourceFocus,displayIds,graph,projection]);
  const locate=useMemo(()=>{const ids=sourceLocate?[...displayIds(new Set(sourceLocate.ids??[sourceLocate.id]))]:[];return sourceLocate&&ids.length?{...sourceLocate,id:ids[0],ids}:null;},[sourceLocate,displayIds]);
  const [selected, setSelected] = useState<Inspectable | null>(null);
  const [inlineLocate, setInlineLocate] = useState<{id:string;nonce:number;parentNonce?:number}|null>(null);
  const [bundleEdges, setBundleEdges] = useState<JoinedProvenanceEdge[] | null>(null);
  const [selectedMotif, setSelectedMotif] = useState<DisplayGroup | null>(null);
  useEffect(() => {
    const origin=selected&&selected.kind!=='connection'?projection.nodeOrigins.get(selected.family.id):undefined;
    onInspectionChange({ nodeIds: origin&&sourceGraph.nodes.some(node=>node.id===origin)?[origin]:[],
      edgeIds: selected?.kind === 'connection' && projection.edgeOrigins.has(selected.edge.id) ? [projection.edgeOrigins.get(selected.edge.id)!] : [] });
  }, [selected, onInspectionChange, projection, sourceGraph]);
  const [linkHover,setLinkHover]=useState<{node?:string;edge?:string}|null>(null);
  const [revision, setRevision] = useState(0);
  const [layoutState, setLayoutState] = useState<{key: string; workspace: GraphWorkspace} | null>(null);
  const [layoutError, setLayoutError] = useState('');
  const [routingNodes, setRoutingNodes] = useState<SemanticNode[]>([]);
  const inspectedLocate = useRef<number | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance<SemanticNode, SemanticEdge> | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportedGraph, setExportedGraph] = useState<Awaited<ReturnType<typeof exportGraphPng>> | null>(null);
  const motifs = useMemo(() => {
    if (graph.workflow || !stageOverview) return [];
    const stages = workflowStageGroups(graph).filter(group => !group.memberIds.some(id => expandedFamilies.has(id)));
    const claimed = new Set([...expandedFamilies, ...stages.flatMap(group => group.memberIds)]);
    return [...stages, ...displayMotifs(graph, claimed)];
  }, [graph, expandedFamilies, stageOverview]);
  const openInline=(id:string)=>{
    const key=graph.nodes.some(node=>node.id===id)?id:`prov:${id}`;
    onToggle(key);setInlineLocate({id,nonce:Date.now(),parentNonce:locate?.nonce});setSelected(null);setSelectedMotif(null);
  };
  const rendered = useMemo(() => inlineDisplay(stageDisplay(motifDisplay(semanticGraph(graph, expandedFamilies, traceDags, traces, selectedTraceId, onToggle, openInline, axis, focus.active ? focus.direct : undefined, publication,runResults), motifs, expandedFamilies, onToggle), graph, traces, openInline, axis, selectedTraceId,runResults), graph, traceDags, traces, expandedFamilies, openInline, id=>{onToggle(`support:${id}`);setInlineLocate({id,nonce:Date.now(),parentNonce:locate?.nonce});}, runResults,selectedTraceId),
    // Expansion lives in the shared graph controls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, expandedFamilies, traceDags, traces, selectedTraceId, axis, workspace, focus.active, focus.direct, publication, motifs, locate?.nonce,runResults]);
  const chronology = useMemo(() => rendered.workflow ? new Map() : stageChronology(graph, rendered.nodes.filter(node => !node.parentId).map(node => ({id:node.id,
    memberIds: node.data.kind === 'family' && node.data.motif ? node.data.motif.memberIds : [node.id]}))), [graph, rendered.nodes, rendered.workflow]);
  const geometryKey = JSON.stringify([revision, rendered.workflow, [...chronology], rendered.nodes.map((node) => [node.id, node.parentId, node.style!.width, node.style!.height, node.data.kind === 'family' ? node.data.workflowContext : undefined]),
    rendered.edges.map((edge) => [edge.id, edge.source, edge.target])]);
  const [nodes, setNodes, onNodesChange] = useNodesState<SemanticNode>([]);
  useEffect(() => {
    if (layoutState?.key === geometryKey && layoutState.workspace === workspace) return;
    let active = true;
    const roots = rendered.nodes.filter((node) => !node.parentId).map((node) => ({
      id: node.id, ...node.position, width: Number(node.style!.width), height: Number(node.style!.height),
    }));
    const rootIds = new Set(roots.map((node) => node.id));
    if (workspace.sizes.size && roots.length && !roots.some((node) => workspace.sizes.has(node.id))) workspace.viewport = undefined;
    const links = rendered.workflow ? [] : rendered.edges.filter(edge => rootIds.has(edge.source) && rootIds.has(edge.target)).map(edge => ({
      id: edge.id, source: edge.source, target: edge.target, priority: edge.data?.inferred ? 1 : 10,
      recordedSupport: edge.data?.inferred ? 0 : edge.data?.supportTraces.length ?? 0,
    }));
    const arrange = Promise.resolve(rendered.workflow
      ? layoutWorkflowLanes(roots, rendered.workflow, rendered.contexts, workspace)
      : layoutChronologicalGroups(roots, links, chronology, workspace));
    void arrange.then((positions) => {
      if (!active) return;
      positions.forEach((position, id) => workspace.positions.set(id, position));
      if (rendered.workflow) workspace.sizes.clear();
      roots.forEach((box) => workspace.sizes.set(box.id, rendered.workflow ? workflowSizeSignature(box) : `${box.width}:${box.height}`));
      const positioned = workspaceNodes(rendered.nodes, workspace);
      setNodes(positioned); setRoutingNodes(positioned);
      setLayoutState({key: geometryKey, workspace}); setLayoutError('');
    }).catch((error: Error) => { if (active) setLayoutError(error.message); });
    return () => { active = false; };
  }, [rendered, graph, geometryKey, workspace, setNodes, layoutState, publication, stageOverview, chronology]);
  useEffect(() => {
    if (layoutState?.key !== geometryKey || layoutState.workspace !== workspace) return;
    const positioned = workspaceNodes(rendered.nodes, workspace);
    setNodes(positioned); setRoutingNodes(positioned);
  }, [rendered, layoutState, geometryKey, workspace, setNodes]);
  useEffect(() => {
    if (!locate?.inspect || inspectedLocate.current === locate.nonce) return;
    const node = rendered.nodes.find((node) => node.id === locate.id);
    if (node) {
      inspectedLocate.current = locate.nonce;
      setSelected(node.data.inspectable); canvasRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [locate, rendered.nodes]);
  const familyOf = (node: SemanticNode) => node.parentId ?? node.id;
  const decorateNodes = (items: SemanticNode[]) => items.map((node) => {
    const id = familyOf(node), ids = node.data.kind === 'family' && node.data.motif ? node.data.motif.memberIds : [id];
    const included = ids.some(member => focus.nodes.has(member));
    const direct = ids.some(member => focus.direct.has(member) || expandedFamilies.has(member) || selected && selected.kind !== 'connection' && selected.family.id === member);
    return { ...node, hidden: focus.active && focus.filters.view === 'isolate' && !included,
      style: { ...node.style, opacity: Math.min(Number(node.style?.opacity ?? 1), focus.active ? direct ? 1 : included ? 0.65 : rendered.workflow ? 0.14 : 0.24 : 1),
        boxShadow: focus.active && direct && !node.parentId ? `0 0 0 ${rendered.workflow ? 1 : 2}px rgb(99 102 241 / 0.45)` : node.style?.boxShadow } };
  });
  const baseVisibleNodes = decorateNodes(nodes);
  const baseById = new Map(rendered.nodes.map((node) => [node.id, node]));
  const styledEdges = rendered.edges.map((edge) => {
    const source = familyOf(baseById.get(edge.source)!), target = familyOf(baseById.get(edge.target)!);
    const kind = edge.data?.inferenceKind ?? (edge.data?.inferred ? 'inferred' : 'recorded');
    const allowed = focus.filters.links === 'all' || (focus.filters.links === 'recorded' ? kind !== 'inferred' : kind !== 'recorded');
    const included = edge.data?.memberEdges ? edge.data.memberEdges.some(member => focus.edges.has(member.id)) : edge.data?.semanticEdge ? focus.edges.has(edge.data.semanticEdge.id) : focus.nodes.has(source) && focus.nodes.has(target);
    const hidden = !allowed || Boolean(rendered.workflow) && focus.active && !included
      || focus.active && focus.filters.view === 'isolate' && !included;
    return { ...edge, hidden, style: { ...edge.style,
      opacity: Math.min(Number(edge.style?.opacity ?? 1), focus.active ? included ? 1 : rendered.workflow ? 0.025 : 0.08 : 1) } };
  });
  const routeKey = JSON.stringify([focus.active, focus.filters.view, focus.filters.links, [...focus.nodes], [...focus.edges]]);
  const ready = layoutState?.key === geometryKey && layoutState.workspace === workspace;
  const workflowBoxes = rendered.nodes.filter((node) => !node.parentId).map((node) => ({ id: node.id, x: 0, y: 0, width: Number(node.style!.width), height: Number(node.style!.height) }));
  const laneGeometry = rendered.workflow ? workflowGeometry(workflowBoxes, rendered.workflow, rendered.contexts) : undefined;
  const primaryOutcome = graph.structuredOutcomes?.flatMap((run) => run.outcomes)
    .find((outcome) => outcome.scope !== 'participant' && (outcome.terminal || outcome.kind === 'final'));
  const initialRounds = new Set(primaryOutcome
    ? laneGeometry?.roundStarts.filter((round) => Math.abs(round - primaryOutcome.round) <= 1) ?? []
    : laneGeometry?.roundStarts.slice(0, 3) ?? []);
  const initialNodeIds = rendered.workflow ? rendered.nodes.filter((node) => !node.parentId && node.data.kind === 'family'
    && initialRounds.has(node.data.workflowContext?.roundStart ?? -1)).map((node) => node.id) : undefined;
  const locateTarget = locate && rendered.workflow
    ? { ...locate, ids: workflowFrameIds(rendered.contexts, locate.ids ?? [locate.id]) } : locate;
  const routes = useMemo(() => ready ? routedEdges(decorateNodes(routingNodes), styledEdges) : [],
    // Node geometry is snapshotted on layout and drag-end; avoid rerouting the entire graph each drag frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, routingNodes, rendered.edges, routeKey, selectedTraceId]);
  const tracing=linkHover??(selectedMotif?{node:selectedMotif.id}:selected&&selected.kind!=='connection'?{node:selected.family.id}:selected?.kind==='connection'?{edge:selected.edge.id}:null);
  const tracedEdges=new Set(routes.filter(edge=>tracing&&(edge.id===tracing.edge||edge.source===tracing.node||edge.target===tracing.node||edge.data?.memberEdges?.some(member=>member.id===tracing.edge))).map(edge=>edge.id));
  const tracedNodes=new Set(routes.filter(edge=>tracedEdges.has(edge.id)).flatMap(edge=>[edge.source,edge.target]));if(tracing?.node)tracedNodes.add(tracing.node);
  const visibleNodes=baseVisibleNodes.map(node=>({...node,style:{...node.style,opacity:Math.min(Number(node.style?.opacity??1),tracing&&!tracedNodes.has(node.id)?0.2:1)}}));
  const visibleRoutes=routes.map(edge=>({...edge,style:{...edge.style,opacity:Math.min(Number(edge.style?.opacity??1),tracing&&!tracedEdges.has(edge.id)?0.08:1),stroke:tracing&&tracedEdges.has(edge.id)?'#315fba':edge.data?.inferred?'#8194b3':edge.style?.stroke,strokeWidth:Number(edge.style?.strokeWidth??2)+(tracing&&tracedEdges.has(edge.id)?0.7:0)}}));
  const overviewHeight = Math.max(480, Math.min(760, Math.max(0, ...nodes.filter(node => !node.parentId).map(node => node.position.y + Number(node.style!.height))) + 64));
  const workflowInsights = graph.workflowInsights;
  return <div ref={canvasRef} className="space-y-2">
    <WorkflowInsightsPanel insights={workflowInsights} onLocate={onWitnessLocate} />
    {!rendered.workflow ? <p title="Aligned by recorded call order across runs; expand a group for exact occurrence steps." className="px-1 text-[11px] text-slate-500"><strong className="font-medium text-slate-700">{rendered.nodes.filter(node => !node.parentId).length} display groups</strong> · {rendered.edges.length} visible connections · {sourceGraph.nodes.length} original stages preserved{projection.recoveredCalls?` · ${projection.recoveredCalls} folded source calls restored`:null}. Earlier → later · drag to pan · + opens Activity–Entity details.</p> : null}
    <GraphLegend axis={axis} maximum={importanceMaximum(graph, axis)} traceCount={traces.length} workflow={Boolean(rendered.workflow)} onAxisChange={onAxisChange} flowColor={RESULT_PATH_COLOR} resultControls={<RunResultControls traces={traces} value={runResults} onChange={onRunResultsChange}/>} />
    <div className="flex flex-wrap items-center justify-end gap-2">
    <span className="mr-auto text-[10px] text-slate-400">Hover a step or line to follow its connections.</span>
    <button type="button" className="rounded border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-600" onClick={()=>{setInlineLocate(null);void flowRef.current?.fitView({padding:0.12,minZoom:0.1,maxZoom:1.05,duration:180});}}>Fit all</button>
    <button type="button" className="rounded border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-600" onClick={()=>{void flowRef.current?.zoomTo(1,{duration:180});}}>100%</button>
    {!rendered.workflow ? <button type="button" aria-pressed={stageOverview} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-700 aria-pressed:bg-blue-50 aria-pressed:text-blue-800" onClick={() => { onStageOverview(); workspace.viewport = undefined; setRevision(value => value + 1); }}>Group variants</button> : null}
    {motifs.length ? <button type="button" className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[10px] text-slate-600" title="Display grouping only: individual parameters, importance and edge witnesses are preserved" onClick={() => { const expanded = motifs.every((motif) => expandedFamilies.has(motif.id)); motifs.filter((motif) => expandedFamilies.has(motif.id) === expanded).forEach((motif) => onToggle(motif.id)); }}>{motifs.every((motif) => expandedFamilies.has(motif.id)) ? 'Fold variants' : `Expand ${motifs.filter((motif) => !expandedFamilies.has(motif.id)).reduce((count, motif) => count + motif.memberIds.length, 0)} variants`}</button> : null}
    <button type="button" disabled={!ready || exporting} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[10px] text-slate-600 disabled:opacity-50" title="Export the complete visible graph at print resolution" onClick={async () => {
      setExporting(true); setExportError('');
      try {
        await flowRef.current!.fitView({padding: 0.08, duration: 0});
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        setExportedGraph(await exportGraphPng(canvasRef.current!));
      } catch (error) { setExportError(error instanceof Error ? error.message : String(error)); }
      finally { setExporting(false); }
    }}>{exporting ? 'Exporting…' : 'Export PNG'}</button>
    <button type="button" className="rounded-lg border border-slate-200 bg-white/95 px-2.5 py-1 text-[10px] text-slate-500 hover:bg-slate-50" onClick={() => {
      workspace.positions.clear(); workspace.sizes.clear(); workspace.pinned.clear(); workspace.viewport = undefined;
      setRevision((value) => value + 1);
    }}>{rendered.workflow ? 'Reset layout' : 'Rearrange'}</button>
    </div>
    <div className={`relative overflow-hidden border border-slate-200 bg-[#fafcff] ${rendered.workflow ? 'h-[44rem] rounded-2xl' : 'rounded-lg'}`} style={rendered.workflow ? undefined : {height: overviewHeight}}>
    {exportError ? <div role="alert" className="absolute left-52 top-3 z-20 rounded bg-white p-2 text-xs text-red-700">{exportError}</div> : null}
    {exportedGraph ? <div role="dialog" aria-modal="true" aria-label="Graph export" className="fixed inset-4 z-50 flex flex-col rounded-xl border border-slate-300 bg-white p-4 shadow-xl">
      <div className="mb-3 flex items-center gap-4 text-sm"><span className="flex-1 font-medium">{exportedGraph.width} × {exportedGraph.height} px · native graph at 3× resolution</span><a className="text-blue-700 underline" download="agenttrails-joint-provenance.png" href={exportedGraph.url}>Save PNG</a><button type="button" onClick={() => setExportedGraph(null)}>Close export</button></div>
      {/* The image is generated locally from the mounted graph, not served through image optimization. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt="Exported joint provenance graph" src={exportedGraph.url} className="min-h-0 flex-1 object-contain" />
    </div> : null}
    {!ready ? <div className="absolute left-52 top-3 z-10 rounded bg-white/95 px-2 py-1 text-xs text-zinc-500">{layoutError || 'Arranging workflow…'}</div> : null}
    <ReactFlow<SemanticNode, SemanticEdge>
      onInit={(instance) => { flowRef.current = instance; }}
      nodes={ready ? visibleNodes : []} edges={ready ? visibleRoutes : []} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onlyRenderVisibleElements
      onNodesChange={(changes) => {
        onNodesChange(changes);
        const moved = new Map(changes.flatMap((change) => change.type === 'position' && change.position && change.dragging === false
          ? [[change.id, change.position] as const] : []));
        if (moved.size) {
          moved.forEach((position, id) => { workspace.positions.set(id, position); workspace.pinned.add(id); });
          setRoutingNodes((current) => current.map((item) => moved.has(item.id) ? { ...item, position: moved.get(item.id)! } : item));
        }
      }}
      onMoveEnd={(_, viewport) => { workspace.viewport = viewport; }}
      defaultViewport={workspace.viewport}
      onPaneClick={()=>{setLinkHover(null);setSelected(null);setSelectedMotif(null);setBundleEdges(null);}}
      onNodeMouseEnter={(_,node)=>setLinkHover({node:node.id})} onNodeMouseLeave={()=>setLinkHover(null)}
      onEdgeMouseEnter={(_,edge)=>setLinkHover({edge:edge.id})} onEdgeMouseLeave={()=>setLinkHover(null)}
      onNodeClick={(_, node) => { setBundleEdges(null); if (node.data.kind === 'family' && node.data.motif) { setSelected(null); setSelectedMotif(node.data.motif); } else { setSelectedMotif(null); setSelected(node.data.inspectable); } }}
      onEdgeClick={(_, edge) => { setSelectedMotif(null); if (edge.data?.memberEdges && edge.data.memberEdges.length > 1) { setSelected(null); setBundleEdges(edge.data.memberEdges); return; } setBundleEdges(null); setSelected({ kind: 'connection', edge: edge.data!.semanticEdge ?? { id: edge.id, source: edge.source, target: edge.target, supportCount: edge.data!.supportTraces.length, supportTraces: edge.data!.supportTraces, witnesses: [], inferred: edge.data!.inferred }, witness: edge.data!.witness, rawEdges: edge.data!.rawEdges, dag: edge.data!.dag, rawEdgeWitnesses: edge.data!.rawEdgeWitnesses }); }}
      nodeOrigin={[0, 0]} minZoom={0.1} nodesDraggable nodesConnectable={false} elementsSelectable
      proOptions={{ hideAttribution: true }} defaultEdgeOptions={{ type: 'workflow', markerEnd: ARROW }}
    >
      {rendered.workflow && laneGeometry ? <ViewportPortal><div className="pointer-events-none absolute left-0 top-0 -z-10" aria-hidden="true">
        {laneGeometry.laneRows.map((lane, index) => <div key={lane.id} className="absolute border-y border-slate-200/40" style={{ background: index % 2 ? '#f3f6fb' : '#ffffff', left: 16, top: 38 + lane.top, width: laneGeometry.totalWidth + 32, height: lane.height }}>
        </div>)}
        {laneGeometry.roundStarts.map((round) => <div key={round} className="absolute border-l border-dashed border-slate-300/40" style={{ left: 32 + (laneGeometry.roundOffsets.get(round) ?? 0), top: 38, height: laneGeometry.totalHeight }} />)}
      </div></ViewportPortal> : null}
      {rendered.workflow && laneGeometry ? <WorkflowAxes workflow={rendered.workflow} geometry={laneGeometry} /> : null}
      {!rendered.workflow ? <Background color="#cbd5e1" gap={20} size={1} /> : null}
      <Controls position="bottom-left" showInteractive={false} fitViewOptions={{ padding: 0.14, minZoom: 0.1 }} />
      <InitialFit workspace={workspace} ready={ready} revision={revision} boxes={visibleNodes.filter(node => !node.parentId && !node.hidden).map(node => ({id:node.id,...node.position,width:Number(node.style!.width),height:Number(node.style!.height)}))} initialNodeIds={initialNodeIds} detailFocus={inlineLocate?.parentNonce===locate?.nonce?inlineLocate:null} />
      <LocateStep target={ready ? locateTarget : null} workflow={Boolean(rendered.workflow)} />
    </ReactFlow>
    {selectedMotif ? <aside aria-label="Variant group details" className="nodrag nopan absolute bottom-2 right-2 z-20 max-h-[58%] w-80 overflow-auto rounded-lg border border-slate-300 bg-white p-3 text-xs shadow-xl">
      <div className="flex items-center justify-between"><strong>{selectedMotif.kind === 'stage' ? 'Tool stage · distinct variants' : 'Distinct variants'}</strong><button type="button" aria-label="Close variant details" onClick={() => setSelectedMotif(null)}>×</button></div>
      <p className="my-2 text-slate-500">{selectedMotif.kind === 'stage' ? 'Workflow role overview. Original tools, input conditions, results and evidence remain separate for each variant.' : 'These steps share directed connections. Their parameters and evidence remain separate.'}</p>
      {selectedMotif.memberIds.map((id) => { const family = graph.nodes.find((node) => node.id === id)!; return <button type="button" key={id} className="my-1 block w-full rounded border border-slate-200 p-2 text-left hover:bg-blue-50" onClick={() => { if (!expandedFamilies.has(selectedMotif.id)) onToggle(selectedMotif.id); setSelected({ kind: 'family', family }); setSelectedMotif(null); }}><strong>{family.label}</strong><span className="block text-slate-500">{instanceSubject(family)} · {family.supportTraces.length}/{traces.length} runs · {semanticLevelLabel(family.importance.semantic.level)}</span></button>; })}
      <div className="mt-2 flex gap-3"><button type="button" className="font-medium text-blue-700" onClick={() => { openInline(selectedMotif.id); setSelectedMotif(null); }}>Activity–Entity graph</button><button type="button" className="text-slate-600" onClick={() => { onToggle(selectedMotif.id); setSelectedMotif(null); }}>Separate variants</button></div>
    </aside> : null}
    {bundleEdges ? <aside aria-label="Connection witnesses" className="absolute bottom-2 right-2 z-30 max-h-[60%] w-96 overflow-auto rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-xl"><div className="flex justify-between"><strong>Original connections</strong><button type="button" aria-label="Close connection witnesses" onClick={() => setBundleEdges(null)}>×</button></div><p className="my-2 text-slate-500">A shared line bundles these original connections. Each witness stays in its own run.</p>{bundleEdges.map(edge => <button type="button" key={edge.id} className="my-1 block w-full rounded border border-slate-200 p-2 text-left" onClick={() => { setSelected({kind:'connection',edge});setBundleEdges(null); }}>{semanticNodeLabel(graph,edge.source)} → {semanticNodeLabel(graph,edge.target)}<span className="block text-slate-500">{edge.supportCount} runs · {edge.witnesses.length} witnesses</span></button>)}</aside> : null}
    <Inspector item={selected} graph={graph} traces={traces} traceDags={traceDags} nodeData={selected?.kind === 'family' ? rendered.nodes.find((node) => node.id === selected.family.id)?.data : undefined} onClose={() => setSelected(null)} />
    </div>
  </div>;
}

export function SemanticGraphView({ graph, traces, traceDags, highlightTraceId, workspace, commands, onViewStateChange, publication = false }: {
  graph: JoinedProvenanceGraph; traces: Tracing[]; traceDags: Record<string, AgentDag>;
  highlightTraceId?: string; workspace: GraphWorkspace; commands: GraphCommand[];
  onViewStateChange: (state: GraphViewState) => void;
  publication?: boolean;
}) {
  const [stageOverview, setStageOverview] = useState(true);
  const [runResults,setRunResults]=useState<RunResultConfig>(()=>workspace.runResults??DEFAULT_RUN_RESULT);
  useEffect(()=>{workspace.runResults=runResults;},[workspace,runResults]);
  const [filters, setFilters] = useState<GraphFilters>(() => workspace.filters ?? { ...DEFAULT_GRAPH_FILTERS });
  const [axis, setAxis] = useState<ImportanceAxis>(() => workspace.axis ?? 'semantic');
  const [expandedFamilies, setExpandedFamilies] = useState(() => new Set(workspace.expanded));
  const [highlight, setHighlight] = useState<GraphHighlight | null>(workspace.focus ?? null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [inspected, setInspected] = useState<{ nodeIds: string[]; edgeIds: string[] }>({ nodeIds: [], edgeIds: [] });
  const [locate, setLocate] = useState<{ id: string; ids: string[]; nonce: number; inspect?: boolean } | null>(null);
  const appliedCommand = useRef(commands.at(-1)?.nonce ?? 0);
  const [frameRequest, setFrameRequest] = useState(0);
  const scope = useMemo(() => graphScope(graph, workspace.sourceKey), [graph, workspace.sourceKey]);
  const activeHighlight = highlight?.scope === scope ? highlight : null;
  const changeFilters = (patch: Partial<GraphFilters>) => {
    if (['text', 'role', 'evidence', 'minSupport', 'minOutcome'].some((key) => key in patch)) setHighlight(null);
    if (patch.view === 'isolate' || filters.view === 'isolate') setFrameRequest((current) => current + 1);
    setFilters((current) => ({ ...current, ...patch }));
  };
  const localMatches = useMemo(() => filters.evidence === 'failure'
    ? matchFamilies({ ...graph, nodes: graph.nodes.filter(node => stageSummary([node], traces).errors > 0) }, { ...filters, evidence: 'all' })
    : matchFamilies(graph, filters), [graph, filters, traces]);
  const direct = useMemo(() => activeHighlight ? new Set(activeHighlight.nodeIds.filter((id) => localMatches.has(id))) : localMatches,
    [activeHighlight, localMatches]);
  const edgeMatches = useMemo(() => new Set(activeHighlight?.edgeIds.filter((id) => {
    const edge = graph.edges.find((edge) => edge.id === id);
    return edge && localMatches.has(edge.source) && localMatches.has(edge.target);
  }) ?? []), [activeHighlight, graph, localMatches]);
  const selection = focusSelection(graph, direct, edgeMatches, filters);
  const focusActive = Boolean(activeHighlight || filters.text || filters.role !== 'all' || filters.evidence !== 'all' || filters.minSupport > 1 || filters.minOutcome > 0);
  const focus: FocusState = { ...selection, direct, active: focusActive, filters };
  const overview = useMemo(() => workflowOverview(graph), [graph]);
  const workflowSummary = Boolean(graph.workflow && graph.detail === 'overview');
  const overviewWorkspace = useMemo(() => createGraphWorkspace(`${workspace.sourceKey}:overview`), [workspace]);
  const isolationKey = focusActive && filters.view === 'isolate' ? JSON.stringify({nodes: [...selection.nodes].sort(), edges: [...selection.edges].sort()}) : null;
  const canvasGraph = useMemo(() => {
    if (isolationKey === null) return graph;
    const selected = JSON.parse(isolationKey) as {nodes: string[]; edges: string[]};
    const ids = new Set(selected.nodes), edgeIds = new Set(selected.edges);
    return { ...graph, nodes: graph.nodes.filter((node) => ids.has(node.id)),
      edges: graph.edges.filter((edge) => edgeIds.has(edge.id) && ids.has(edge.source) && ids.has(edge.target)) };
  }, [graph, isolationKey]);
  // The default overview persists across selection changes; temporary filters have separate coordinates.
  const filteredWorkspace = useMemo(() => isolationKey === null ? workspace
    : createGraphWorkspace(`${workspace.sourceKey}:filtered`), [workspace, isolationKey]);
  const canvasWorkspace = workflowSummary && isolationKey === null ? overviewWorkspace : isolationKey === null ? workspace : filteredWorkspace;
  const canvasKey = workflowSummary && isolationKey === null ? 'overview' : isolationKey ?? 'complete';
  const results = graph.nodes.filter((node) => direct.has(node.id)).sort((a, b) =>
    Number(b.attention === 'key') - Number(a.attention === 'key') || (importanceValue(b, 'outcome') ?? -1) - (importanceValue(a, 'outcome') ?? -1));
  const locateNodes = (ids: string[], inspect = false) => {
    if (ids.length) setLocate((current) => ({ id: ids[0], ids, inspect, nonce: (current?.nonce ?? 0) + 1 }));
  };
  const stateJson = JSON.stringify({ scope, filters, axis, expandedNodeIds: [...expandedFamilies],
    nodeIds: activeHighlight?.nodeIds ?? [], edgeIds: activeHighlight?.edgeIds ?? [], inspectedNodeIds: inspected.nodeIds, inspectedEdgeIds: inspected.edgeIds });
  useEffect(() => {
    workspace.filters = filters; workspace.axis = axis; workspace.expanded = expandedFamilies;
    workspace.focus = activeHighlight ?? undefined;
    onViewStateChange(JSON.parse(stateJson) as GraphViewState);
    // Publish only changes to the graph controls, not parent renders or layout frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateJson, workspace, onViewStateChange]);
  useEffect(() => {
    for (const command of commands) {
      if (appliedCommand.current >= command.nonce || !actionBelongsToGraph(command.action, graph, scope)) continue;
      appliedCommand.current = command.nonce;
      const action = command.action;
      if (action.type === 'highlight_graph' || action.type === 'filter_graph') {
        setHighlight({ scope, nodeIds: action.nodeIds, edgeIds: action.edgeIds });
        setFilters({ ...DEFAULT_GRAPH_FILTERS, view: action.type === 'filter_graph' ? 'isolate' : 'highlight', context: action.context ?? 'workflow' });
      } else if (action.type === 'set_graph_view') {
        if (action.reset) {
          setHighlight(null); setFilters({ ...DEFAULT_GRAPH_FILTERS }); setExpandedFamilies(new Set());
        }
        if (action.axis) setAxis(action.axis);
        setFilters((current) => ({ ...current, ...action.filters,
          ...(action.context ? { context: action.context } : {}), ...(action.links ? { links: action.links } : {}) }));
        setExpandedFamilies((current) => {
          const next = new Set(action.reset ? [] : current);
          action.expandNodeIds?.forEach((id) => { if (graph.nodes.find((node) => node.id === id)!.operationGroups.length > 1) next.add(id); });
          action.collapseNodeIds?.forEach((id) => next.delete(id));
          return next;
        });
        if (action.frame) setFrameRequest((current) => current + 1);
      }
    }
    // A command is applied once; local edits never replay it.
  }, [commands, scope, graph]);
  useEffect(() => { if (frameRequest) locateNodes([...selection.nodes]);
    // Frame the selection after all actions in this stream batch have been applied.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameRequest]);
  const toggle = (id: string) => setExpandedFamilies((current) => {
    const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const traceId = traces.some((trace) => String(trace.id) === highlightTraceId) ? highlightTraceId : undefined;
  const reviewed = graph.semanticReview?.runs.reduce((sum, run) => sum + run.reviewed, 0) ?? null;
  const locateOutcome = (run: string, eventId: string) => {
    const path = resultFlowSelection(graph, run, eventId);
    if (path.nodes.size) {
      setHighlight({ scope, nodeIds: [...path.nodes], edgeIds: [...path.edges] });
      setFilters({ ...DEFAULT_GRAPH_FILTERS });
      locateNodes([...path.nodes]);
    }
  };
  return <section className="space-y-2">
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
      <span className="font-medium text-zinc-700">{graph.workflow ? `${graph.compression.sourceCalls.toLocaleString()} activities · ${graph.nodes.length.toLocaleString()} compact groups · ${graph.compression.expandedActivities ?? 0} key${reviewed !== null ? ` · ${reviewed} reviewed` : ''}` : `${graph.compression.sourceCalls} calls → ${graph.nodes.length} stages`}</span>
      {!graph.workflow ? <span>· {graph.compression.multiCallGroups} multi-call groups</span> : null}<span>· {graph.alignment.sharedPatterns} shared {graph.workflow ? 'activities' : 'patterns'}</span>
      <span className="ml-auto">{graph.semanticReview?.version === 'imported-analysis-snapshot' ? 'Frozen replay · ' : graph.semanticReview ? 'Single-pass review · ' : ''}{graph.modelMetrics.requestCount} new LLM calls{graph.modelMetrics.embeddingRequestCount ? ` + ${graph.modelMetrics.embeddingRequestCount} embedding batches` : ''} · {graph.processingSeconds.toFixed(1)}s processing</span>
    </div>
    {workflowSummary ? <p className="text-[11px] text-slate-500">{graph.resultWindows?.length ? 'All activities within the imported result window are retained.' : 'All activities are retained.'} Compact dots include work awaiting review and work whose role remains uncertain.</p> : null}
    {graph.resultWindows?.map((window) => <p key={window.run} className="text-[11px] text-slate-600">{traces.length > 1 ? `${window.run} · ` : ''}First-best prefix · rounds 1–{window.retainedThroughRound + 1} of {window.sourceThroughRound + 1} · {window.removedEventCount.toLocaleString()} later activities removed at import</p>)}
    {graph.workflow ? overview.results.slice(0, 4).map((result) => <div key={`${result.run}:${result.id}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-2 text-xs text-blue-950"><span className="min-w-0 flex-1">{traces.length > 1 ? `${result.run} · ` : ''}{result.name}: <strong>{result.value}</strong> · first recorded at round <strong>{result.round + 1}</strong>{result.observedThroughRound !== undefined && result.observedThroughRound > result.round ? ` · source history observed through round ${result.observedThroughRound + 1}` : ''}{result.round === 0 ? '. This result already exists in the first round; later activities are not its predecessors.' : ''}</span><button type="button" className="shrink-0 rounded border border-blue-200 bg-white/80 px-2 py-1 font-medium text-blue-800 hover:bg-white" onClick={() => locateOutcome(result.run, result.eventId)}>Locate result</button></div>) : null}
    {graph.semanticReview?.runs.length ? <details className="text-[11px] text-slate-500"><summary className="cursor-pointer">Review coverage · {reviewed}/{graph.compression.sourceCalls.toLocaleString()} activities</summary><div className="mt-1 space-y-1">{graph.semanticReview.runs.map((run) => <p key={run.run}>{traces.length > 1 ? `${run.run} · ` : ''}{run.reviewed} reviewed · {run.total - run.reviewed} unreviewed or uncertain. All recorded activities and dependencies are retained.</p>)}</div></details> : null}
    <div className="rounded-xl border border-slate-200 bg-white p-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <input aria-label="Search tools, subjects or intent" className="h-8 min-w-40 flex-1 rounded-lg border border-slate-200 px-2.5 outline-none focus:ring-2 focus:ring-blue-200" placeholder="Search tools, subjects, intent…" value={filters.text} onChange={(event) => changeFilters({ text: event.target.value })} />
        <button type="button" aria-pressed={filters.role === 'key'} className="rounded-lg px-2 py-1.5 text-slate-600 hover:bg-slate-50 aria-pressed:bg-blue-50 aria-pressed:text-blue-800" onClick={() => changeFilters({ role: filters.role === 'key' ? 'all' : 'key' })}>Key steps</button>
        <button type="button" aria-pressed={filters.evidence === 'main' && filters.context === 'parents' && filters.view === 'isolate'} className="rounded-lg px-2 py-1.5 text-slate-600 hover:bg-slate-50 aria-pressed:bg-blue-50 aria-pressed:text-blue-800" title="Show result-path endpoints, conclusion evidence and their immediate inputs; expand earlier inputs on demand" onClick={() => changeFilters(GRAPH_VIEW_PRESETS.main)}>Main flow</button>
        <button type="button" disabled={traces.length < 2} aria-pressed={filters.minSupport > 1} className="rounded-lg px-2 py-1.5 text-slate-600 hover:bg-slate-50 aria-pressed:bg-blue-50 aria-pressed:text-blue-800 disabled:opacity-40" title="Show dependencies witnessed in at least two runs" onClick={() => changeFilters(GRAPH_VIEW_PRESETS.shared)}>Shared flow</button>
        <details className="relative"><summary className="cursor-pointer rounded-lg px-2 py-1.5 text-slate-600 hover:bg-slate-50">Filters</summary>
          <div className="absolute right-0 top-9 z-30 grid w-64 gap-3 rounded-xl border border-slate-200 bg-white p-3 text-[11px] text-slate-600 shadow-xl [&_select]:max-w-40 [&_select]:rounded [&_select]:border [&_select]:border-slate-200 [&_select]:p-1 [&_label]:flex [&_label]:items-center [&_label]:justify-between">
            <label>Display <select aria-label="Filter display" value={filters.view} onChange={(event) => changeFilters({ view: event.target.value as GraphFilters['view'] })}><option value="highlight">Highlight matches</option><option value="isolate">Focus view</option></select></label>
            <label>Context <select aria-label="Workflow context" value={filters.context} onChange={(event) => changeFilters({ context: event.target.value as GraphFilters['context'] })}><option value="none">Matches only</option><option value="parents">Immediate inputs</option><option value="inputs">All earlier inputs</option><option value="neighbors">One step around matches</option><option value="workflow">Full upstream + downstream</option></select></label>
            <label>Role <select aria-label="Semantic role filter" value={filters.role} onChange={(event) => changeFilters({ role: event.target.value as GraphFilters['role'] })}><option value="all">All roles</option><option value="key">Key</option><option value="supporting">Supporting</option><option value="unknown">Unreviewed / uncertain</option></select></label>
            <label>Evidence <select aria-label="Evidence filter" value={filters.evidence} onChange={(event) => changeFilters({ evidence: event.target.value as GraphFilters['evidence'] })}><option value="all">All</option><option value="main">Result flow</option><option value="supported">Supports conclusion</option><option value="direct">Conclusion evidence</option><option value="path">Recorded result path</option><option value="failure">Failure</option></select></label>
            <label>Connections <select aria-label="Link kind filter" value={filters.links} onChange={(event) => changeFilters({ links: event.target.value as GraphFilters['links'] })}><option value="all">Recorded + inferred</option><option value="recorded">Recorded only</option><option value="inferred">Inferred only</option></select></label>
            <label>Supporting runs <input aria-label="Minimum supporting runs" type="number" min={0} max={traces.length} className="w-16 rounded border border-slate-200 px-1" value={filters.minSupport} onChange={(event) => changeFilters({ minSupport: Number(event.target.value) })} /></label>
            <label>Min association (σ) <input aria-label="Minimum global outcome relevance" type="number" min={0} step={0.01} className="w-16 rounded border border-slate-200 px-1" value={filters.minOutcome} onChange={(event) => changeFilters({ minOutcome: Number(event.target.value) })} /></label>
          </div>
        </details>
        <button type="button" disabled={!selection.nodes.size} className="rounded-lg px-2 py-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-40" onClick={() => locateNodes([...selection.nodes])}>Frame</button>
        <button type="button" className="px-2 text-slate-400 hover:text-slate-700" onClick={() => { setHighlight(null); setFilters({ ...DEFAULT_GRAPH_FILTERS }); }}>All steps</button>
      </div>
      {(focusActive || filters.links !== 'all') ? <div aria-label="Active graph filters" className="mt-2 flex flex-wrap gap-1 text-[10px]">
        {filters.text ? <button type="button" className="rounded-full bg-slate-100 px-2 py-1 text-slate-600" onClick={() => changeFilters({text: ''})}>Search: {filters.text} ×</button> : null}
        {filters.role !== 'all' ? <button type="button" className="rounded-full bg-slate-100 px-2 py-1 text-slate-600" onClick={() => changeFilters({role: 'all'})}>Role: {filters.role} ×</button> : null}
        {filters.evidence !== 'all' ? <button type="button" className="rounded-full bg-slate-100 px-2 py-1 text-slate-600" onClick={() => changeFilters({evidence: 'all'})}>Evidence: {filters.evidence === 'main' ? 'Result flow' : filters.evidence} ×</button> : null}
        {filters.minSupport > 1 ? <button type="button" className="rounded-full bg-slate-100 px-2 py-1 text-slate-600" onClick={() => changeFilters({minSupport: 0})}>Shared by ≥{filters.minSupport} runs ×</button> : null}
        {filters.links !== 'all' ? <button type="button" className="rounded-full bg-slate-100 px-2 py-1 text-slate-600" onClick={() => changeFilters({links: 'all'})}>{filters.links} links ×</button> : null}
        {filters.minOutcome > 0 ? <button type="button" className="rounded-full bg-slate-100 px-2 py-1 text-slate-600" onClick={() => changeFilters({minOutcome: 0})}>Association ≥{filters.minOutcome}σ ×</button> : null}
      </div> : null}
      {focusActive ? <div className="mt-2 border-t border-slate-100 pt-2 text-[11px] text-slate-500">{activeHighlight ? 'Copilot · ' : ''}{direct.size} matches · {selection.nodes.size}/{graph.nodes.length} stages with {filters.context === 'parents' ? 'immediate inputs' : filters.context === 'inputs' ? 'all earlier inputs' : filters.context === 'neighbors' ? 'one-step context' : filters.context === 'workflow' ? 'full path context' : 'no added context'} · {selection.edges.size}/{graph.edges.length} connections{!direct.size && !edgeMatches.size ? ' · No matches; broaden or clear filters.' : ''}{filters.view === 'isolate' && selection.boundaryEdges.size > 0 ? <span className="ml-2 inline-flex items-center gap-2 rounded bg-amber-50 px-2 py-1 text-amber-900">{selection.boundaryEdges.size} earlier input connections outside view<button type="button" className="font-medium underline underline-offset-2" onClick={() => changeFilters({ context: 'inputs' })}>Show all earlier inputs</button></span> : null}<div className="mt-1 flex flex-wrap gap-1">{results.slice(0, 4).map((node) => <button key={node.id} type="button" title={node.label} className="max-w-56 truncate rounded-md bg-blue-50/70 px-2 py-1 text-blue-800" onClick={() => locateNodes([node.id], true)}>{node.methods.slice(0, 2).join(' · ')} · {node.label}</button>)}</div></div> : null}
    </div>
    <SemanticCanvas runResults={runResults} onRunResultsChange={setRunResults} stageOverview={stageOverview} onStageOverview={() => setStageOverview(value => !value)} key={canvasKey} graph={canvasGraph} traces={traces} traceDags={traceDags} selectedTraceId={traceId} workspace={canvasWorkspace} axis={axis} focus={focus} locate={locate} expandedFamilies={expandedFamilies} onToggle={toggle} onAxisChange={setAxis} onInspectionChange={setInspected} publication={publication} onWitnessLocate={(run, eventIds) => {
      const ids = new Set(eventIds);
      const nodeIds = graph.nodes.filter((node) => node.instances.some((instance) => instance.run === run && instance.calls.some((call) => ids.has(call.id)))).map((node) => node.id);
      const edgeIds = graph.edges.filter((edge) => edge.witnesses.some((witness) => witness.run === run && witness.callPath.every((id) => ids.has(id)))).map((edge) => edge.id);
      setHighlight({ scope, nodeIds, edgeIds }); setFilters({ ...DEFAULT_GRAPH_FILTERS, context: 'none' });
      locateNodes(nodeIds, true);
    }} />
    {graph.warnings.length > 0 ? <details className="text-[11px] text-amber-900"><summary className="cursor-pointer">Analysis notes ({graph.warnings.length})</summary><ul className="mt-1 list-disc pl-5">{graph.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details> : null}
    <details className="rounded-lg border border-slate-200 px-2 py-1 text-xs" onToggle={(event) => setEvidenceOpen(event.currentTarget.open)}><summary className="cursor-pointer text-slate-600">Conclusion evidence by run</summary>{evidenceOpen ? <div className="mt-2"><EvidencePanel graph={graph} /></div> : null}</details>
    {graph.omittedCalls.length > 0 ? <details className="rounded-lg border border-slate-200 px-2 py-1 text-xs"><summary className="cursor-pointer">{graph.omittedCalls.length} calls folded by source abstraction</summary><div className="mt-2 space-y-1">{graph.omittedCalls.map((call, index) => { const trace = traces.find((candidate) => String(candidate.id) === call.run); return <RawDetails key={`${call.run}:${call.step}:${index}`} label={`Run ${call.run} · step ${call.step} · ${call.tool}`} value={trace?.toolCalls[call.step - 1] ?? call} />; })}</div></details> : null}
    <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-400"><span>Traces</span>{traces.map((trace, index) => <span key={String(trace.id)} className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-full" style={{ background: traceColor(index).edge }} />{trace.id}</span>)}<span className="ml-auto">Drag positions and zoom stay when selection changes. Ask Copilot to locate a workflow.</span></div>
  </section>;
}
