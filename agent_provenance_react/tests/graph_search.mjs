import assert from 'node:assert/strict';
import { buildFocusCatalog, edgeAllowed, focusSelection, matchFamilies, workflowOverview, resultFlowSelection, DEFAULT_GRAPH_FILTERS, GRAPH_VIEW_PRESETS } from '../app/components/graph_search.ts';
import { workflowFrameIds } from '../app/components/graph_layout.ts';
import { importanceValue, importanceBackground } from '../app/components/graph_importance.ts';

const makeNode = (id, label, method, run = `private-${id}`) => ({
  id, kind: 'JoinedActivity', label, semanticRole: 'operation', supportTraces: [run], supportCount: 2,
  methods: [method], attention: 'key', resultBackbone: true,
  importance: { result: { status: 'supported', supportedClaims: ['private output text'], contradictedClaims: [], onRecordedPath: true },
    semantic: { level: 'key' }, decision: 'expand', reasons: [], support: 2, tier: 'result', facets: [], outcome: { status: 'available', contributions: null, cohorts: [], globalTools: [{ tool: method, importance: 0.6 }] } },
  variants: [{ run, instanceId: `instance-${id}`, parameters: { query: 'BRCA1 threshold 0.75' }, roleBindings: { target_gene: 'LEF1 HIF1A private-family-a' }, diagnostics: [], evidence: [] }],
  instances: [{ id: `instance-${id}`, run, calls: [{ id: '1', tool: method, step: 1 }], internalCalls: [], internalFlow: [], resultTargets: [], resultBackbone: true, background: false, attention: 'key', targetEvidence: [], resultEvidence: [{ claimId: 'claim-1', claimText: 'reported result claim', relation: 'supports', reason: '', evidence: [] }] }],
  operationGroups: [{ id: `operation-${id}`, tool: method, failure: false, supportTraces: [run], members: [{ run, callId: '1', step: 1 }] }],
});

const graph = {
  nodes: [makeNode('family-a', 'Find target data', 'search', 'private-family-a'), makeNode('family-b', 'Write report', 'write', 'private-family-a')],
  edges: [{ id: 'edge-ab', source: 'family-a', target: 'family-b', supportCount: 2, supportTraces: ['private-family-a'], inferred: false,
    witnesses: [{ run: 'private-family-a', sourceInstance: 'instance-family-a', targetInstance: 'instance-family-b', callPath: ['call-family-a'], inferred: false, highlighted: true, internalPath: [] }] }],
};
const unrated = structuredClone(graph.nodes[0]);
unrated.importance.semantic.level = 'unknown';
assert.equal(importanceValue(unrated, 'semantic'), null);
assert.equal(importanceBackground(importanceValue(unrated, 'semantic'), 1), '#ffffff');
unrated.importance.semantic.level = 'supporting';
assert.equal(importanceValue(unrated, 'semantic'), 0);

const history = {
  nodes: Array.from({ length: 4000 }, (_, index) => ({ ...makeNode(`event-${index}`, 'recorded action', 'generic tool', 'r'),
    assessment: { level: index === 3 ? 'key' : 'unknown' },
    instances: [{ run: 'r', id: `instance-${index}`, calls: [{ id: `call-${index}` }] }] })),
  edges: [{ source: 'event-3', target: 'event-4' }],
  structuredOutcomes: [{ run: 'r', outcomes: [{ id: 'final', name: 'Final quality', eventId: 'call-3',
    value: 100, round: 0, observedThroughRound: 199, scope: 'system', terminal: true }] }],
};
const overview = workflowOverview(history);
assert.equal(overview.nodeIds.size, 4000);
assert.equal(overview.results[0].round, 0);
assert.equal(overview.results[0].observedThroughRound, 199);
assert.equal(history.nodes.length, 4000); // Unreviewed history remains represented on the canvas.

