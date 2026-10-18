'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { createGraphWorkspace, layoutGroups, layoutWorkflowLanes, workflowGeometry, workflowSizeSignature, routeOrthogonal, routePath, curvedRoutePath, workflowLayoutLinks, type Box, type GraphWorkspace, type Point, type WorkflowLayout, type WorkflowNodeContext } from './graph_layout';
import { importanceBackground, importanceMaximum, importanceValue, type ImportanceAxis } from './graph_importance';
import { DEFAULT_GRAPH_FILTERS, focusSelection, matchFamilies, workflowOverview, type GraphFilters } from './graph_search';
import { GraphLegend } from './graph_legend';
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
      label: string;
      intent: string;
      subject?: string;
      sourceLabel?: string;
      decision: JoinedProvenanceNode['importance']['decision'];
      semanticLevel: 'key' | 'supporting' | 'unknown';
      resultStatus: JoinedProvenanceNode['importance']['result']['status'];
      scoreSignal: boolean;
      failure: boolean;
      supportCount: number;
      totalTraceCount: number;
      resultBackbone: boolean;
      directResult: boolean;
      supportTraces: string[];
      callCount: number;
      toolNames: string[];
      occurrenceCount: number;
      stepRange: string;
      occurrences: string[];
      expandable: boolean;
      expanded: boolean;
      promoted: boolean;
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
      semanticLevel: 'key' | 'supporting';
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
  resultPathTraces?: string[];
  supportTraces: string[];
  semanticEdge?: JoinedProvenanceEdge;
  witness?: JoinedProvenanceEdge['witnesses'][number];
  rawEdges?: AgentDag['edges'];
  dag?: AgentDag;
  rawEdgeWitnesses?: Array<{ run: string; edges: AgentDag['edges']; dag: AgentDag }>;
  relevance?: 'relevant' | 'context' | 'unknown';
  jointGroupIds?: string[];
  route?: Point[];
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

const COLLAPSED_SIZE = { width: 256, height: 112 };
const WORKFLOW_CARD_SIZE = { width: 256, height: 136 };
const SUPPORTING_DOT_SIZE = { width: 28, height: 28 };
const ARROW = { type: MarkerType.ArrowClosed, width: 11, height: 11, markerUnits: 'userSpaceOnUse', strokeWidth: 1 };

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

