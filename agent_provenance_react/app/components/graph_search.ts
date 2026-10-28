import type { JoinedProvenanceGraph, JoinedProvenanceNode, JoinedProvenanceEdge } from './types';

export type GraphFilters = {
  text: string;
  role: 'all' | 'key' | 'supporting' | 'unknown';
  evidence: 'all' | 'direct' | 'supported' | 'main' | 'path' | 'failure';
  minSupport: number;
  minOutcome: number;
  links: 'all' | 'recorded' | 'inferred';
  view: 'highlight' | 'isolate';
  context: 'none' | 'parents' | 'inputs' | 'neighbors' | 'workflow';
};

export const DEFAULT_GRAPH_FILTERS: GraphFilters = {
  text: '', role: 'all', evidence: 'all', minSupport: 0, minOutcome: 0, links: 'all', view: 'highlight', context: 'none',
};

export const GRAPH_VIEW_PRESETS = {
  all: { ...DEFAULT_GRAPH_FILTERS },
  main: { ...DEFAULT_GRAPH_FILTERS, evidence: 'main', context: 'parents', view: 'isolate' },
  shared: { ...DEFAULT_GRAPH_FILTERS, minSupport: 2, context: 'inputs', view: 'isolate' },
  failures: { ...DEFAULT_GRAPH_FILTERS, evidence: 'failure', context: 'inputs', view: 'isolate' },
} satisfies Record<string, GraphFilters>;

const words = (text: string) => text.toLocaleLowerCase().split(/\s+/).filter(Boolean);
const claimText = (node: JoinedProvenanceNode) => node.instances.flatMap((instance) => instance.resultEvidence?.map((evidence) => evidence.claimText) ?? []).join(' ');
const isFailure = (node: JoinedProvenanceNode) => node.operationGroups.some((operation) => operation.failure);
const hasDirectEvidence = (node: JoinedProvenanceNode) => ['supported', 'contradicted', 'referenced'].includes(node.importance.result.status) || node.instances.some((instance) => instance.resultTargets.length > 0);
const hasPathEvidence = (node: JoinedProvenanceNode) => node.resultBackbone || node.importance.result.onRecordedPath || node.instances.some((instance) => instance.resultBackbone);
const supportsConclusion = (node: JoinedProvenanceNode, outcomes: Set<string>) => node.instances.some((instance) =>
  instance.resultEvidence?.some((link) => link.relation === 'supports') ||
  [...instance.calls.map((call) => call.id), ...instance.internalCalls].some((id) => outcomes.has(`${instance.run}\0${id}`)));

/** Importance changes prominence, never whether an activity exists in the overview. */
export function workflowOverview(graph: JoinedProvenanceGraph) {
  const results = (graph.structuredOutcomes ?? []).flatMap(({ run, outcomes }) => {
    const system = outcomes.filter((outcome) => outcome.scope !== 'participant');
    const finals = system.filter((outcome) => outcome.terminal || outcome.kind === 'final');
    return (finals.length ? finals : system.slice(-1)).map((outcome) => ({ run, ...outcome }));
  });
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  return { nodeIds, results };
}

/** Follow reviewed witnesses within one execution, retaining occurrence ports. */
export function resultFlowSelection(graph: JoinedProvenanceGraph, run: string, eventId: string) {
  const containsEvent = (instance: JoinedProvenanceNode['instances'][number]) => instance.run === run
    && (instance.calls.some((call) => call.id === eventId) || instance.internalCalls.includes(eventId));
  const target = graph.nodes.find((node) => node.instances.some(containsEvent));
  const nodes = new Set<string>();
  const edges = new Set<string>();
  if (!target) return { nodes, edges };
  nodes.add(target.id);
  const queue = target.instances.filter(containsEvent).map((instance) => instance.id);
  const visited = new Set(queue);
  const incoming = new Map<string, Array<{ source: string; instance: string; edge: string }>>();
  graph.edges.forEach((edge) => edge.witnesses.forEach((witness) => {
    if (witness.run !== run || !witness.highlighted) return;
    const parents = incoming.get(witness.targetInstance) ?? [];
    parents.push({ source: edge.source, instance: witness.sourceInstance, edge: edge.id });
    incoming.set(witness.targetInstance, parents);
  }));
  for (let index = 0; index < queue.length; index++) {
    for (const parent of incoming.get(queue[index]) ?? []) {
      nodes.add(parent.source);
      edges.add(parent.edge);
      if (!visited.has(parent.instance)) { visited.add(parent.instance); queue.push(parent.instance); }
    }
  }
  return { nodes, edges };
}

