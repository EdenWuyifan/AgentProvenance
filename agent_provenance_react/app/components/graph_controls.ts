import type { ImportanceAxis } from './graph_importance';
import type { GraphFilters } from './graph_search';
import type { JoinedProvenanceGraph } from './types';

export type GraphHighlight = { scope: string; nodeIds: string[]; edgeIds: string[] };
export type GraphViewState = GraphHighlight & {
  filters: GraphFilters;
  axis: ImportanceAxis;
  expandedNodeIds: string[];
  inspectedNodeIds?: string[];
  inspectedEdgeIds?: string[];
};
export type GraphAction =
  | (GraphHighlight & { type: 'highlight_graph' | 'filter_graph'; context?: GraphFilters['context'] })
  | { type: 'set_graph_view'; scope: string; axis?: ImportanceAxis; context?: GraphFilters['context'];
      links?: GraphFilters['links']; filters?: Partial<GraphFilters>; expandNodeIds?: string[];
      collapseNodeIds?: string[]; frame?: boolean; reset?: boolean };
export type GraphCommand = { nonce: number; action: GraphAction };

export function graphScope(graph: JoinedProvenanceGraph, sourceKey: string) {
  const signature = JSON.stringify([sourceKey, graph.templateVersion,
    graph.nodes.map((node) => [node.id, node.instances.map((instance) => [instance.run, instance.id]), node.importance]),
    graph.edges.map((edge) => [edge.id, edge.witnesses.map((witness) => [witness.run, witness.sourceInstance, witness.targetInstance])])]);
  let first = 2166136261, second = 5381;
  for (let index = 0; index < signature.length; index++) {
    const character = signature.charCodeAt(index);
    first = Math.imul(first ^ character, 16777619); second = Math.imul(second, 33) ^ character;
  }
  return `${first >>> 0}:${second >>> 0}:${signature.length}`;
}

export function actionBelongsToGraph(action: GraphAction, graph: JoinedProvenanceGraph, scope: string) {
  if (action.scope !== scope) return false;
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  return action.type === 'set_graph_view'
    ? [...action.expandNodeIds ?? [], ...action.collapseNodeIds ?? []].every((id) => nodeIds.has(id))
    : action.nodeIds.every((id) => nodeIds.has(id)) && action.edgeIds.every((id) => edgeIds.has(id));
}
