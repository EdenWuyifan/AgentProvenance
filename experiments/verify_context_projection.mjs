import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createGraphWorkspace, layoutGroups, layoutWorkflowLanes, workflowLayoutLinks, overlaps, routeOrthogonal } from '../agent_provenance_react/app/components/graph_layout.ts';
import { importanceBackground, importanceMaximum, importanceValue } from '../agent_provenance_react/app/components/graph_importance.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../agent_provenance_react/package.json', import.meta.url));
const ts = require('typescript');
const React = require('react');
const source = readFileSync(new URL('../agent_provenance_react/app/components/semantic_graph.tsx', import.meta.url), 'utf8');
const compile = (text) => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText.replace(/^import[\s\S]*?from ['"][^'"]+['"];?\s*/gm, '');
const { build } = new Function('MarkerType', 'importanceBackground', 'importanceMaximum', 'importanceValue', 'React', 'useState', 'Handle', 'Position',
  `${compile(source.slice(0, source.indexOf('function OperationNodeView(')))}; return { build: semanticGraph };`)(
  { ArrowClosed: 'arrowclosed' }, importanceBackground, importanceMaximum, importanceValue, React, React.useState, () => null, { Left: 'left', Right: 'right' });
const route = new Function('routeOrthogonal',
  `${compile(source.slice(source.indexOf('function routedEdges('), source.indexOf('function traceIdentity(')))}; return routedEdges;`)(routeOrthogonal);
const { workspaceNodes } = new Function('Position',
  `${compile(source.slice(source.indexOf('function workspaceNodes('), source.indexOf('function LocateStep(')))}; return { workspaceNodes };`)({ Left: 'left', Right: 'right' });
const { adoptUserNodes, getNodesInside } = require('@xyflow/system');

function graphFiles(dirs) {
  return dirs.flatMap((dir) => readdirSync(`${root}${dir}`).filter((name) => name.endsWith('.graph.json')).map((name) => `${dir}/${name}`));
}

function derivedViews(graph) {
  const runs = [...new Set(graph.nodes.flatMap((family) => family.supportTraces ?? []))];
  const callMap = new Map();
  for (const family of graph.nodes) for (const operation of family.operationGroups ?? []) for (const member of operation.members ?? []) {
    const calls = callMap.get(member.run) ?? new Map();
    calls.set(member.step, { id: member.callId, name: operation.tool });
    callMap.set(member.run, calls);
  }
  const traces = runs.map((id) => {
    const calls = callMap.get(id) ?? new Map();
    const toolCalls = Array.from({ length: Math.max(0, ...calls.keys()) }, (_, i) => calls.get(i + 1) ?? { name: 'unrepresented' });
    return { id, toolCalls };
  });
  const dags = Object.fromEntries(runs.map((run) => {
    const nodes = [], edges = [], seenActivities = new Set(), seenEntities = new Set();
    for (const family of graph.nodes) for (const operation of family.operationGroups ?? []) for (const member of operation.members ?? []) {
      if (member.run !== run) continue;
      const activityId = `activity:${run}:${member.callId}`;
      if (!seenActivities.has(activityId)) {
        seenActivities.add(activityId);
        nodes.push({ id: activityId, kind: 'Activity', toolCallId: member.callId, tool: operation.tool });
      }
      for (const entityId of member.inputEntityIds ?? []) {
        if (!seenEntities.has(entityId)) { seenEntities.add(entityId); nodes.push({ id: entityId, kind: 'Entity' }); }
        edges.push({ source: entityId, target: activityId, relation: 'usedBy' });
      }
      for (const entityId of member.outputEntityIds ?? []) {
        if (!seenEntities.has(entityId)) { seenEntities.add(entityId); nodes.push({ id: entityId, kind: 'Entity' }); }
        edges.push({ source: activityId, target: entityId, relation: 'generatedBy' });
      }
    }
    return [run, { nodes, edges }];
  }));
  return { traces, dags };
}