function nodeSearchText(node: JoinedProvenanceNode) {
  return [node.methods.join(' '), node.label, node.source?.label ?? '', node.semanticRole,
    node.assessment?.semanticLabel ?? '', node.assessment?.reason ?? '',
    node.eventSummary?.diagnostics.join(' ') ?? '', node.executionContext ? `rounds ${node.executionContext.roundStart + 1} ${node.executionContext.roundEnd + 1}` : '',
    node.variants.map((variant) => `${JSON.stringify(variant.roleBindings)} ${JSON.stringify(variant.parameters)} ${JSON.stringify(variant.diagnostics)}`).join(' '), claimText(node)].join(' ').toLocaleLowerCase();
}

export function matchFamilies(graph: JoinedProvenanceGraph, filters: GraphFilters): Set<string> {
  const terms = words(filters.text);
  const outcomes = new Set(workflowOverview(graph).results.map((result) => `${result.run}\0${result.eventId}`));
  // Seed result-path endpoints per occurrence, so long reviewed paths do not become hundreds of focus matches.
  const pathStates = new Set(graph.nodes.flatMap((node) => node.instances.filter((instance) => instance.resultBackbone).map((instance) => `${instance.run}\0${instance.id}`)));
  const continued = new Set(graph.edges.flatMap((edge) => edge.witnesses.filter((witness) => pathStates.has(`${witness.run}\0${witness.sourceInstance}`) && pathStates.has(`${witness.run}\0${witness.targetInstance}`)).map((witness) => `${witness.run}\0${witness.sourceInstance}`)));
  const resultEndpoints = new Set(graph.nodes.filter((node) => node.instances.some((instance) => instance.resultBackbone && !continued.has(`${instance.run}\0${instance.id}`))).map((node) => node.id));
  const searchText = new Map(graph.nodes.map((node) => [node.id, nodeSearchText(node)]));
  return new Set(graph.nodes.filter((node) =>
    (!terms.length || terms.every((term) => searchText.get(node.id)!.includes(term))) &&
    (filters.role === 'all' || (node.assessment?.level ?? node.attention) === filters.role) && node.supportCount >= filters.minSupport &&
    (filters.minOutcome <= 0 || [...node.importance.outcome.globalTools, ...(node.importance.outcome.patterns ?? [])].some((tool) => typeof tool.importance === 'number' && tool.importance >= filters.minOutcome)) &&
    (filters.evidence === 'all' || (filters.evidence === 'direct' ? hasDirectEvidence(node) : filters.evidence === 'supported' ? supportsConclusion(node, outcomes) : filters.evidence === 'main' ? supportsConclusion(node, outcomes) || resultEndpoints.has(node.id) : filters.evidence === 'path' ? hasPathEvidence(node) : isFailure(node)))
  ).map((node) => node.id));
}

export function edgeAllowed(edge: JoinedProvenanceEdge, links: GraphFilters['links']): boolean {
  if (links === 'all') return true;
  return edge.witnesses.some((witness) => links === 'inferred' ? witness.inferred : !witness.inferred);
}