const resultFlow = {
  nodes: [makeNode('source', '', '', 'run'), makeNode('receipt', '', '', 'run'), makeNode('result', '', '', 'run'),
    makeNode('other', '', '', 'other-run')],
  edges: [
    { id: 'source-receipt', source: 'source', target: 'receipt', witnesses: [{ run: 'run', sourceInstance: 'instance-source', targetInstance: 'instance-receipt', highlighted: true }] },
    { id: 'receipt-result', source: 'receipt', target: 'result', witnesses: [{ run: 'run', sourceInstance: 'instance-receipt', targetInstance: 'instance-result', highlighted: true }] },
    { id: 'other-result', source: 'other', target: 'result', witnesses: [{ run: 'other-run', sourceInstance: 'instance-other', targetInstance: 'instance-result', highlighted: true }] },
    { id: 'result-outgoing', source: 'result', target: 'other', witnesses: [{ run: 'run', sourceInstance: 'instance-result', targetInstance: 'instance-other', highlighted: true }] },
  ],
};
resultFlow.nodes[0].instances[0].calls[0].id = 'source';
resultFlow.nodes[1].instances[0].calls[0].id = 'receipt';
resultFlow.nodes[2].instances[0].calls[0].id = 'final';
assert.deepEqual([...resultFlowSelection(resultFlow, 'run', 'final').nodes].sort(), ['receipt', 'result', 'source']);
assert.deepEqual([...resultFlowSelection(resultFlow, 'run', 'final').edges].sort(), ['receipt-result', 'source-receipt']);
assert.equal(resultFlowSelection(resultFlow, 'run', 'missing').nodes.size, 0);
const hiddenResult = structuredClone(resultFlow);
hiddenResult.nodes[2].instances[0].calls = [];
hiddenResult.nodes[2].instances[0].internalCalls = ['final'];
assert.deepEqual([...resultFlowSelection(hiddenResult, 'run', 'final').nodes].sort(), ['receipt', 'result', 'source']);
const frameContexts = new Map(Array.from({ length: 6 }, (_, i) => [`n${i}`, { laneId: `actor-${i}`, roundStart: i < 4 ? 5 : 4 }]));
assert.deepEqual(workflowFrameIds(frameContexts, ['n0', 'n4']).sort(), ['n0', 'n1', 'n2', 'n3', 'n4']);

assert.deepEqual([...matchFamilies(graph, { ...DEFAULT_GRAPH_FILTERS, text: 'target data' })], ['family-a']);
assert.deepEqual([...matchFamilies(graph, { ...DEFAULT_GRAPH_FILTERS, text: 'target missing' })], []);
assert.deepEqual([...matchFamilies(graph, { ...DEFAULT_GRAPH_FILTERS, text: 'reported claim' })], ['family-a', 'family-b']);
assert.deepEqual([...matchFamilies(graph, { ...DEFAULT_GRAPH_FILTERS, text: 'private output' })], []);
assert.deepEqual([...matchFamilies(graph, { ...DEFAULT_GRAPH_FILTERS, minOutcome: 0.5 })], ['family-a', 'family-b']);
assert.deepEqual([...matchFamilies(graph, { ...DEFAULT_GRAPH_FILTERS, minOutcome: 0.7 })], []);
const unknownOutcome = structuredClone(graph);
unknownOutcome.nodes[0].importance.outcome.globalTools[0].importance = null;
assert.deepEqual([...matchFamilies(unknownOutcome, { ...DEFAULT_GRAPH_FILTERS, minOutcome: 0.1 })], ['family-b']);
const noResultEvidence = structuredClone(graph);
noResultEvidence.nodes[0].importance.result.status = 'none';
noResultEvidence.nodes[1].importance.result.status = 'none';
noResultEvidence.nodes[0].variants[0].evidence = [{ context: 'unrelated raw evidence' }];
assert.deepEqual([...matchFamilies(noResultEvidence, { ...DEFAULT_GRAPH_FILTERS, evidence: 'direct' })], []);
noResultEvidence.nodes[0].instances[0].resultTargets = ['final-result'];
assert.deepEqual([...matchFamilies(noResultEvidence, { ...DEFAULT_GRAPH_FILTERS, evidence: 'direct' })], ['family-a']);
const contextOnly = structuredClone(graph);
contextOnly.nodes[0].instances[0].resultEvidence[0].relation = 'context';
assert.deepEqual([...matchFamilies(contextOnly, { ...DEFAULT_GRAPH_FILTERS, evidence: 'supported' })], ['family-b']);
contextOnly.structuredOutcomes = [{ run: 'private-family-a', outcomes: [{ eventId: '1', terminal: true, scope: 'system' }] }];
assert.deepEqual([...matchFamilies(contextOnly, { ...DEFAULT_GRAPH_FILTERS, evidence: 'supported' })], ['family-a', 'family-b']);
assert.equal(edgeAllowed(graph.edges[0], 'recorded'), true);
assert.equal(edgeAllowed(graph.edges[0], 'inferred'), false);
const isolated = focusSelection(graph, new Set(['family-a']), new Set(), { ...DEFAULT_GRAPH_FILTERS, view: 'isolate', context: 'workflow' });
assert.deepEqual([...isolated.nodes], ['family-a', 'family-b']);
assert.deepEqual([...isolated.edges], ['edge-ab']);
const matchedEndpoints = focusSelection(graph, new Set(['family-a', 'family-b']), new Set(), DEFAULT_GRAPH_FILTERS);
assert.deepEqual([...matchedEndpoints.edges], ['edge-ab']);
// Recurrent endpoints alone do not make their connecting dependency shared.
const sharedThreshold = focusSelection(graph, new Set(['family-a', 'family-b']), new Set(), { ...DEFAULT_GRAPH_FILTERS, minSupport: 2 });
assert.equal(sharedThreshold.edges.size, 0);
const repeatedEdge = structuredClone(graph);
for (const node of repeatedEdge.nodes) node.instances.push({ ...node.instances[0], run:'another-run', id:node.instances[0].id+'-another' });
repeatedEdge.edges[0].witnesses.push({ ...repeatedEdge.edges[0].witnesses[0], run:'another-run', sourceInstance:repeatedEdge.nodes[0].instances[1].id, targetInstance:repeatedEdge.nodes[1].instances[1].id });
assert.deepEqual([...focusSelection(repeatedEdge, new Set(['family-a', 'family-b']), new Set(), { ...DEFAULT_GRAPH_FILTERS, minSupport:2 }).edges], ['edge-ab']);
const built = buildFocusCatalog(graph, 'search target');
assert.deepEqual(Object.keys(built.catalog.nodes[0]), ['id', 'label', 'tools', 'intent', 'subjects', 'role', 'result', 'failed', 'support']);
const serialized = JSON.stringify(built.catalog);
assert.ok(!serialized.includes('private-family-a'));
assert.ok(!serialized.includes('private output text'));
assert.ok(!serialized.includes('instance-family-a'));
assert.ok(!serialized.includes('edge-ab'));
assert.ok(serialized.includes('LEF1 HIF1A'));
assert.ok(serialized.includes('0.75'));
assert.ok(serialized.includes('LEF1 HIF1A'));
assert.ok(!serialized.includes('private-family-a'));
assert.equal(built.nodeIds['family-a'], 'n0');
const differentQuery = buildFocusCatalog(graph, 'missing second workflow');
assert.deepEqual(differentQuery.nodeIds, built.nodeIds);
assert.deepEqual(differentQuery.edgeIds, built.edgeIds);
assert.equal(built.edgeIds['edge-ab'], 'e0');
assert.deepEqual(built.coverage, { shownNodes: 2, totalNodes: 2, shownEdges: 1, totalEdges: 1 });