function rootBox(node) { return { id: node.id, x: node.position.x, y: node.position.y, width: Number(node.style.width), height: Number(node.style.height) }; }
function cardInteriorCrossings(nodes, routed) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const occupied = nodes.filter((node) => !node.parentId).map((node) => {
    const box = rootBox(node);
    return node.data.expanded ? [{ ...box, height: 64 }, { ...box, y: box.y + box.height - 48, height: 48 }] : [box];
  }).flat();
  let crossings = 0;
  for (const edge of routed.filter((candidate) => candidate.data.critical)) for (let i = 1; i < (edge.data.route?.length ?? 0); i++) {
    const a = edge.data.route[i - 1], b = edge.data.route[i];
    if (a.x !== b.x && a.y !== b.y) continue;
    for (const box of occupied) {
      const crosses = a.y === b.y ? a.y > box.y && a.y < box.y + box.height && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.width
        : a.x > box.x && a.x < box.x + box.width && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.height;
      if (crosses) crossings++;
    }
  }
  return crossings;
}

const defaultDirs = ['experiments/results/context-iteration-1', 'experiments/results/context-iteration-1-suzuki', 'experiments/results/context-iteration-1-more'];
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : defaultDirs;
const files = graphFiles(dirs);
assert(files.length, `No saved graphs found in ${dirs.join(', ')}`);
const report = { source: 'Saved graph JSON; actual semantic builder, workflow lane layout and current edge router; local-only, zero model/network/server calls.', cases: [] };