export function focusSelection(
  graph: JoinedProvenanceGraph,
  matches: Set<string>,
  edgeMatches: Set<string>,
  filters: GraphFilters,
): { nodes: Set<string>; edges: Set<string>; boundaryEdges: Set<string> } {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const instancesByNode = new Map(graph.nodes.map((node) => [node.id, new Set(node.instances.map((instance) => `${instance.run}\0${instance.id}`))]));
  const validWitnesses = (edge: JoinedProvenanceEdge) => edge.witnesses.filter((witness) => {
    if (filters.links === 'recorded' && witness.inferred || filters.links === 'inferred' && !witness.inferred) return false;
    return instancesByNode.get(edge.source)?.has(`${witness.run}\0${witness.sourceInstance}`) &&
      instancesByNode.get(edge.target)?.has(`${witness.run}\0${witness.targetInstance}`);
  });
  const witnessByEdge = new Map<string, ReturnType<typeof validWitnesses>>();
  const edges = graph.edges.filter((edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return false;
    const witnesses = validWitnesses(edge);
    if (!witnesses.length) return false;
    if (new Set(witnesses.map((witness) => witness.run)).size < filters.minSupport) return false;
    witnessByEdge.set(edge.id, witnesses);
    return true;
  });
  const selectedNodes = new Set([...matches].filter((id) => nodeIds.has(id)));
  const selectedEdges = new Set(edges.filter((edge) => edgeMatches.has(edge.id)).map((edge) => edge.id));
  selectedEdges.forEach((id) => {
    const edge = edgeById.get(id)!;
    selectedNodes.add(edge.source);
    selectedNodes.add(edge.target);
  });
  if (!edgeMatches.size) edges.filter((edge) => matches.has(edge.source) && matches.has(edge.target)).forEach((edge) => selectedEdges.add(edge.id));
  const stateKey = (state: { run: string; instanceId: string }) => `${state.run}\0${state.instanceId}`;
  const seeds = [...matches].flatMap((nodeId) => nodeById.get(nodeId)?.instances.map((instance) => ({
    run: instance.run, instanceId: instance.id,
  })) ?? []);
  selectedEdges.forEach((id) => {
    witnessByEdge.get(id)!.forEach((witness) => {
      seeds.push({ run: witness.run, instanceId: witness.sourceInstance });
      seeds.push({ run: witness.run, instanceId: witness.targetInstance });
    });
  });
  const uniqueSeeds = [...new Map(seeds.map((state) => [stateKey(state), state])).values()];
  const visibleStates = new Set(uniqueSeeds.map(stateKey));
  if (filters.context !== 'none' && uniqueSeeds.length) {
    const incoming = new Map<string, Array<{ edge: JoinedProvenanceEdge; witness: JoinedProvenanceEdge['witnesses'][number] }>>();
    const outgoing = new Map<string, Array<{ edge: JoinedProvenanceEdge; witness: JoinedProvenanceEdge['witnesses'][number] }>>();
    edges.forEach((edge) => witnessByEdge.get(edge.id)!.forEach((witness) => {
      const sourceKey = stateKey({ run: witness.run, instanceId: witness.sourceInstance });
      const targetKey = stateKey({ run: witness.run, instanceId: witness.targetInstance });
      const outgoingEdges = outgoing.get(sourceKey) ?? [];
      outgoingEdges.push({ edge, witness });
      outgoing.set(sourceKey, outgoingEdges);
      const incomingEdges = incoming.get(targetKey) ?? [];
      incomingEdges.push({ edge, witness });
      incoming.set(targetKey, incomingEdges);
    }));
    const traverse = (direction: 'upstream' | 'downstream') => {
      const visited = new Set(uniqueSeeds.map(stateKey));
      const queue = [...uniqueSeeds];
      for (let cursor = 0; cursor < queue.length && (!['parents', 'neighbors'].includes(filters.context) || cursor < uniqueSeeds.length); cursor++) {
        const current = queue[cursor];
        const adjacent = (direction === 'upstream' ? incoming : outgoing).get(stateKey(current)) ?? [];
        adjacent.forEach(({ edge, witness }) => {
          selectedEdges.add(edge.id);
          const nodeId = direction === 'upstream' ? edge.source : edge.target;
          const instanceId = direction === 'upstream' ? witness.sourceInstance : witness.targetInstance;
          selectedNodes.add(nodeId);
          const next = { run: witness.run, instanceId };
          const key = stateKey(next);
          visibleStates.add(key);
          if (!visited.has(key)) { visited.add(key); queue.push(next); }
        });
      }
    };
    traverse('upstream');
    if (filters.context !== 'inputs' && filters.context !== 'parents') traverse('downstream');
  }
  const boundaryEdges = new Set(edges.filter((edge) => !selectedEdges.has(edge.id) && witnessByEdge.get(edge.id)!.some((witness) => visibleStates.has(stateKey({run: witness.run, instanceId: witness.targetInstance})))).map((edge) => edge.id));
  return { nodes: selectedNodes, boundaryEdges, edges: new Set(edges.filter((edge) => selectedEdges.has(edge.id) && selectedNodes.has(edge.source) && selectedNodes.has(edge.target)).map((edge) => edge.id)) };
}

type FocusNode = {
  id: string; label: string; tools: string[]; intent: string; subjects: string[];
  role: 'key' | 'supporting' | 'unknown'; result: string; failed: boolean; support: number;
};
type FocusEdge = { id: string; source: string; target: string; kind: 'recorded' | 'inferred' | 'mixed'; resultPath: boolean; support: number };

const safeText = (value: string, limit: number, privateIds: Set<string>) => {
  return value.replace(/https?:\/\/\S+|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gi, '')
    .replace(/[\r\n\t]+/g, ' ').replace(/[\w.:-]+/g, (token) => privateIds.has(token) ? '' : token)
    .replace(/\s+/g, ' ').trim().slice(0, limit);
};

function subjectTerms(node: JoinedProvenanceNode, privateIds: Set<string>): string[] {
  const values: string[] = [];
  const visit = (value: unknown, key = '') => {
    if (Array.isArray(value)) value.forEach((item) => visit(item, key));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
    else if (typeof value === 'string' && /subject|target|query|gene|participant|role/i.test(key)) values.push(value);
  };
  node.variants.forEach((variant) => { visit(variant.roleBindings); visit(variant.parameters); });
  return [...new Set(values.map((value) => safeText(value, 50, privateIds)).filter(Boolean))].slice(0, 4);
}