function sourceMarker(label: string) {
  const basename = label.split(/[\\/]/).at(-1) ?? label;
  const stem = basename.replace(/\.[^.]+$/, '');
  const token = stem.split(/[-_\s]+/).filter(Boolean).at(-1) ?? stem;
  const initials = token.match(/[A-Z]/g);
  return initials && initials.length > 1 ? initials.slice(0, 2).join('') : token.slice(0, 2).toUpperCase();
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
  const columnWidths = Array.from({ length: Math.max(...Array.from(levels.values()), 0) + 1 }, () => 240);
  const columnX: number[] = [];
  columnWidths.forEach((width, index) => { columnX[index] = index === 0 ? 24 : columnX[index - 1] + columnWidths[index - 1] + 36; });
  const children: SemanticNode[] = [];
  const edges: SemanticEdge[] = [];
  const heightByLevel = new Map<number, number>();
  operations.forEach(({ operation, members }) => {
    const level = levels.get(operation.id) ?? 0;
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
        supportCount: memberRuns.length, totalTraceCount: traces.length, callCount: operation.members.length, semanticLevel: family.importance.semantic.level,
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
    edges.push({
      id: `operation-flow:${family.id}:${edge.source}:${edge.target}`,
      source: `operation:${family.id}:${edge.source}`, target: `operation:${family.id}:${edge.target}`,
      type: 'workflow', markerEnd: ARROW,
      data: { inferred: false, relation: 'recorded operation flow', supportTraces, rawEdgeWitnesses, resultPathTraces: edge.resultPathTraces, resultPath: edge.resultPathTraces.length > 0 },
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
  axis: ImportanceAxis,
  focusedFamilies?: Set<string>,
) {
  const workflow = (graph as JoinedProvenanceGraph & { workflow?: WorkflowLayout }).workflow;
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
  const firstStep = (family: JoinedProvenanceNode) => Math.min(...family.instances.flatMap((instance) => instance.calls.map((call) => call.step)), Infinity);
  const orderedFamilies = [...graph.nodes].sort((a, b) => firstStep(a) - firstStep(b) || a.label.localeCompare(b.label));
  const maximum = importanceMaximum(graph, axis);
  const expandedGroups = new Set(graph.nodes.filter((family) => family.operationGroups.length > 1 && expandedFamilies.has(family.id)).map((family) => family.id));
  const expandedContents = new Map<string, ReturnType<typeof operationLane>>();
  const groupSizes = new Map<string, { width: number; height: number }>();
  graph.nodes.forEach((family) => {
    const assessment = assessments.get(family.id);
    const assessmentLevel = assessment?.level === 'key' || assessment?.level === 'supporting' || assessment?.level === 'unknown'
      ? assessment.level : workflow ? 'unknown' : family.importance.semantic.level;
    if (!expandedGroups.has(family.id)) {
      groupSizes.set(family.id, workflow ? family.importance.tier === 'failure' ? WORKFLOW_CARD_SIZE : assessmentLevel === 'supporting' ? SUPPORTING_DOT_SIZE : assessmentLevel === 'unknown' ? { width: 34, height: 34 } : WORKFLOW_CARD_SIZE : family.operationGroups.length > 1 && family.importance.decision === 'collapse' && !focusedFamilies?.has(family.id) ? SUPPORTING_DOT_SIZE : COLLAPSED_SIZE);
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
    const expandable = family.operationGroups.length > 1;
    const supportingDot = workflow ? assessmentLevel !== 'key' && family.importance.tier !== 'failure' : expandable && family.importance.decision === 'collapse' && !expandedGroups.has(family.id) && !focusedFamilies?.has(family.id);
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
        background: family.importance.tier === 'failure' ? FAILURE_BACKGROUND : workflow && axis === 'semantic' ? assessmentLevel === 'key' ? '#dbeafe' : assessmentLevel === 'supporting' ? '#eff6ff' : '#f8fafc' : importanceBackground(importanceValue(family, axis), maximum),
        boxShadow: supportingDot ? '0 1px 5px rgb(15 23 42 / 0.16)' : '0 3px 14px rgb(15 23 42 / 0.08)',
      },
      data: {
        kind: 'family',
        label: workflow ? assessment?.semanticLabel || family.label || 'Workflow event' : toolHeading(family),
        intent: sourceLabel ? 'Input' : family.label,
        subject: sourceLabel ? sourceDisplayLabel(sourceLabel) : instanceSubject(family),
        sourceLabel,
        decision: family.importance.decision,
        semanticLevel: workflow ? (assessment?.level === 'key' || assessment?.level === 'supporting' || assessment?.level === 'unknown' ? assessment.level : 'unknown') : family.importance.semantic.level,
        resultStatus: family.importance.result.status,
        scoreSignal: family.importance.facets.some((facet) => facet.id === 'predictive-focus'),
        failure: family.importance.tier === 'failure',
        supportCount,
        totalTraceCount: traces.length,
        resultBackbone: family.resultBackbone,
        directResult: family.instances.some((instance) => instance.resultTargets.length > 0),
        supportTraces: family.supportTraces,
        callCount: family.instances.reduce((count, instance) => count + instance.calls.length, 0),
        toolNames: [...new Set(family.instances.flatMap((instance) => instance.calls.map((call) => call.tool)))],
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
        background: family.importance.tier === 'failure' ? FAILURE_BACKGROUND : workflow && axis === 'semantic' ? assessmentLevel === 'key' ? '#dbeafe' : assessmentLevel === 'supporting' ? '#eff6ff' : '#f8fafc' : importanceBackground(importanceValue(family, axis), maximum),
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
        eventCount: summaries.get(family.id)?.eventCount,
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
  const allNodesById = new Map(allNodes.map((node) => [node.id, node]));
  const familiesById = new Map(graph.nodes.map((family) => [family.id, family]));
  const edges = [...internalEdges, ...crossEdges].map((edge) => {
    const supportTraces = [...new Set(edge.data?.supportTraces ?? [])];
    const selectedSupport = selectedTraceId ? supportTraces.includes(selectedTraceId) : false;
    const selectedResultPath = selectedTraceId
      ? Boolean(edge.data?.semanticEdge?.witnesses.some((witness) => witness.run === selectedTraceId && witness.highlighted)
        || (selectedSupport && (edge.data?.resultPathTraces?.includes(selectedTraceId) ?? false)))
      : Boolean(edge.data?.resultPath);
    const families = [edge.source, edge.target].map((id) => {
      const node = allNodesById.get(id)!;
      return familiesById.get(node.parentId ?? id)!;
    });
    const witnesses = edge.data?.semanticEdge?.witnesses ?? [];
    const jointGroupIds = [...new Set(witnesses.flatMap((witness) => witness.jointGroupIds ?? []))];
    const relevance: SemanticEdgeData['relevance'] = witnesses.some((witness) => witness.relevance === 'relevant') ? 'relevant'
      : witnesses.some((witness) => witness.relevance === 'context') ? 'context' : 'unknown';
    const critical = selectedResultPath || !workflow && (jointGroupIds.length > 0 || relevance === 'relevant'
      || supportTraces.length > 1 && families.some((family) => family.importance.semantic.level === 'key'));
    const color = critical ? RESULT_PATH_COLOR : '#94a3b8';
    return {
      ...edge,
      data: { ...edge.data!, critical, relevance, jointGroupIds },
      style: {
        ...edge.style,
        stroke: selectedTraceId && !selectedSupport ? '#cbd5e1' : critical ? color : relevance === 'unknown' ? '#cbd5e1' : '#94a3b8',
        strokeWidth: supportEdgeWidth(supportTraces.length, selectedResultPath),
        opacity: selectedTraceId && !selectedSupport ? 0.1 : critical ? 0.95 : relevance === 'unknown' ? 0.3 : edge.data?.inferenceKind === 'inferred' ? 0.4 : 0.52,
        strokeDasharray: relevance === 'unknown' ? '2 4' : edge.data?.inferenceKind === 'inferred' ? '6 4' : edge.data?.inferenceKind === 'mixed' ? '2 3' : undefined,
      },
      label: undefined,
      zIndex: selectedResultPath ? 3 : 0,
    };
  });
  return { nodes: allNodes, edges, workflow, contexts };
}

function FamilyNode({ data }: NodeProps<SemanticNode>) {
  const [hovered, setHovered] = useState(false);
  if (data.kind !== 'family') return null;
  const supportingDot = data.workflowMode ? data.semanticLevel !== 'key' && !data.failure : data.expandable && data.decision === 'collapse' && !data.expanded && !data.promoted;
  if (supportingDot) {
    return (
      <div className="relative flex h-full w-full items-center justify-center" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        <span aria-label={data.workflowMode ? `${data.semanticLevel === 'unknown' ? 'Unreviewed / uncertain' : 'Supporting event'}: ${data.label}` : data.sourceLabel ? `Input ${data.sourceLabel}` : `Supporting stage: ${data.label}`} title={data.sourceLabel ?? data.label} className="flex h-6 w-6 items-center justify-center rounded-full border text-[8px] font-semibold text-zinc-700" style={{ borderColor: data.failure ? FAILURE_BORDER : data.semanticLevel === 'unknown' && data.workflowMode ? '#64748b' : data.resultBackbone ? RESULT_PATH_COLOR : '#64748b', borderStyle: data.semanticLevel === 'unknown' && data.workflowMode ? 'dashed' : 'solid', borderWidth: data.semanticLevel === 'unknown' && data.workflowMode ? 2 : Math.min(4, 1 + Math.max(0, data.supportCount - 1) * 0.75), background: data.failure ? FAILURE_BACKGROUND : data.semanticLevel === 'unknown' && data.workflowMode ? '#fff' : data.workflowMode ? '#bfdbfe' : data.background, boxShadow: data.resultBackbone && !data.failure ? '0 0 0 2px #e2e8f0' : undefined }}>
          {data.workflowMode ? '·' : data.sourceLabel ? sourceMarker(data.sourceLabel) : '·'}
        </span>
        <Handle type="target" position={Position.Left} />
        <Handle type="source" position={Position.Right} />
        {hovered ? <div role="tooltip" className="nodrag nopan absolute left-7 top-1/2 z-50 w-64 -translate-y-1/2 rounded-lg border border-zinc-300 bg-white p-3 text-left shadow-xl" onClick={(event) => event.stopPropagation()}>
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 text-xs font-semibold leading-4 text-zinc-900">{data.sourceLabel ? sourceDisplayLabel(data.sourceLabel) : data.label}</span>
            <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-700">{semanticLevelLabel(data.semanticLevel)}</span>
          </div>
          {data.scoreSignal ? <div className="mt-1"><span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-medium text-violet-800">Score signal</span></div> : null}
          {data.sourceLabel ? <div className="mt-1 text-[10px] text-zinc-500">Input · {data.label}</div> : <div className="mt-1 text-[10px] leading-4 text-zinc-600">{data.workflowMode ? `${data.workflowCategory ?? 'Activity'} · ${data.workflowLabel ?? ''} · R${(data.workflowContext?.roundStart ?? 0) + 1}` : `${data.intent}${data.subject ? ` · ${data.subject}` : ''}`}</div>}
          {data.workflowMode && data.assessmentReason ? <div className="mt-1 line-clamp-3 text-[10px] leading-4 text-zinc-600">{data.assessmentReason}</div> : null}
          {data.workflowMode && data.assessedSupportCount !== undefined ? <div className="mt-1 text-[9px] text-zinc-500">Assessed in {data.assessedSupportCount} runs{data.keySupportCount !== undefined ? ` · key in ${data.keySupportCount}` : ''}</div> : null}
          {data.failure ? <div className="mt-1 text-[10px] font-medium text-red-700">Failure</div> : null}
          <div className="mt-2 flex flex-wrap gap-x-2 text-[10px] text-zinc-500"><span>{data.occurrenceCount} occurrences</span><span>{data.workflowMode ? `${data.eventCount ?? data.callCount} events` : `${data.callCount} calls`}</span><span>{data.stepRange}</span></div>
          <ul className="mt-2 max-h-24 space-y-1 overflow-auto text-[10px] leading-4 text-zinc-700">
            {data.occurrences.slice(0, 4).map((occurrence) => <li key={occurrence} className="truncate" title={occurrence}>{occurrence}</li>)}
            {data.occurrenceCount > 4 ? <li className="text-zinc-500">+{data.occurrenceCount - 4} more occurrences</li> : null}
          </ul>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="truncate text-[9px] text-zinc-500" title={data.toolNames.join(' · ')}>{data.toolNames.join(' · ')}</span>
            {data.expandable ? <button type="button" className="shrink-0 rounded border border-zinc-300 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 hover:bg-zinc-50" onClick={() => data.onToggle()} onMouseDown={(event) => event.stopPropagation()}>Expand</button> : null}
          </div>
        </div> : null}
      </div>
    );
  }
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-[11px]" style={{ border: `1px solid ${data.failure ? FAILURE_BORDER : data.workflowMode && data.semanticLevel === 'key' ? '#2563eb' : data.resultBackbone ? RESULT_PATH_COLOR : '#64748b'}`, borderLeftWidth: supportLeftBorder(data.supportCount), background: data.failure ? FAILURE_BACKGROUND : data.background }}>
      <div className="flex h-16 shrink-0 items-start gap-2 border-b border-zinc-200/40 px-3 py-2">
        <span aria-hidden="true" className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-slate-100 text-[9px] font-medium text-slate-600">{data.sourceLabel ? '↳' : data.expandable ? 'Σ' : 'A'}</span>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 break-words text-[12px] font-medium leading-4 text-zinc-900" title={data.label}>{data.label}</div>
          <div className="truncate pt-0.5 text-[10px] font-normal leading-3 text-zinc-500" title={[data.workflowLabel, data.workflowContext ? `Rounds ${data.workflowContext.roundStart + 1}–${data.workflowContext.roundEnd + 1}` : '', data.workflowContext?.phase, data.workflowCategory, data.toolNames.slice(0, 2).join(' · '), data.intent, data.subject ? data.sourceLabel ? data.subject : `Subject: ${data.subject}` : '', !data.subject && data.sourceLabel ? data.sourceLabel : ''].filter(Boolean).join(' · ')}>{data.workflowLabel ? `${data.workflowLabel} · R${(data.workflowContext?.roundStart ?? 0) + 1}${data.workflowContext && data.workflowContext.roundEnd !== data.workflowContext.roundStart ? `–${data.workflowContext.roundEnd + 1}` : ''}${data.toolNames.length ? ` · ${data.toolNames.slice(0, 2).join(' · ')}${data.toolNames.length > 2 ? ` +${data.toolNames.length - 2}` : ''}` : ''}` : [data.intent, data.subject ? data.sourceLabel ? data.subject : `Subject: ${data.subject}` : '', !data.subject && data.sourceLabel ? sourceDisplayLabel(data.sourceLabel) : ''].filter(Boolean).join(' · ')}</div>
        </div>
        {data.expandable ? <button
          type="button"
          className="nodrag nopan inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-zinc-300 text-sm text-zinc-700 hover:bg-zinc-100"
          aria-label={data.expanded ? 'Collapse semantic group' : 'Expand semantic group'}
          title={data.expanded ? 'Collapse group' : 'Expand group'}
          onClick={(event) => { event.stopPropagation(); data.onToggle(); }}
          onMouseDown={(event) => event.stopPropagation()}
        >{data.expanded ? '−' : '+'}</button> : null}
      </div>
      {data.expanded ? <div className="min-h-0 flex-1" /> : data.workflowMode && data.assessmentReason ? <p className="line-clamp-2 px-3 pt-1 text-[9px] leading-3 text-slate-600">{data.assessmentReason}</p> : null}
      <div data-graph-footer className="mt-auto flex h-12 shrink-0 flex-wrap content-center items-center gap-x-1.5 gap-y-0.5 overflow-hidden border-t border-zinc-200/40 px-3 py-1 text-[9px] text-zinc-600">
        {data.workflowSummary ? <span className="w-full truncate" title={data.workflowSummary}>{data.workflowSummary}</span> : null}
        <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">{data.workflowMode && data.semanticLevel === 'key' ? 'Key activity' : semanticLevelLabel(data.semanticLevel)}</span>
        {data.scoreSignal ? <span className="shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-semibold text-violet-800">Score signal</span> : null}
        {data.failure ? <span className="shrink-0 rounded-full bg-red-100 px-1.5 py-0.5 font-semibold text-red-800">Failure</span> : null}
        {!data.workflowMode && data.resultBackbone && !data.directResult && !data.failure ? <span className="shrink-0 rounded-full bg-slate-200 px-1.5 py-0.5 font-semibold text-slate-900">Result path</span> : null}
        {data.importanceLabel ? <span className="font-medium text-indigo-900">{data.importanceLabel}</span> : null}
        {!data.workflowMode ? <><span className="font-medium">{data.callCount} calls</span><span aria-hidden="true">·</span></> : null}
        {!data.workflowMode || data.totalTraceCount > 1 ? <span>{data.supportCount}/{data.totalTraceCount} runs</span> : null}
        {data.workflowMode && data.totalTraceCount > 1 && data.keySupportCount !== undefined ? <span className="text-[8px] text-slate-500">· key in {data.keySupportCount}</span> : null}
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
        <span className="block truncate text-[9px] text-zinc-500">{data.semanticLevel === 'key' ? 'Key analysis' : 'Supporting'} · {data.supportCount}/{data.totalTraceCount} runs · {data.workflowMode ? `${data.callCount} events` : `${data.callCount} calls`}{data.failure ? ' · Failure' : ''}</span>
      </span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { semanticFamily: FamilyNode, semanticOperation: OperationNodeView };

function InitialFit({ workspace, ready, revision, initialNodeIds }: { workspace: GraphWorkspace; ready: boolean; revision: number; initialNodeIds?: string[] }) {
  const initialized = useNodesInitialized();
  const { fitView, getViewport } = useReactFlow();
  const fitted = useRef(workspace.viewport ? revision : -1);
  useEffect(() => {
    if (initialized && ready && (fitted.current !== revision || !workspace.viewport)) {
      const frame = requestAnimationFrame(() => {
        fitted.current = revision;
        void fitView({ nodes: initialNodeIds?.length ? initialNodeIds.map((id) => ({ id })) : undefined,
          padding: 0.14, minZoom: initialNodeIds?.length ? 0.4 : 0.1, maxZoom: 1.2, duration: 0 }).then(() => { workspace.viewport = getViewport(); });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [initialized, ready, revision, fitView, getViewport, workspace, initialNodeIds]);
  return null;
}

function WorkflowEdge(props: EdgeProps<SemanticEdge>) {
  const route = props.data?.route;
  const moved = route && (Math.abs(route[0].x - props.sourceX) + Math.abs(route[0].y - props.sourceY)
    + Math.abs(route[route.length - 1].x - props.targetX) + Math.abs(route[route.length - 1].y - props.targetY) > 12);
  const path = route && !moved ? (props.data?.critical ? routePath(route) : curvedRoutePath(route)) : getSmoothStepPath({ ...props, borderRadius: props.data?.critical ? 0 : 16 })[0];
  return <BaseEdge id={props.id} path={path} style={props.style} markerEnd={props.markerEnd} interactionWidth={14} />;
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
  const laneBounds = new Map<string, { top: number; bottom: number }>();
  roots.forEach((node) => {
    if (node.data.kind !== 'family' || !node.data.workflowContext) return;
    const box = boxes.get(node.id)!;
    const laneId = node.data.workflowContext.laneId;
    const bounds = laneBounds.get(laneId) ?? { top: Infinity, bottom: -Infinity };
    bounds.top = Math.min(bounds.top, box.y); bounds.bottom = Math.max(bounds.bottom, box.y + box.height);
    laneBounds.set(laneId, bounds);
  });
  const workflowTop = Math.min(0, ...roots.map((node) => boxes.get(node.id)!.y)) - 40;
  const workflowRight = Math.max(0, ...roots.map((node) => boxes.get(node.id)!.x + boxes.get(node.id)!.width)) + 32;
  const lanesByTop = [...laneBounds.entries()].sort((a, b) => a[1].top - b[1].top);
  const laneCorridors = new Map(lanesByTop.map(([laneId, bounds], index) => {
    const nextTop = lanesByTop[index + 1]?.[1].top ?? Infinity;
    return [laneId, bounds.bottom + 16 < nextTop ? bounds.bottom + 16 : Math.min(workflowTop, bounds.top - 16)] as const;
  }));
  return edges.map((edge, index) => {
    if (edge.hidden) return edge;
    const source = boxes.get(edge.source)!, target = boxes.get(edge.target)!;
    const sourceNode = byId.get(edge.source)!;
    const targetNode = byId.get(edge.target)!;
    if (sourceNode.data.kind === 'family' && targetNode.data.kind === 'family' && (sourceNode.data.workflowContext || targetNode.data.workflowContext)) {
      const start = { x: source.x + source.width, y: source.y + source.height / 2 };
      const end = { x: target.x, y: target.y + target.height / 2 };
      const critical = Boolean(edge.data?.critical);
      if (!critical) return { ...edge, data: { ...edge.data!, route: [start, end] } };
      const sourceLane = sourceNode.data.workflowContext?.laneId;
      const targetLane = targetNode.data.workflowContext?.laneId;
      const sourceBounds = sourceLane ? laneBounds.get(sourceLane) : undefined;
      const laneCorridor = sourceLane && sourceLane === targetLane && sourceBounds
        ? laneCorridors.get(sourceLane) ?? workflowTop : workflowTop;
      const exitX = start.x + 12;
      const approachX = end.x - 12;
      const route = sourceLane && sourceLane === targetLane
        ? [start, { x: exitX, y: start.y }, { x: exitX, y: laneCorridor }, { x: approachX, y: laneCorridor }, { x: approachX, y: end.y }, end]
        : [start, { x: exitX, y: start.y }, { x: exitX, y: laneCorridors.get(sourceLane ?? '') ?? workflowTop },
          { x: workflowRight, y: laneCorridors.get(sourceLane ?? '') ?? workflowTop }, { x: workflowRight, y: laneCorridors.get(targetLane ?? '') ?? workflowTop },
          { x: approachX, y: laneCorridors.get(targetLane ?? '') ?? workflowTop }, { x: approachX, y: end.y }, end];
      return { ...edge, data: { ...edge.data!, route } };
    }
    const sourceParent = source.parentId ?? source.id, targetParent = target.parentId ?? target.id;
    const obstacles = roots.flatMap((root) => {
      const box = boxes.get(root.id)!;
      const childConnection = (source.parentId === root.id || target.parentId === root.id);
      if (!childConnection || (root.id !== sourceParent && root.id !== targetParent)) return [box];
      return [{ ...box, id: `${box.id}:header`, height: 64 },
        { ...box, id: `${box.id}:footer`, y: box.y + box.height - 48, height: 48 },
        ...nodes.filter((node) => node.parentId === root.id && !node.hidden).map((node) => boxes.get(node.id)!)];
    });
    return { ...edge, data: { ...edge.data!, route: routeOrthogonal(
      { x: source.x + source.width, y: source.y + source.height / 2 },
      { x: target.x, y: target.y + target.height / 2 }, obstacles, index % 3) } };
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
  return graph.nodes.find((node) => node.id === id)?.label ?? 'Semantic step';
}

function witnessCallLabel(graph: JoinedProvenanceGraph, run: string, callId: string, index: number) {
  const call = graph.nodes.flatMap((node) => node.instances.filter((instance) => instance.run === run).flatMap((instance) => instance.calls)).find((candidate) => candidate.id === callId);
  return `Step ${call?.step ?? index + 1} · ${call?.tool ?? 'Tool call'}`;
}

function witnessEvidenceLabel(graph: JoinedProvenanceGraph, run: string, evidence: NonNullable<JoinedProvenanceEdge['witnesses'][number]['evidence']>[number], index: number) {
  const call = graph.nodes.flatMap((node) => node.instances.filter((instance) => instance.run === run).flatMap((instance) => instance.calls)).find((candidate) => candidate.id === evidence.callId);
  return { ...evidence, location: `Step ${call?.step ?? index + 1} · ${call?.tool ?? 'Tool call'} · ${evidence.field}${evidence.path ? evidence.path : ''}` };
}

function OverviewTab({ item, graph, traces }: { item: Inspectable; graph: JoinedProvenanceGraph; traces: Tracing[] }) {
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
      {family.assessment ? <div className="rounded border border-slate-200 bg-slate-50 p-2"><div className="font-medium">{family.assessment.level === 'key' ? 'Key event' : family.assessment.level === 'supporting' ? 'Supporting event' : 'Not assessed'}</div>{family.assessment.reason ? <p className="mt-1 text-zinc-600">{family.assessment.reason}</p> : null}{family.assessment.assessedSupportCount !== undefined || assessmentTraces.length ? <p className="mt-1 text-zinc-500">Across {family.supportCount} runs: {assessedCount} assessed{family.assessment.keySupportCount !== undefined || assessmentTraces.length ? ` · ${keyCount} key · ${supportingCount} supporting · ${unknownCount} unassessed` : ''}</p> : null}{family.assessment.evidence.length ? <RawDetails label={`Assessment evidence (${family.assessment.evidence.length})`} value={family.assessment.evidence} /> : null}</div> : null}
      {jointContexts.length ? <div className="space-y-1"><div className="font-medium text-blue-900">Joint evidence context</div>{jointContexts.map((group) => <details key={group.id} className="rounded border border-blue-200 bg-blue-50/50 p-2"><summary className="cursor-pointer font-medium">{group.label} · {group.sourceCallIds.length} inputs</summary><p className="mt-1 text-zinc-600">{group.reason}</p><ul className="mt-1 space-y-1 text-zinc-600">{group.sourceCallIds.map((id) => {
        const trace = traces.find((trace) => String(trace.id) === group.run);
        const call = trace?.toolCalls.find((item) => item.id === id);
        const delivery = trace?.eventLinks?.find((link) => link.target === id && link.relation === 'delivered_to');
        const sender = delivery ? trace?.toolCalls.find((item) => item.id === delivery.source)?.agentId : undefined;
        return <li key={id}>{sender ? `${sender} → ` : ''}{call?.agentId ?? 'Agent'}{call?.round !== undefined ? ` · Round ${call.round + 1}` : ''} · {call?.name ?? 'Source activity'}</li>;
      })}</ul><p className="mt-2 text-[10px] text-zinc-500">Recorded inputs considered together; this does not demonstrate a causal effect.</p><RawDetails label="Joint source evidence" value={group.evidence} /></details>)}</div> : null}
      <EvidencePanel graph={graph} callsByRun={callsByRun} />
      <div><div className="mb-1 font-medium text-zinc-700">Runs</div><TracePills runs={family.supportTraces} traces={traces} /></div>
      <div><div className="mb-1 font-semibold text-zinc-700">Run variants</div><div className="space-y-1">{family.variants.map((variant, index) => { const instance = family.instances.find((candidate) => candidate.id === variant.instanceId); const steps = instance?.calls.map((call) => call.step) ?? []; const stepLabel = steps.length ? ` · steps ${Math.min(...steps)}–${Math.max(...steps)}` : ''; return <RawDetails key={`${variant.run}:${variant.instanceId}`} label={`Run ${variant.run} · instance ${index + 1}${stepLabel}`} value={{ roleBindings: variant.roleBindings, parameters: variant.parameters, diagnostics: variant.diagnostics, evidence: variant.evidence, instance: instance ? { internalFlow: instance.internalFlow, resultTargets: instance.resultTargets, resultBackbone: instance.resultBackbone, background: instance.background, targetEvidence: instance.targetEvidence } : null }} />; })}</div></div>
    </div>;
  }
  if (item.kind === 'operation') {
    const callsByRun = new Map<string, Set<string>>();
    item.members.forEach(({ member }) => callsByRun.set(member.run, new Set([...(callsByRun.get(member.run) ?? []), member.callId])));
    return <div className="space-y-3 text-xs">
    <div className="text-base font-semibold">{item.operation.tool}</div>
    {item.operation.failure ? <div className="rounded border border-red-300 bg-red-50 px-2 py-1 font-medium text-red-800">Recorded failure</div> : null}
    <div className="grid grid-cols-2 gap-2"><Metric label="Traces" value={new Set(item.members.map(({ member }) => member.run)).size} /><Metric label="Calls" value={item.members.length} /></div>
    <EvidencePanel graph={graph} callsByRun={callsByRun} />
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

function Inspector({ item, graph, traces, onClose }: { item: Inspectable | null; graph: JoinedProvenanceGraph; traces: Tracing[]; onClose: () => void }) {
  const [collapsedItem, setCollapsedItem] = useState<Inspectable | null>(null);
  const [tab, setTab] = useState<InspectorTab>('overview');
  if (!item) return null;
  const itemKey = item.kind === 'family' ? item.family.id : item.kind === 'operation' ? item.operation.id : item.edge.id;
  const collapsed = collapsedItem === item;
  return <aside className={`nodrag nopan absolute bottom-2 right-2 z-20 flex max-h-[58%] ${collapsed ? 'w-40' : 'w-[min(27rem,calc(100%-1rem))]'} resize flex-col overflow-auto rounded-lg border border-zinc-300 bg-white/95 shadow-xl backdrop-blur`} onMouseDown={(event) => event.stopPropagation()}>
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-200 px-2">
      <span className="flex-1 truncate text-xs font-semibold text-zinc-800">Details</span>
      <button type="button" className="text-xs text-zinc-500 hover:text-zinc-900" onClick={() => setCollapsedItem(collapsed ? null : item)}>{collapsed ? 'Expand' : 'Collapse'}</button>
      <button type="button" aria-label="Clear selection" className="text-xs text-zinc-500 hover:text-zinc-900" onClick={onClose}>×</button>
    </div>
    {!collapsed ? <>
      <div className="flex shrink-0 border-b border-zinc-200 px-1">{(['overview', 'importance', 'calls', 'connections'] as const).map((value) => <button key={value} type="button" aria-pressed={tab === value} className={`px-2 py-1.5 text-[10px] capitalize ${tab === value ? 'border-b-2 border-indigo-500 font-semibold text-zinc-900' : 'text-zinc-500'}`} onClick={() => setTab(value)}>{value}</button>)}</div>
      <div className="min-h-20 flex-1 overflow-auto p-3">
        {tab === 'overview' ? <OverviewTab key={itemKey} item={item} graph={graph} traces={traces} /> : null}
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
    let position = !node.parentId || workspace.pinned.has(node.id) ? workspace.positions.get(node.id) ?? node.position : node.position;
    if (!node.parentId) return { ...node, position };
    const parent = items.find((candidate) => candidate.id === node.parentId)!;
    position = { x: Math.max(16, Math.min(position.x, Number(parent.style!.width) - Number(node.style!.width) - 16)),
      y: Math.max(80, Math.min(position.y, Number(parent.style!.height) - Number(node.style!.height) - 56)) };
    return { ...node, position, extent: [[16, 80], [Number(parent.style!.width) - 16, Number(parent.style!.height) - 56]] };
  });
}

function LocateStep({ target }: { target: { id: string; ids?: string[]; nonce: number } | null }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (target) void fitView({ nodes: (target.ids ?? [target.id]).map((id) => ({ id })), padding: 0.35, maxZoom: 1.2, duration: 180 });
  }, [target, fitView]);
  return null;
}

function SemanticCanvas({ graph, traces, traceDags, selectedTraceId, workspace, axis, focus, locate, expandedFamilies, onToggle, onAxisChange, onInspectionChange, onWitnessLocate }: {
  graph: JoinedProvenanceGraph; traces: Tracing[]; traceDags: Record<string, AgentDag>;
  selectedTraceId?: string; workspace: GraphWorkspace; axis: ImportanceAxis;
  onInspectionChange: (selection: { nodeIds: string[]; edgeIds: string[] }) => void;
  onWitnessLocate: (run: string, eventIds: string[]) => void;
  expandedFamilies: Set<string>; onToggle: (id: string) => void; onAxisChange: (axis: ImportanceAxis) => void;
  focus: FocusState; locate: { id: string; ids?: string[]; nonce: number; inspect?: boolean } | null;
}) {
  const [selected, setSelected] = useState<Inspectable | null>(null);
  useEffect(() => {
    onInspectionChange({ nodeIds: selected && selected.kind !== 'connection' ? [selected.family.id] : [],
      edgeIds: selected?.kind === 'connection' ? [selected.edge.id] : [] });
  }, [selected, onInspectionChange]);
  const [revision, setRevision] = useState(0);
  const [layoutKey, setLayoutKey] = useState('');
  const [layoutError, setLayoutError] = useState('');
  const [routingNodes, setRoutingNodes] = useState<SemanticNode[]>([]);
  const processed = useRef('');
  const inspectedLocate = useRef<number | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const rendered = useMemo(() => semanticGraph(graph, expandedFamilies, traceDags, traces, selectedTraceId, onToggle, axis, focus.active ? focus.direct : undefined),
    // Expansion lives in the shared graph controls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, expandedFamilies, traceDags, traces, selectedTraceId, axis, workspace, focus.active, focus.direct]);
  const geometryKey = JSON.stringify([revision, rendered.workflow, rendered.nodes.map((node) => [node.id, node.parentId, node.style!.width, node.style!.height, node.data.kind === 'family' ? node.data.workflowContext : undefined]),
    rendered.edges.map((edge) => [edge.id, edge.source, edge.target])]);
  const [nodes, setNodes, onNodesChange] = useNodesState<SemanticNode>([]);
  useEffect(() => {
    if (processed.current === geometryKey) return;
    let active = true;
    const roots = rendered.nodes.filter((node) => !node.parentId).map((node) => ({
      id: node.id, ...node.position, width: Number(node.style!.width), height: Number(node.style!.height),
    }));
    const rootIds = new Set(roots.map((node) => node.id));
    if (workspace.sizes.size && roots.length && !roots.some((node) => workspace.sizes.has(node.id))) workspace.viewport = undefined;
    const links = rendered.workflow ? [] : workflowLayoutLinks(graph).filter((edge) => rootIds.has(edge.source) && rootIds.has(edge.target));
    const arrange = rendered.workflow
      ? Promise.resolve(layoutWorkflowLanes(roots, rendered.workflow, rendered.contexts, workspace))
      : layoutGroups(roots, links, workspace);
    void arrange.then((positions) => {
      if (!active) return;
      positions.forEach((position, id) => workspace.positions.set(id, position));
      if (rendered.workflow) workspace.sizes.clear();
      roots.forEach((box) => workspace.sizes.set(box.id, rendered.workflow ? workflowSizeSignature(box) : `${box.width}:${box.height}`));
      const positioned = workspaceNodes(rendered.nodes, workspace);
      setNodes(positioned); setRoutingNodes(positioned);
      processed.current = geometryKey;
      setLayoutKey(geometryKey); setLayoutError('');
    }).catch((error: Error) => { if (active) setLayoutError(error.message); });
    return () => { active = false; };
  }, [rendered, graph, geometryKey, workspace, setNodes]);
  useEffect(() => {
    if (layoutKey !== geometryKey) return;
    const positioned = workspaceNodes(rendered.nodes, workspace);
    setNodes(positioned); setRoutingNodes(positioned);
  }, [rendered, layoutKey, geometryKey, workspace, setNodes]);
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
    const id = familyOf(node), direct = focus.direct.has(id), included = focus.nodes.has(id);
    return { ...node, hidden: focus.active && focus.filters.view === 'isolate' && !included,
      style: { ...node.style, opacity: Math.min(Number(node.style?.opacity ?? 1), focus.active ? direct ? 1 : included ? 0.55 : 0.12 : 1),
        boxShadow: focus.active && direct && !node.parentId ? '0 0 0 2px rgb(99 102 241 / 0.6)' : node.style?.boxShadow } };
  });
  const visibleNodes = decorateNodes(nodes);
  const baseById = new Map(rendered.nodes.map((node) => [node.id, node]));
  const styledEdges = rendered.edges.map((edge) => {
    const source = familyOf(baseById.get(edge.source)!), target = familyOf(baseById.get(edge.target)!);
    const kind = edge.data?.inferenceKind ?? (edge.data?.inferred ? 'inferred' : 'recorded');
    const allowed = focus.filters.links === 'all' || (focus.filters.links === 'recorded' ? kind !== 'inferred' : kind !== 'recorded');
    const included = edge.data?.semanticEdge ? focus.edges.has(edge.data.semanticEdge.id) : focus.nodes.has(source) && focus.nodes.has(target);
    const hidden = !allowed || focus.active && focus.filters.view === 'isolate' && (!focus.nodes.has(source) || !focus.nodes.has(target) || !included);
    return { ...edge, hidden, style: { ...edge.style,
      opacity: Math.min(Number(edge.style?.opacity ?? 1), focus.active ? included ? 1 : 0.08 : 1) } };
  });
  const routeKey = JSON.stringify([focus.active, focus.filters.view, focus.filters.links, [...focus.nodes], [...focus.edges]]);
  const ready = layoutKey === geometryKey;
  const workflowBoxes = rendered.nodes.filter((node) => !node.parentId).map((node) => ({ id: node.id, x: 0, y: 0, width: Number(node.style!.width), height: Number(node.style!.height) }));
  const laneGeometry = rendered.workflow ? workflowGeometry(workflowBoxes, rendered.workflow, rendered.contexts) : undefined;
  const initialRounds = new Set(laneGeometry?.roundStarts.slice(0, 3) ?? []);
  const initialNodeIds = rendered.workflow ? rendered.nodes.filter((node) => !node.parentId && node.data.kind === 'family'
    && (graph.detail === 'overview' || initialRounds.has(node.data.workflowContext?.roundStart ?? -1))).map((node) => node.id) : undefined;
  const routes = useMemo(() => ready ? routedEdges(decorateNodes(routingNodes), styledEdges) : [],
    // Node geometry is snapshotted on layout and drag-end; avoid rerouting the entire graph each drag frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, routingNodes, rendered.edges, routeKey, selectedTraceId]);
  const workflowInsights = graph.workflowInsights;
  return <div ref={canvasRef} className="space-y-2">
    <WorkflowInsightsPanel insights={workflowInsights} onLocate={onWitnessLocate} />
    <div className="relative h-[40rem] overflow-hidden rounded-lg border border-zinc-200 bg-slate-50">
    <GraphLegend axis={axis} maximum={importanceMaximum(graph, axis)} traceCount={traces.length} onAxisChange={onAxisChange} flowColor={RESULT_PATH_COLOR} />
    <button type="button" className="absolute right-2 top-2 z-10 rounded border border-zinc-300 bg-white/95 px-2 py-1 text-[11px] text-zinc-600 shadow-sm" onClick={() => {
      workspace.positions.clear(); workspace.sizes.clear(); workspace.pinned.clear(); workspace.viewport = undefined;
      processed.current = ''; setRevision((value) => value + 1);
    }}>Rearrange</button>
    {!ready ? <div className="absolute left-52 top-3 z-10 rounded bg-white/95 px-2 py-1 text-xs text-zinc-500">{layoutError || 'Arranging workflow…'}</div> : null}
    <ReactFlow
      nodes={ready ? visibleNodes : []} edges={ready ? routes : []} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onlyRenderVisibleElements
      onNodesChange={onNodesChange}
      onNodeDragStop={(_, node, moved) => {
        const movedById = new Map(moved.map((item) => [item.id, item])); movedById.set(node.id, node);
        movedById.forEach((item) => { workspace.positions.set(item.id, item.position); workspace.pinned.add(item.id); });
        setRoutingNodes(nodes.map((item) => movedById.has(item.id) ? { ...item, position: movedById.get(item.id)!.position } : item));
      }}
      onMoveEnd={(_, viewport) => { workspace.viewport = viewport; }}
      defaultViewport={workspace.viewport}
      onNodeClick={(_, node) => setSelected(node.data.inspectable)}
      onEdgeClick={(_, edge) => setSelected({ kind: 'connection', edge: edge.data!.semanticEdge ?? { id: edge.id, source: edge.source, target: edge.target, supportCount: edge.data!.supportTraces.length, supportTraces: edge.data!.supportTraces, witnesses: [], inferred: edge.data!.inferred }, witness: edge.data!.witness, rawEdges: edge.data!.rawEdges, dag: edge.data!.dag, rawEdgeWitnesses: edge.data!.rawEdgeWitnesses })}
      nodeOrigin={[0, 0]} minZoom={0.1} nodesDraggable nodesConnectable={false} elementsSelectable
      proOptions={{ hideAttribution: true }} defaultEdgeOptions={{ type: 'workflow', markerEnd: ARROW }}
    >
      {rendered.workflow && laneGeometry ? <ViewportPortal><div className="pointer-events-none absolute left-0 top-0 -z-10" aria-hidden="true">
        {rendered.workflow.lanes.map((lane, index) => <div key={lane.id} className="absolute rounded-lg border border-slate-200/80 bg-white/45" style={{ left: 16, top: 38 + index * laneGeometry.laneHeight, width: laneGeometry.totalWidth + 32, height: laneGeometry.laneHeight - 4 }}>
          <div className="absolute left-3 top-2 text-[11px] font-semibold text-slate-500">{lane.label}</div>
        </div>)}
        {laneGeometry.roundStarts.filter((_, index, rounds) => rounds.length <= 12 || index === 0 || index === rounds.length - 1 || index % 10 === 0).map((round) => {
          const last = Math.max(round, ...[...rendered.contexts.values()].filter((context) => context.roundStart === round).map((context) => context.roundEnd));
          return <div key={round} className="absolute top-2 text-[10px] font-medium text-slate-400" style={{ left: 48 + (laneGeometry.roundOffsets.get(round) ?? 0) }}>{rendered.workflow!.roundLabel || 'Round'} {round + 1}{last > round ? `–${last + 1}` : ''}</div>;
        })}
      </div></ViewportPortal> : null}
      <Background color="#cbd5e1" gap={20} size={1} />
      <Controls position="bottom-left" showInteractive={false} fitViewOptions={{ padding: 0.14, minZoom: 0.1 }} />
      <InitialFit workspace={workspace} ready={ready} revision={revision} initialNodeIds={initialNodeIds} />
      <LocateStep target={ready ? locate : null} />
    </ReactFlow>
    <Inspector item={selected} graph={graph} traces={traces} onClose={() => setSelected(null)} />
    </div>
  </div>;
}

export function SemanticGraphView({ graph, traces, traceDags, highlightTraceId, workspace, commands, onViewStateChange }: {
  graph: JoinedProvenanceGraph; traces: Tracing[]; traceDags: Record<string, AgentDag>;
  highlightTraceId?: string; workspace: GraphWorkspace; commands: GraphCommand[];
  onViewStateChange: (state: GraphViewState) => void;
}) {
  const [filters, setFilters] = useState<GraphFilters>(() => workspace.filters ?? { ...DEFAULT_GRAPH_FILTERS });
  const [axis, setAxis] = useState<ImportanceAxis>(() => workspace.axis ?? (graph.workflow ? 'semantic' : 'outcome'));
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
    setFilters((current) => ({ ...current, ...patch }));
  };
  const localMatches = useMemo(() => matchFamilies(graph, filters), [graph, filters]);
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
  const isolationKey = graph.workflow && focusActive && filters.view === 'isolate' ? JSON.stringify([...selection.nodes].sort())
    : workflowSummary ? JSON.stringify([...new Set([...overview.nodeIds, ...(focusActive ? selection.nodes : [])])].sort()) : null;
  const canvasGraph = useMemo(() => {
    if (isolationKey === null) return graph;
    const ids = new Set<string>(JSON.parse(isolationKey));
    return { ...graph, nodes: graph.nodes.filter((node) => ids.has(node.id)),
      edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) };
  }, [graph, isolationKey]);
  // The default overview persists across selection changes; temporary filters have separate coordinates.
  const filteredWorkspace = useMemo(() => isolationKey === null ? workspace
    : createGraphWorkspace(`${workspace.sourceKey}:filtered`), [workspace, isolationKey]);
  const canvasWorkspace = workflowSummary && !focusActive ? overviewWorkspace : isolationKey === null ? workspace : filteredWorkspace;
  const canvasKey = workflowSummary && !focusActive ? 'overview' : isolationKey ?? 'complete';
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
        if (action.frame) setFrameRequest(command.nonce);
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
  const review = graph.workflowAssessment?.retrieval;
  const reviewed = typeof review?.assessedEvents === 'number' ? review.assessedEvents : null;
  const cachedRounds = typeof review?.cachedRounds === 'number' ? review.cachedRounds : 0;
  const roundCount = (typeof review?.requestCount === 'number' ? review.requestCount : 0) + cachedRounds;
  return <section className="space-y-2">
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
      <span className="font-medium text-zinc-700">{graph.workflow ? `${canvasGraph.nodes.length} activities shown · ${graph.compression.sourceCalls.toLocaleString()} in full history${reviewed !== null ? ` · ${reviewed} reviewed` : ''} · ${graph.compression.expandedActivities ?? 0} key` : `${graph.compression.sourceCalls} calls → ${graph.nodes.length} stages`}</span>
      {!graph.workflow ? <span>· {graph.compression.multiCallGroups} multi-call groups</span> : null}<span>· {graph.alignment.sharedPatterns} shared {graph.workflow ? 'activities' : 'patterns'}</span>
      <span className="ml-auto">{graph.workflow ? `${roundCount} review rounds · ${cachedRounds} cached · ` : ''}{graph.modelMetrics.requestCount} new model calls · {graph.modelMetrics.elapsedSeconds.toFixed(1)}s</span>
    </div>
    {workflowSummary ? <p className="text-[11px] text-slate-500">Result and evidence flow · unrelated or unreviewed history is hidden here, not judged unimportant. Open Full history to inspect every activity.</p> : null}
    {graph.workflow ? overview.results.slice(0, 4).map((result) => <p key={`${result.run}:${result.id}`} className="rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-2 text-xs text-blue-950">{traces.length > 1 ? `${result.run} · ` : ''}{result.name}: <strong>{result.value}</strong> · first recorded at round <strong>{result.round + 1}</strong>{result.observedThroughRound !== undefined && result.observedThroughRound > result.round ? ` · run continues through round ${result.observedThroughRound + 1}` : ''}{result.round === 0 ? '. This result already exists in the first round; later activities are not its predecessors.' : ''}</p>) : null}
    {graph.workflowAssessment?.runs?.length ? <details className="text-[11px] text-slate-500"><summary className="cursor-pointer">Review coverage and stopping reason</summary><div className="mt-1 space-y-1">{graph.workflowAssessment.runs.map(({ run, retrieval }) => <p key={run}>{traces.length > 1 ? `${run} · ` : ''}{retrieval.assessedEvents} reviewed · {retrieval.unassessedEvents} outside review · {retrieval.stopReason === 'result_has_no_predecessors' ? 'Result has no earlier recorded inputs' : retrieval.stopReason === 'round_limit' ? 'Review budget reached' : retrieval.stopReason === 'link_judgments_incomplete' ? 'Some input links remain uncertain' : retrieval.stopReason?.replaceAll('_', ' ')}{retrieval.remainingFrontier ? ` · ${retrieval.remainingFrontier} upstream activities pending` : ''}</p>)}</div></details> : null}
    <div className="rounded-xl border border-slate-200 bg-white p-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <input aria-label="Search tools, subjects or intent" className="h-8 min-w-40 flex-1 rounded-lg border border-slate-200 px-2.5 outline-none focus:ring-2 focus:ring-blue-200" placeholder="Search tools, subjects, intent…" value={filters.text} onChange={(event) => changeFilters({ text: event.target.value })} />
        <button type="button" aria-pressed={filters.role === 'key'} className="rounded-lg px-2 py-1.5 text-slate-600 hover:bg-slate-50 aria-pressed:bg-blue-50 aria-pressed:text-blue-800" onClick={() => changeFilters({ role: filters.role === 'key' ? 'all' : 'key' })}>Key steps</button>
        <button type="button" aria-pressed={filters.evidence === 'path'} className="rounded-lg px-2 py-1.5 text-slate-600 hover:bg-slate-50 aria-pressed:bg-blue-50 aria-pressed:text-blue-800" onClick={() => changeFilters({ evidence: filters.evidence === 'path' ? 'all' : 'path', links: filters.evidence === 'path' ? 'all' : 'recorded' })}>Result flow</button>
        <button type="button" disabled={traces.length < 2} aria-pressed={filters.minSupport > 1} className="rounded-lg px-2 py-1.5 text-slate-600 hover:bg-slate-50 aria-pressed:bg-blue-50 aria-pressed:text-blue-800 disabled:opacity-40" onClick={() => changeFilters({ minSupport: filters.minSupport > 1 ? 0 : 2 })}>Shared</button>
        <details className="relative"><summary className="cursor-pointer rounded-lg px-2 py-1.5 text-slate-600 hover:bg-slate-50">Filters</summary>
          <div className="absolute right-0 top-9 z-30 grid w-64 gap-3 rounded-xl border border-slate-200 bg-white p-3 text-[11px] text-slate-600 shadow-xl [&_select]:max-w-40 [&_select]:rounded [&_select]:border [&_select]:border-slate-200 [&_select]:p-1 [&_label]:flex [&_label]:items-center [&_label]:justify-between">
            <label>Display <select aria-label="Filter display" value={filters.view} onChange={(event) => changeFilters({ view: event.target.value as GraphFilters['view'] })}><option value="highlight">Highlight matches</option><option value="isolate">Only matching flow</option></select></label>
            <label>Context <select aria-label="Workflow context" value={filters.context} onChange={(event) => changeFilters({ context: event.target.value as GraphFilters['context'] })}><option value="none">Matches only</option><option value="workflow">Upstream + downstream</option></select></label>
            <label>Role <select aria-label="Semantic role filter" value={filters.role} onChange={(event) => changeFilters({ role: event.target.value as GraphFilters['role'] })}><option value="all">All roles</option><option value="key">Key</option><option value="supporting">Supporting</option><option value="unknown">Unreviewed / uncertain</option></select></label>
            <label>Evidence <select aria-label="Evidence filter" value={filters.evidence} onChange={(event) => changeFilters({ evidence: event.target.value as GraphFilters['evidence'] })}><option value="all">All</option><option value="direct">Conclusion evidence</option><option value="path">Recorded result path</option><option value="failure">Failure</option></select></label>
            <label>Connections <select aria-label="Link kind filter" value={filters.links} onChange={(event) => changeFilters({ links: event.target.value as GraphFilters['links'] })}><option value="all">Recorded + inferred</option><option value="recorded">Recorded only</option><option value="inferred">Inferred only</option></select></label>
            <label>Min support <input aria-label="Minimum supporting runs" type="number" min={0} max={traces.length} className="w-16 rounded border border-slate-200 px-1" value={filters.minSupport} onChange={(event) => changeFilters({ minSupport: Number(event.target.value) })} /></label>
            <label>Min association (σ) <input aria-label="Minimum global outcome relevance" type="number" min={0} step={0.01} className="w-16 rounded border border-slate-200 px-1" value={filters.minOutcome} onChange={(event) => changeFilters({ minOutcome: Number(event.target.value) })} /></label>
          </div>
        </details>
        <button type="button" disabled={!selection.nodes.size} className="rounded-lg px-2 py-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-40" onClick={() => locateNodes([...selection.nodes])}>Frame</button>
        <button type="button" className="px-2 text-slate-400 hover:text-slate-700" onClick={() => { setHighlight(null); setFilters({ ...DEFAULT_GRAPH_FILTERS }); }}>Clear</button>
      </div>
      {focusActive ? <div className="mt-2 border-t border-slate-100 pt-2 text-[11px] text-slate-500">{activeHighlight ? 'Copilot · ' : ''}{direct.size} matching stages · {selection.nodes.size} with context{!direct.size && !edgeMatches.size ? ' · No matches; broaden or clear filters.' : ''}<div className="mt-1 flex flex-wrap gap-1">{results.slice(0, 4).map((node) => <button key={node.id} type="button" title={node.label} className="max-w-56 truncate rounded-md bg-blue-50/70 px-2 py-1 text-blue-800" onClick={() => locateNodes([node.id], true)}>{node.methods.slice(0, 2).join(' · ')} · {node.label}</button>)}</div></div> : null}
    </div>
    <SemanticCanvas key={canvasKey} graph={canvasGraph} traces={traces} traceDags={traceDags} selectedTraceId={traceId} workspace={canvasWorkspace} axis={axis} focus={focus} locate={locate} expandedFamilies={expandedFamilies} onToggle={toggle} onAxisChange={setAxis} onInspectionChange={setInspected} onWitnessLocate={(run, eventIds) => {
      const ids = new Set(eventIds);
      const nodeIds = graph.nodes.filter((node) => node.instances.some((instance) => instance.run === run && instance.calls.some((call) => ids.has(call.id)))).map((node) => node.id);
      const edgeIds = graph.edges.filter((edge) => edge.witnesses.some((witness) => witness.run === run && witness.callPath.every((id) => ids.has(id)))).map((edge) => edge.id);
      setHighlight({ scope, nodeIds, edgeIds }); setFilters({ ...DEFAULT_GRAPH_FILTERS, context: 'none' });
      locateNodes(nodeIds, true);
    }} />
    {graph.warnings.length > 0 ? <details className="text-[11px] text-amber-900"><summary className="cursor-pointer">Analysis notes ({graph.warnings.length})</summary><ul className="mt-1 list-disc pl-5">{graph.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details> : null}
    <details className="rounded-lg border border-slate-200 px-2 py-1 text-xs" onToggle={(event) => setEvidenceOpen(event.currentTarget.open)}><summary className="cursor-pointer text-slate-600">Conclusion evidence by run</summary>{evidenceOpen ? <div className="mt-2"><EvidencePanel graph={graph} /></div> : null}</details>
    {graph.omittedCalls.length > 0 ? <details className="rounded-lg border border-slate-200 px-2 py-1 text-xs"><summary className="cursor-pointer">{graph.omittedCalls.length} hidden original calls</summary><div className="mt-2 space-y-1">{graph.omittedCalls.map((call, index) => { const trace = traces.find((candidate) => String(candidate.id) === call.run); return <RawDetails key={`${call.run}:${call.step}:${index}`} label={`Run ${call.run} · step ${call.step} · ${call.tool}`} value={trace?.toolCalls[call.step - 1] ?? call} />; })}</div></details> : null}
    <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-400"><span>Traces</span>{traces.map((trace, index) => <span key={String(trace.id)} className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-full" style={{ background: traceColor(index).edge }} />{trace.id}</span>)}<span className="ml-auto">Drag positions and zoom stay when selection changes. Ask Copilot to locate a workflow.</span></div>
  </section>;
}