for (const file of files) {
  const graph = JSON.parse(readFileSync(`${root}${file}`, 'utf8'));
  const { traces, dags } = derivedViews(graph);
  const workflow = graph.workflow;
  const buildStart = performance.now();
  const built = build(graph, new Set(), dags, traces, undefined, () => {}, 'semantic');
  const buildMs = performance.now() - buildStart;
  const roots = built.nodes.filter((node) => !node.parentId);
  const layoutStart = performance.now();
  const workspace = createGraphWorkspace(file);
  const positions = workflow
    ? layoutWorkflowLanes(roots.map(rootBox), workflow, new Map(graph.nodes.map((node) => [node.id, node.executionContext])), workspace, true)
    : await layoutGroups(roots.map(rootBox), workflowLayoutLinks(graph), workspace, true);
  roots.forEach((node) => { node.position = positions.get(node.id); workspace.positions.set(node.id, node.position); });
  const layoutMs = performance.now() - layoutStart;
  const rootBoxes = roots.map(rootBox);
  let overlapsCount = 0;
  for (let i = 0; i < rootBoxes.length; i++) for (let j = i + 1; j < rootBoxes.length; j++) if (overlaps(rootBoxes[i], rootBoxes[j])) overlapsCount++;
  const routeStart = performance.now();
  const routed = route(built.nodes, built.edges);
  const routeMs = performance.now() - routeStart;
  let virtualization = null;
  if (workflow) {
    const projected = workspaceNodes(built.nodes, workspace);
    const nodeLookup = new Map(), parentLookup = new Map();
    const adopted = adoptUserNodes(projected, nodeLookup, parentLookup);
    const visible = getNodesInside(nodeLookup, { x: 0, y: 0, width: 1200, height: 800 }, [0, 0, 1], false);
    const visibleIds = new Set(visible.map((node) => node.id));
    const unmounted = [...nodeLookup.values()].filter((node) => !visibleIds.has(node.id));
    const geometryMissing = unmounted.filter((node) => !node.measured?.width || !node.measured?.height
      || !node.internals.handleBounds?.source?.length || !node.internals.handleBounds?.target?.length).map((node) => node.id);
    virtualization = { viewport: { width: 1200, height: 800 }, projectedNodes: projected.length,
      visibleNodes: visible.length, unmountedNodes: unmounted.length, strictSubset: visible.length > 0 && visible.length < projected.length,
      nodesInitialized: adopted.nodesInitialized, geometryMissingUnmounted: geometryMissing };
  }
  const sourceNodeIds = new Set(graph.nodes.map((node) => node.id));
  const renderedRootIds = new Set(roots.map((node) => node.id));
  const missingNodes = [...sourceNodeIds].filter((id) => !renderedRootIds.has(id));
  const representedEdges = new Set(routed.flatMap((edge) => edge.data.semanticEdge ? [edge.data.semanticEdge.id] : []));
  const missingEdges = graph.edges.map((edge) => edge.id).filter((id) => !representedEdges.has(id));
  const ordinaryLinkMinOpacity = workflow ? null : Math.min(...built.edges.map((edge) => Number(edge.style.opacity ?? 1)));
  const expandable = graph.nodes.filter((family) => family.operationGroups.length > 1 || workflow && family.instances.reduce((sum, instance) => sum + instance.calls.length, 0) > 1);
  let expansion = null;
  if (expandable.length) {
    const family = workflow ? expandable.find((candidate) => candidate.assessment?.level === 'unknown') ?? expandable[0] : expandable[0];
    const expanded = build(graph, new Set([family.id]), dags, traces, undefined, () => {}, 'semantic');
    const children = expanded.nodes.filter((node) => node.parentId === family.id);
    if (workflow) assert(children.every((node) => node.data.semanticLevel === family.assessment.level), `${file}: expansion changed semantic judgment`);
    expansion = { family: family.id, childNodes: children.length,
      childAssessmentLevels: [...new Set(children.map((node) => node.data.semanticLevel))],
      rootShowsCard: expanded.nodes.find((node) => node.id === family.id)?.data.expanded === true };
  }
  const dots = roots.filter((node) => node.data.workflowMode && Number(node.style.width) === 28).length;
  const blueCards = roots.filter((node) => node.data.workflowMode && (node.data.recordedOutcome || node.data.semanticLevel === 'key')
    && Number(node.style.width) > 28).length;
  const contextEdges = workflow ? routed.filter((edge) => !edge.data.critical).length : 0;
  const keyEdges = routed.filter((edge) => edge.data.critical).length;
  const routeCrossings = cardInteriorCrossings(built.nodes, routed);
  let reviewedFlowChain = null;
  if (file.includes('context-iteration-3-suzuki-retry/suzuki-65')) {
    const run = 'suzuki_edbo:het:65';
    const events = [
      'suzuki_edbo:het:65:r64:a0:experiment',
      'suzuki_edbo:het:65:r64:a0:publication',
      'suzuki_edbo:het:65:r64:a3:reception-from-0',
      'suzuki_edbo:het:65:r65:a3:experiment',
    ];
    const eventFamily = (eventId) => graph.nodes.find((family) => family.instances.some((instance) => instance.run === run && instance.calls.some((call) => call.id === eventId)));
    const edges = events.slice(0, -1).map((eventId, index) => graph.edges.find((edge) => edge.witnesses.some((witness) => witness.run === run
      && witness.highlighted && witness.callPath.length === 2 && witness.callPath[0] === eventId && witness.callPath[1] === events[index + 1])));
    const uiNodes = events.map((eventId) => {
      const family = eventFamily(eventId);
      const node = family && built.nodes.find((candidate) => candidate.id === family.id);
      return { eventId, familyId: family?.id, assessmentLevel: family?.assessment?.level ?? null,
        renderedLevel: node?.data.semanticLevel ?? null, inspected: node?.data.inspectable?.family?.id === family?.id,
        readableCard: Boolean(node && Number(node.style.width) > 28), width: node?.style.width ?? null };
    });
    const uiEdges = edges.map((edge) => {
      const rendered = edge && routed.find((candidate) => candidate.data.semanticEdge?.id === edge.id
        && candidate.data.semanticEdge.witnesses.some((witness) => witness.run === run && witness.highlighted));
      return { edgeId: edge?.id ?? null, highlighted: Boolean(edge?.witnesses.some((witness) => witness.run === run && witness.highlighted)),
        routed: Boolean(rendered), critical: Boolean(rendered?.data.critical) };
    });
    reviewedFlowChain = { events: uiNodes, links: uiEdges,
      exists: edges.every(Boolean), highlightedAndRouted: uiEdges.every((edge) => edge.highlighted && edge.routed && edge.critical),
      endpointsInspected: uiNodes.every((node) => node.inspected), endpointsReadable: uiNodes.every((node) => node.readableCard),
      assessmentLevelsPreserved: uiNodes.every((node) => node.assessmentLevel === node.renderedLevel) };
  }
  const sourceOperationGroups = graph.nodes.reduce((sum, family) => sum + family.operationGroups.length, 0);
  const renderedOperationGroups = roots.reduce((sum, node) => sum + (node.data.inspectable.family.operationGroups?.length ?? 0), 0);
  report.cases.push({ file, workflow: Boolean(workflow), sourceGroups: graph.nodes.length, sourceOperationGroups, renderedOperationGroups, sourceEdges: graph.edges.length,
    representedActivities: graph.compression?.sourceCalls ?? null, renderedRoots: roots.length, renderedNodes: built.nodes.length,
    compactDots: dots, readableBlueCards: blueCards, expandableGroups: expandable.length, expansion,
    builtEdges: built.edges.length, routedEdges: routed.length, keyOrRelevantRoutes: keyEdges, contextRoutes: contextEdges,
    ordinaryLinkMinOpacity,
    virtualization,
    missingNodes, missingEdges, rootOverlaps: overlapsCount, keyRouteCardInteriorCrossings: routeCrossings,
    reviewedFlowChain,
    buildMs: +buildMs.toFixed(1), layoutMs: +layoutMs.toFixed(1), routeMs: +routeMs.toFixed(1), modelNetworkServerCalls: 0 });
  assert.deepEqual(missingNodes, [], `${file}: source group missing from rendered roots`);
  assert.equal(renderedOperationGroups, sourceOperationGroups, `${file}: source operation group missing from rendered family inspection`);
  assert.deepEqual(missingEdges, [], `${file}: source edge missing from routed semantic edges`);
  assert.equal(overlapsCount, 0, `${file}: root overlap`);
  assert.equal(routeCrossings, 0, `${file}: route crosses card interior`);
  assert.equal(routed.length, built.edges.length);
  if (!workflow) assert(ordinaryLinkMinOpacity >= 0.6, `${file}: ordinary link opacity fell below 0.6`);
  if (workflow) {
    assert(virtualization.strictSubset, `${file}: initial viewport did not virtualize workflow nodes`);
    assert(virtualization.nodesInitialized, `${file}: XYFlow reports uninitialized workflow nodes`);
    assert.deepEqual(virtualization.geometryMissingUnmounted, [], `${file}: unmounted node lacks measured/handle geometry`);
  }
  if (expandable.length) assert(expansion.childNodes > 0 && expansion.rootShowsCard, `${file}: expansion has no inspectable child cards`);
}

const output = process.env.CONTEXT_PROJECTION_REPORT ?? `${root}experiments/results/context-projection-verified.json`;
writeFileSync(output, JSON.stringify(report, null, 2));
for (const item of report.cases) console.log(JSON.stringify({ file: item.file, groups: item.renderedRoots, dots: item.compactDots,
  blueCards: item.readableBlueCards, edges: `${item.routedEdges}/${item.sourceEdges}`, overlaps: item.rootOverlaps,
  keyRouteCrossings: item.keyRouteCardInteriorCrossings, ms: { build: item.buildMs, layout: item.layoutMs, route: item.routeMs } }));
console.log(`Saved concise report: ${output}`);