function focusNode(node: JoinedProvenanceNode, id: string, privateIds: Set<string>): FocusNode {
  const failed = isFailure(node);
  const result = node.importance.result.status;
  const context = node.executionContext;
  const label = context ? `${node.variants[0]?.roleBindings.participant ?? ''} · R${context.roundStart + 1}–${context.roundEnd + 1} · ${node.label}` : node.label;
  return {
    id, label: safeText(label, 100, privateIds), tools: [...new Set(node.methods.map((tool) => safeText(tool, 50, privateIds)).filter(Boolean))].slice(0, 8),
    intent: safeText([node.semanticRole, ...(node.eventSummary?.diagnostics ?? [])].join(' '), 100, privateIds), subjects: subjectTerms(node, privateIds),
    role: node.assessment?.level ?? node.attention, result, failed, support: node.supportCount,
  };
}

export function buildFocusCatalog(graph: JoinedProvenanceGraph, query = ''): {
  catalog: { nodes: FocusNode[]; edges: FocusEdge[] };
  nodeIds: Record<string, string>; edgeIds: Record<string, string>;
  coverage: { shownNodes: number; totalNodes: number; shownEdges: number; totalEdges: number };
} {
  const terms = words(query);
  // Query ranking changes coverage, never the identity used in Copilot history.
  const opaqueNodes = new Map(graph.nodes.map((node, index) => [node.id, `n${index}`]));
  const opaqueEdges = new Map(graph.edges.map((edge, index) => [edge.id, `e${index}`]));
  const searchText = new Map(graph.nodes.map((node) => [node.id, nodeSearchText(node)]));
  const ranked = [...graph.nodes].sort((a, b) => {
    const score = (node: JoinedProvenanceNode) => terms.filter((term) => searchText.get(node.id)!.includes(term)).length;
    return score(b) - score(a) || Number(b.attention === 'key') - Number(a.attention === 'key') ||
      Number(b.resultBackbone) - Number(a.resultBackbone) || b.supportCount - a.supportCount;
  });
  const knownNodeIds = new Set(graph.nodes.map((node) => node.id));
  const allEdges = graph.edges.filter((edge) => knownNodeIds.has(edge.source) && knownNodeIds.has(edge.target));
  const nodeIds: Record<string, string> = {};
  const edgeIds: Record<string, string> = {};
  const nodes: FocusNode[] = [];
  const edges: FocusEdge[] = [];
  const privateIds = new Set<string>();
  graph.nodes.forEach((node) => {
    node.supportTraces.forEach((id) => privateIds.add(id));
    node.variants.forEach((variant) => { privateIds.add(variant.run); privateIds.add(variant.instanceId); });
    node.instances.forEach((instance) => { privateIds.add(instance.id); privateIds.add(instance.run); });
  });
  graph.edges.forEach((edge) => {
    edge.supportTraces.forEach((id) => privateIds.add(id));
    edge.witnesses.forEach((witness) => { privateIds.add(witness.run); privateIds.add(witness.sourceInstance); privateIds.add(witness.targetInstance); });
  });
  const tryAddNode = (node: JoinedProvenanceNode) => {
    const opaque = opaqueNodes.get(node.id)!;
    const candidate = focusNode(node, opaque, privateIds);
    if (nodes.length >= 120 || JSON.stringify({ nodes: [...nodes, candidate], edges }).length > 24_000) return false;
    nodes.push(candidate); nodeIds[node.id] = opaque; return true;
  };
  ranked.forEach(tryAddNode);
  allEdges.sort((a, b) => b.supportCount - a.supportCount).forEach((edge) => {
    if (edges.length >= 240 || !nodeIds[edge.source] || !nodeIds[edge.target]) return;
    const witnessFlags = edge.witnesses.map((witness) => witness.inferred);
    const kind = witnessFlags.length && witnessFlags.every(Boolean) ? 'inferred' : witnessFlags.some(Boolean) ? 'mixed' : 'recorded';
    const candidate: FocusEdge = {
      id: opaqueEdges.get(edge.id)!, source: nodeIds[edge.source], target: nodeIds[edge.target], kind,
      resultPath: edge.witnesses.some((witness) => witness.highlighted), support: edge.supportCount,
    };
    if (JSON.stringify({ nodes, edges: [...edges, candidate] }).length > 24_000) return;
    edges.push(candidate); edgeIds[edge.id] = candidate.id;
  });
  return { catalog: { nodes, edges }, nodeIds, edgeIds,
    coverage: { shownNodes: nodes.length, totalNodes: graph.nodes.length, shownEdges: edges.length, totalEdges: graph.edges.length } };
}
