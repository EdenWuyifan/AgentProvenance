import type { JoinedProvenanceGraph } from './types';

export type DisplayMotif = {
  id: string;
  kind: 'fan' | 'connector';
  toolNames: string[];
  memberIds: string[];
  inputIds: string[];
  outputIds: string[];
};

/** Directed, typed-neighborhood variants; grouping does not assert semantic equivalence.
 * Adapted from Dunne and Shneiderman's fan/connector motif simplification (CHI 2013).
 * This display-only detector neither rewrites graph nodes nor invents dependency edges.
 */
export function displayMotifs(graph: JoinedProvenanceGraph, protectedIds = new Set<string>()): DisplayMotif[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, string[]>(), outgoing = new Map<string, string[]>();
  const inputs = new Map<string, Set<string>>(), outputs = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue;
    const recorded = edge.witnesses.some((witness) => !witness.inferred);
    const inferred = edge.witnesses.some((witness) => witness.inferred);
    const kind = recorded && inferred ? 'mixed' : recorded ? 'recorded' : 'inferred';
    const parents = incoming.get(edge.target) ?? [], children = outgoing.get(edge.source) ?? [];
    parents.push(JSON.stringify([edge.source, edge.relation ?? '', kind]));
    children.push(JSON.stringify([edge.target, edge.relation ?? '', kind]));
    incoming.set(edge.target, parents); outgoing.set(edge.source, children);
    const inIds = inputs.get(edge.target) ?? new Set<string>(), outIds = outputs.get(edge.source) ?? new Set<string>();
    inIds.add(edge.source); outIds.add(edge.target);
    inputs.set(edge.target, inIds); outputs.set(edge.source, outIds);
  }
  const groups = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (protectedIds.has(node.id) || node.source || node.supportTraces.length > 1
      || node.resultBackbone || node.importance.result.onRecordedPath
      || node.operationGroups.some((operation) => operation.failure)
      || node.instances.some((instance) => instance.resultBackbone || instance.resultTargets.length)
      || ['supported', 'contradicted', 'referenced'].includes(node.importance.result.status)) continue;
    const parents = incoming.get(node.id) ?? [], children = outgoing.get(node.id) ?? [];
    if (!parents.length && !children.length) continue;
    const context = node.executionContext;
    const signature = JSON.stringify([[...node.methods].sort(), node.semanticRole,
      node.assessment?.level ?? node.importance.semantic.level,
      context ? [context.laneId, context.roundStart, context.roundEnd] : null,
      parents.sort(), children.sort()]);
    const members = groups.get(signature) ?? [];
    members.push(node.id); groups.set(signature, members);
  }
  return [...groups.values()].filter((members) => members.length > 1).map((memberIds) => {
    memberIds.sort();
    const first = nodes.get(memberIds[0])!;
    const inputIds = [...inputs.get(first.id) ?? []].sort(), outputIds = [...outputs.get(first.id) ?? []].sort();
    return { id: `motif:${memberIds.join('|')}`, kind: inputIds.length + outputIds.length === 1 ? 'fan' : 'connector',
      toolNames: [...first.methods].sort(), memberIds, inputIds, outputIds };
  });
}
