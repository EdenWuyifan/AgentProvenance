import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { actionBelongsToGraph, graphScope } from '../agent_provenance_react/app/components/graph_controls.ts';
import { buildFocusCatalog, DEFAULT_GRAPH_FILTERS } from '../agent_provenance_react/app/components/graph_search.ts';
import { createGraphWorkspace, layoutWorkflowLanes, routeOrthogonal } from '../agent_provenance_react/app/components/graph_layout.ts';
const require = createRequire(new URL('../agent_provenance_react/package.json', import.meta.url));
const ts = require('typescript');
const graph = JSON.parse(readFileSync(new URL('./results/context-iteration-3/discovera-two.graph.json', import.meta.url), 'utf8'));
const scope = graphScope(graph, 'source-a');
const packed = buildFocusCatalog(graph, 'higher scores');
const id = graph.nodes[0].id;
assert(actionBelongsToGraph({ type: 'highlight_graph', scope, nodeIds: [id], edgeIds: [] }, graph, scope));
assert(!actionBelongsToGraph({ type: 'highlight_graph', scope: graphScope(graph, 'source-b'), nodeIds: [id], edgeIds: [] }, graph, scope));
assert(!actionBelongsToGraph({ type: 'set_graph_view', scope, expandNodeIds: ['missing-node'] }, graph, scope));
const changed = structuredClone(graph); changed.nodes[0].instances[0].id += '-new';
assert.notEqual(graphScope(changed, 'source-a'), scope);
const source = readFileSync(new URL('../agent_provenance_react/app/components/provenance_copilot_agent.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\s*/gm, '').replace('export class', 'class');
const Agent = new Function('buildFocusCatalog', `${compiled}; return ProvenanceCopilotAgent;`)(buildFocusCatalog);
const originalFetch = globalThis.fetch;
const actions = [{ type: 'highlight_graph', scope, nodeIds: [id], edgeIds: [] }, { type: 'set_graph_view', scope, axis: 'outcome', frame: true }];
let captured;
globalThis.fetch = async (url, options) => {
  captured = { url, options, body: JSON.parse(options.body) };
  const data = new TextEncoder().encode(actions.map((action) => JSON.stringify({ type: 'graph_action', action })).join('\n') + '\n' + JSON.stringify({ type: 'telemetry', modelRequests: 2, toolCalls: 2, elapsedSeconds: 1.2 }) + '\n');
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(data.slice(0, 37)); controller.enqueue(data.slice(37)); controller.close();
  }}));
};
try {
  const events = [], abort = new AbortController();
  const input = { question: 'higher scores', chatHistory: [], selectedTraces: [], selectedTraceDags: {}, joinedGraph: graph, graphMode: 'provenance',
    graphState: { scope, filters: DEFAULT_GRAPH_FILTERS, axis: 'outcome', expandedNodeIds: [id], nodeIds: [id], edgeIds: [] } };
  await new Agent().run(input, (event) => events.push(event), abort.signal);
  assert.deepEqual(events.slice(0, 2).map((event) => event.action), actions);
  assert.equal(events[2].type, 'telemetry');
  assert.equal(captured.options.signal, abort.signal);
  assert.deepEqual(captured.body.graphIds.nodes, packed.nodeIds);
  assert.deepEqual(captured.body.graphState.highlightedNodeIds, [id]);
  await assert.rejects(new Agent().run(input, () => { throw new Error('callback failed'); }, abort.signal), /callback failed/);
} finally { globalThis.fetch = originalFetch; }
console.log('Graph scope isolation and split-stream graph actions passed');

// Project workflow display changes from a saved Discovera graph; this path uses no backend or model.
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const importance = await import('../agent_provenance_react/app/components/graph_importance.ts');
const componentSource = readFileSync(new URL('../agent_provenance_react/app/components/semantic_graph.tsx', import.meta.url), 'utf8');
const compile = (text) => ts.transpileModule(text, { compilerOptions: {
  module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
} }).outputText.replace(/^import[\s\S]*?from ['"][^'\"]+['"];?\s*/gm, '');
const { build, FamilyNode } = new Function('MarkerType', 'importanceBackground', 'importanceMaximum', 'importanceValue', 'React', 'useState', 'Handle', 'Position',
  `${compile(componentSource.slice(0, componentSource.indexOf('function OperationNodeView(')))}; return { build: semanticGraph, FamilyNode };`)(
  { ArrowClosed: 'arrowclosed' }, importance.importanceBackground, importance.importanceMaximum, importance.importanceValue,
  React, React.useState, () => null, { Left: 'left', Right: 'right' });
const route = new Function('routeOrthogonal', `${compile(componentSource.slice(componentSource.indexOf('function routedEdges('), componentSource.indexOf('function traceIdentity(')))}; return routedEdges;`)(routeOrthogonal);
const savedDiscovera = JSON.parse(readFileSync(new URL('./results/context-iteration-3/discovera-single.graph.json', import.meta.url), 'utf8'));
const workflowGraph = structuredClone(savedDiscovera);
workflowGraph.workflow = { lanes: [{ id: 'actor', label: 'Actor', kind: 'agent', participantIds: [] }], roundRange: [0, 2], roundLabel: 'Round' };
workflowGraph.nodes.forEach((node) => {
  node.executionContext = { laneId: 'actor', roundStart: 0, roundEnd: 0 };
  node.assessment = { status: 'unknown', level: 'unknown', semanticLabel: node.label, reason: '', evidence: [], jointGroupIds: [] };
  node.eventSummary = { eventCount: 1, diagnostics: [], outcomes: [] };
  node.importance.result.status = 'none';
  node.instances.forEach((instance) => { instance.resultTargets = []; });
});
const outcomeFamily = workflowGraph.nodes[0];
const outcomeInstance = outcomeFamily.instances[0];
const outcomeCall = outcomeInstance.calls[0];
workflowGraph.structuredOutcomes = [{ run: outcomeInstance.run, outcomes: [{ eventId: outcomeCall.id, name: 'Final yield', metric: 'yield', value: 0.8,
  round: 0, scope: 'system', kind: 'final', terminal: true }] }];