const diamond = {
  ...graph,
  nodes: ['A', 'B', 'C', 'D', 'E'].map((id) => makeNode(id, id, 'tool', 'w')),
  edges: [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'E']].map(([source, target], index) => ({
    id: `edge-${index}`, source, target, supportCount: 1, supportTraces: [], inferred: false,
    witnesses: [{ run: 'w', sourceInstance: `instance-${source}`, targetInstance: `instance-${target}`, callPath: [], inferred: false, highlighted: false, internalPath: [] }],
  })),
};
const branch = focusSelection(diamond, new Set(['B']), new Set(), { ...DEFAULT_GRAPH_FILTERS, view: 'isolate', context: 'workflow' });
assert.deepEqual([...branch.nodes].sort(), ['A', 'B', 'D']);
assert.deepEqual([...branch.edges].sort(), ['edge-0', 'edge-2']);
const beforeContext = JSON.stringify(diamond);
const inputsOnly = focusSelection(diamond, new Set(['B']), new Set(), { ...GRAPH_VIEW_PRESETS.main });
assert.deepEqual([...inputsOnly.nodes].sort(), ['A', 'B']);
assert.deepEqual([...inputsOnly.edges], ['edge-0']);
const localContext = focusSelection(diamond, new Set(['D']), new Set(), { ...DEFAULT_GRAPH_FILTERS, context: 'neighbors' });
assert.deepEqual([...localContext.nodes].sort(), ['B', 'D']);
assert.deepEqual([...localContext.edges], ['edge-2']);
const junction = structuredClone(diamond);
junction.edges.push({ ...junction.edges[3], id: 'join-cd', source: 'C', target: 'D', witnesses: [{
  run: 'w', sourceInstance: 'instance-C', targetInstance: 'instance-D', callPath: [], inferred: true, highlighted: true, internalPath: [],
}] });
const immediateInputs = focusSelection(junction, new Set(['D']), new Set(), GRAPH_VIEW_PRESETS.main);
assert.deepEqual([...immediateInputs.nodes].sort(), ['B', 'C', 'D']);
assert.equal(immediateInputs.boundaryEdges.size, 2, 'Bounded context must disclose both omitted upstream connections');
assert(immediateInputs.edges.has('join-cd'), 'Immediate context retains every complementary parent');
const retainedInputs = focusSelection(junction, new Set(['D']), new Set(), { ...GRAPH_VIEW_PRESETS.main, context:'inputs' });
assert.deepEqual([...retainedInputs.nodes].sort(), ['A', 'B', 'C', 'D']);
assert(retainedInputs.edges.has('join-cd'), 'Input context must retain reviewed semantic inputs, not just mechanical links');
assert(!retainedInputs.nodes.has('E'), 'Input context must not grow into an unrelated downstream branch');
assert.equal(JSON.stringify(diamond), beforeContext, 'Filtering is a reversible display projection');
assert.deepEqual([...focusSelection(diamond, new Set(['A', 'B', 'C']), new Set(['edge-0']), DEFAULT_GRAPH_FILTERS).edges], ['edge-0']);

