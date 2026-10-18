import assert from 'node:assert/strict';
import { buildFocusCatalog, edgeAllowed, focusSelection, matchFamilies, workflowOverview, DEFAULT_GRAPH_FILTERS } from '../agent_provenance_react/app/components/graph_search.ts';

const makeNode = (id, label, method, run = `private-${id}`) => ({
  id, kind: 'JoinedActivity', label, semanticRole: 'operation', supportTraces: [run], supportCount: 2,
  methods: [method], attention: 'key', resultBackbone: true,
  importance: { result: { status: 'supported', supportedClaims: ['private output text'], contradictedClaims: [], onRecordedPath: true },
    semantic: { level: 'key' }, decision: 'expand', reasons: [], support: 2, tier: 'result', facets: [], outcome: { status: 'available', contributions: null, cohorts: [], globalTools: [{ tool: method, importance: 0.6 }] } },
  variants: [{ run, instanceId: `instance-${id}`, parameters: { query: 'BRCA1 threshold 0.75' }, roleBindings: { target_gene: 'LEF1 HIF1A private-family-a' }, diagnostics: [], evidence: [] }],
  instances: [{ id: `instance-${id}`, run, calls: [{ id: '1', tool: method, step: 1 }], internalFlow: [], resultTargets: [], resultBackbone: true, background: false, attention: 'key', targetEvidence: [], resultEvidence: [{ claimId: 'claim-1', claimText: 'reported result claim', relation: 'supports', reason: '', evidence: [] }] }],
  operationGroups: [{ id: `operation-${id}`, tool: method, failure: false, supportTraces: [run], members: [{ run, callId: '1', step: 1 }] }],
});

const graph = {
  nodes: [makeNode('family-a', 'Find target data', 'search', 'private-family-a'), makeNode('family-b', 'Write report', 'write', 'private-family-a')],
  edges: [{ id: 'edge-ab', source: 'family-a', target: 'family-b', supportCount: 2, supportTraces: ['private-family-a'], inferred: false,
    witnesses: [{ run: 'private-family-a', sourceInstance: 'instance-family-a', targetInstance: 'instance-family-b', callPath: ['call-family-a'], inferred: false, highlighted: true, internalPath: [] }] }],
};

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
assert.equal(edgeAllowed(graph.edges[0], 'recorded'), true);
assert.equal(edgeAllowed(graph.edges[0], 'inferred'), false);
const isolated = focusSelection(graph, new Set(['family-a']), new Set(), { ...DEFAULT_GRAPH_FILTERS, view: 'isolate', context: 'workflow' });
assert.deepEqual([...isolated.nodes], ['family-a', 'family-b']);
assert.deepEqual([...isolated.edges], ['edge-ab']);
const matchedEndpoints = focusSelection(graph, new Set(['family-a', 'family-b']), new Set(), DEFAULT_GRAPH_FILTERS);
assert.deepEqual([...matchedEndpoints.edges], ['edge-ab']);
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