const failureFamily = workflowGraph.nodes[1];
failureFamily.operationGroups[0].failure = true;
const repeatedFamily = workflowGraph.nodes[2];
repeatedFamily.eventSummary.eventCount = 2;
workflowGraph.nodes.forEach((node, index) => {
  node.executionContext = { laneId: index % 2 ? 'actor-b' : 'actor', roundStart: index * 20, roundEnd: index * 20 };
});
workflowGraph.workflow.lanes.push({ id: 'actor-b', label: 'Actor B', kind: 'agent', participantIds: [] });
workflowGraph.workflow.roundRange = [0, (workflowGraph.nodes.length - 1) * 20];
const routeSource = workflowGraph.nodes[0];
const routeTarget = workflowGraph.nodes.at(-1);
const routeSourceInstance = routeSource.instances[0];
const routeTargetInstance = routeTarget.instances[0];
workflowGraph.edges.push({ id: 'workflow-cross-lane', source: routeSource.id, target: routeTarget.id, supportCount: 1,
  supportTraces: [routeSourceInstance.run], inferred: false, witnesses: [{ run: routeSourceInstance.run,
    sourceInstance: routeSourceInstance.id, targetInstance: routeTargetInstance.id,
    callPath: [routeSourceInstance.calls[0].id, routeTargetInstance.calls[0].id], inferred: false, highlighted: true }] });
const workflowBuilt = build(workflowGraph, new Set(), {}, [], undefined, () => {}, 'semantic');
const workflowWorkspace = createGraphWorkspace('workflow-routing');
const workflowBoxes = workflowBuilt.nodes.filter((node) => !node.parentId).map((node) => ({ id: node.id,
  x: node.position.x, y: node.position.y, width: node.style.width, height: node.style.height }));
const workflowPositions = layoutWorkflowLanes(workflowBoxes, workflowGraph.workflow, workflowBuilt.contexts, workflowWorkspace);
workflowBuilt.nodes.forEach((node) => { node.position = workflowPositions.get(node.id); });
const nodeFor = (family) => workflowBuilt.nodes.find((node) => node.id === family.id);
const unknownNode = nodeFor(workflowGraph.nodes[3]);
assert.deepEqual([unknownNode.style.width, unknownNode.style.height], [28, 28]);
assert(renderToStaticMarkup(React.createElement(FamilyNode, { data: unknownNode.data })).includes('h-3.5 w-3.5'));
assert.deepEqual([nodeFor(outcomeFamily).style.width, nodeFor(outcomeFamily).style.height], [256, 136]);
assert.equal(nodeFor(outcomeFamily).data.directResult, true);
assert.equal(nodeFor(outcomeFamily).data.recordedOutcome, true);
const outcomeMarkup = renderToStaticMarkup(React.createElement(FamilyNode, { data: nodeFor(outcomeFamily).data }));
assert(outcomeMarkup.includes('Recorded outcome') && outcomeMarkup.includes('background:#eff6ff'));
assert.deepEqual([nodeFor(failureFamily).style.width, nodeFor(failureFamily).style.height], [256, 136]);
assert.equal(nodeFor(failureFamily).data.failure, true);
assert.equal(nodeFor(repeatedFamily).data.expandable, true);
assert(renderToStaticMarkup(React.createElement(FamilyNode, { data: nodeFor(repeatedFamily).data })).includes('>2</span>'));
assert(!renderToStaticMarkup(React.createElement(FamilyNode, { data: { ...nodeFor(repeatedFamily).data, expanded: true } })).includes('h-3.5 w-3.5'));
const routed = route(workflowBuilt.nodes, workflowBuilt.edges);
assert(routed.filter((edge) => !edge.data.critical).every((edge) => edge.data.route.length === 2 && edge.markerEnd.width === 5));
const crossLaneRoute = routed.find((edge) => edge.data.semanticEdge?.id === 'workflow-cross-lane');
assert(crossLaneRoute.data.critical);
const graphRight = Math.max(...workflowBuilt.nodes.map((node) => node.position.x + node.style.width));
assert(Math.max(...crossLaneRoute.data.route.map((point) => point.x)) < graphRight + 32, 'Critical cross-lane route should avoid the far edge of full history');
const routeBoxes = workflowBuilt.nodes.filter((node) => !node.parentId).map((node) => ({ id: node.id, x: node.position.x,
  y: node.position.y, width: node.style.width, height: node.style.height }));
for (let index = 1; index < crossLaneRoute.data.route.length; index++) {
  const a = crossLaneRoute.data.route[index - 1], b = crossLaneRoute.data.route[index];
  for (const box of routeBoxes.filter((item) => item.id !== routeSource.id && item.id !== routeTarget.id)) {
    const crosses = a.y === b.y ? a.y > box.y && a.y < box.y + box.height && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.width
      : a.x > box.x && a.x < box.x + box.width && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.height;
    assert.equal(crosses, false, `Cross-lane result route crosses ${box.id}`);
  }
}
assert(!componentSource.includes("graph.detail === 'overview' || initialRounds"), 'Initial framing must not fit the entire workflow history');
assert(componentSource.includes('Locate result') && componentSource.includes('Unknown means unreviewed or evidence-insufficient'));
console.log('Workflow display projection passed on a saved Discovera graph');