const crossRun = {
  ...diamond,
  nodes: [makeNode('A', 'A', 'tool', 'r1'), { ...makeNode('B', 'B', 'tool', 'r1'), instances: [
    { id: 'b-r1', run: 'r1', calls: [], internalFlow: [], resultTargets: [], resultBackbone: false, background: false, attention: 'key', targetEvidence: [] },
    { id: 'b-r2', run: 'r2', calls: [], internalFlow: [], resultTargets: [], resultBackbone: false, background: false, attention: 'key', targetEvidence: [] },
  ] }, makeNode('C', 'C', 'tool', 'r2')],
  edges: [
    { ...diamond.edges[0], id: 'ab', source: 'A', target: 'B', witnesses: [{ run: 'r1', sourceInstance: 'instance-A', targetInstance: 'b-r1', inferred: false }] },
    { ...diamond.edges[0], id: 'bc', source: 'B', target: 'C', witnesses: [{ run: 'r2', sourceInstance: 'b-r2', targetInstance: 'instance-C', inferred: false }] },
  ],
};
const noCrossRun = focusSelection(crossRun, new Set(['A']), new Set(), { ...DEFAULT_GRAPH_FILTERS, view: 'isolate', context: 'workflow' });
assert.deepEqual([...noCrossRun.nodes], ['A', 'B']);
assert.deepEqual([...noCrossRun.edges], ['ab']);
assert.deepEqual([...focusSelection(crossRun, new Set(['C']), new Set(), GRAPH_VIEW_PRESETS.main).nodes].sort(), ['B', 'C']);

const repeatedOccurrence = {
  ...crossRun,
  nodes: [
    makeNode('A', 'A', 'tool', 'r1'),
    { ...makeNode('B', 'B', 'tool', 'r1'), instances: [
      { id: 'b1', run: 'r1', calls: [], internalFlow: [], resultTargets: [], resultBackbone: false, background: false, attention: 'key', targetEvidence: [] },
      { id: 'b2', run: 'r1', calls: [], internalFlow: [], resultTargets: [], resultBackbone: false, background: false, attention: 'key', targetEvidence: [] },
    ] },
    makeNode('C', 'C', 'tool', 'r1'),
  ],
  edges: [
    { ...crossRun.edges[0], witnesses: [{ run: 'r1', sourceInstance: 'instance-A', targetInstance: 'b1', inferred: false }] },
    { ...crossRun.edges[1], witnesses: [{ run: 'r1', sourceInstance: 'b2', targetInstance: 'instance-C', inferred: false }] },
  ],
};
const noOccurrenceJump = focusSelection(repeatedOccurrence, new Set(['A']), new Set(), { ...DEFAULT_GRAPH_FILTERS, view: 'isolate', context: 'workflow' });
assert.deepEqual([...noOccurrenceJump.nodes], ['A', 'B']);
assert.deepEqual([...noOccurrenceJump.edges], ['ab']);
console.log('graph_search tests passed');

const explicitPath = structuredClone(noResultEvidence);
explicitPath.nodes.forEach(node=>{node.instances[0].resultTargets=[];node.instances[0].resultBackbone=false;node.resultBackbone=false;node.importance.result.onRecordedPath=false;node.instances[0].resultEvidence=[];});
explicitPath.nodes[0].resultBackbone=true;explicitPath.nodes[0].instances[0].resultBackbone=true;
assert.deepEqual([...matchFamilies(explicitPath,GRAPH_VIEW_PRESETS.main)],['family-a'],'Main flow includes explicit result paths even without answer-support citations');
assert.deepEqual([...matchFamilies(explicitPath,{...DEFAULT_GRAPH_FILTERS,evidence:'supported'})],[],'Direct support stays a separate filter');

const endpointRuns=structuredClone(crossRun);
endpointRuns.nodes.forEach(node=>{node.resultBackbone=true;node.importance.result.status='none';node.instances.forEach(instance=>{instance.resultBackbone=true;instance.resultEvidence=[];instance.internalCalls=[];});});
assert.deepEqual([...matchFamilies(endpointRuns,GRAPH_VIEW_PRESETS.main)].sort(),['B','C'],'Result endpoints remain occurrence-specific across a shared family');
