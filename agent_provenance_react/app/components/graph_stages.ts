import type { JoinedProvenanceGraph, JoinedProvenanceNode, ToolCall, Tracing } from './types';

export type WorkflowStageGroup = {
  id: string;
  kind: 'stage';
  toolNames: string[];
  memberIds: string[];
  inputIds: string[];
  outputIds: string[];
};

export function humanToolTitle(tool:string,tools:string[]) {
  const method=tool.split('__').at(-1)!;
  const peers=new Set(tools.filter(candidate=>candidate.split('__').at(-1)===method));
  return peers.size>1?tool.replaceAll('__','.'):method;
}

export function stageParameterCount(families:JoinedProvenanceNode[]) {
  const ordered=(value:unknown):unknown=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,ordered(item)])):value;
  return new Set(families.flatMap(family=>family.operationGroups.flatMap(operation=>operation.parameterVariants.map(variant=>JSON.stringify([operation.tool,ordered(variant.parameters)]))))).size;
}

export function explicitOutcome(trace: Tracing): 'success' | 'failure' | 'unknown' {
  const outcome = trace.trainingOutcome;
  if (!outcome || typeof outcome !== 'object' || !('status' in outcome)) return 'unknown';
  return outcome.status === 'success' || outcome.status === 'failure' ? outcome.status : 'unknown';
}

export function toolErrored(call: ToolCall): boolean {
  const failed = (value: unknown) => typeof value === 'string' && ['error', 'failed', 'failure', 'fail'].includes(value.toLowerCase());
  if (failed(call.status)) return true;
  if (!call.response || typeof call.response !== 'object') return false;
  const response = call.response as Record<string, unknown>;
  const error = response.error;
  const message = typeof error === 'string' ? error.trim()
    : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message.trim() : '';
  return Boolean(message) || failed(response.status);
}

export function stageSummary(families: JoinedProvenanceNode[], traces: Tracing[]) {
  const calls = new Set<string>(), covered = new Set<string>(), runs = new Set<string>(), errors = new Set<string>();
  for (const family of families) {
    for (const instance of family.instances) {
      runs.add(instance.run);
      instance.calls.forEach(call => calls.add(`${instance.run}\0${call.id}`));
      instance.calls.forEach(call => covered.add(`${instance.run}\0${call.id}`));
      instance.internalCalls.forEach(id => covered.add(`${instance.run}\0${id}`));
    }
    family.operationGroups.filter(operation => operation.failure).forEach(operation =>
      operation.members.forEach(member => { const id = `${member.run}\0${member.callId}`; if (calls.has(id)) errors.add(id); }));
  }
  const known = traces.filter(trace => runs.has(String(trace.id)));
  known.forEach(trace => trace.toolCalls.forEach(call => {
    const key = `${trace.id}\0${call.id}`;
    if (calls.has(key) && toolErrored(call)) errors.add(key);
  }));
  return { calls: calls.size, covered: covered.size, runs: runs.size, errors: errors.size,
    success: known.filter(trace => explicitOutcome(trace) === 'success').length,
    failure: known.filter(trace => explicitOutcome(trace) === 'failure').length };
}

/** A tool-stage overview, not an equivalence relation on parameterized operations.
 * Same tool, reviewed role and intent share one expandable container. Source data,
 * variants and every edge witness remain in the canonical graph.
 */
export function workflowStageGroups(graph: JoinedProvenanceGraph): WorkflowStageGroup[] {
  if(graph.workflow)return [];
  const intents=new Map<string,Set<string>>();
  for(const node of graph.nodes){
    if(node.source||node.semanticRole==='background'||node.operationGroups.every(operation=>operation.failure)&&node.operationGroups.length)continue;
    const method=JSON.stringify([...node.methods].sort()),values=intents.get(method)??new Set<string>();
    values.add(JSON.stringify([node.semanticRole,node.label]));intents.set(method,values);
  }
  const buckets = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.source) continue;
    const method=JSON.stringify([...node.methods].sort());
    // Parameter values, importance labels and outcomes are variants, not operation identity.
    // Multiple reviewed intents (e.g. different selection predicates) keep separate stages.
    const key=JSON.stringify([method,(intents.get(method)?.size??0)>1?[node.semanticRole,node.label]:null]);
    const members = buckets.get(key) ?? [];
    members.push(node.id); buckets.set(key, members);
  }
  return [...buckets.values()].filter(members => members.length > 1).map(memberIds => {
    memberIds.sort();
    const members = new Set(memberIds);
    return { id: `stage:${memberIds.join('|')}`, kind: 'stage', memberIds,
      toolNames: [...new Set(graph.nodes.filter(node => members.has(node.id)).flatMap(node => node.methods))],
      inputIds: [...new Set(graph.edges.filter(edge => members.has(edge.target) && !members.has(edge.source)).map(edge => edge.source))],
      outputIds: [...new Set(graph.edges.filter(edge => members.has(edge.source) && !members.has(edge.target)).map(edge => edge.target))] };
  });
}
