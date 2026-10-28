import assert from 'node:assert/strict';
import { buildProvCluster, groupProvEntities } from '../app/components/prov_cluster.ts';

const run = (id, { tool = 'read', args = { path: 'a' }, input = 'seed', output = 'result', status = 'ok', repeat = false, empty = false } = {}) => {
  const nodes = [
    { id: `${id}-in`, kind: 'Entity', entityType: 'File', response: input },
    { id: `${id}-act`, kind: 'Activity', toolCallId: `${id}-call`, tool, args, status, timeIndex:1 },
    ...(repeat ? [{ id: `${id}-act2`, kind: 'Activity', toolCallId: `${id}-call2`, tool, args, status, timeIndex:2 }] : []),
    { id: `${id}-out`, kind: 'Entity', entityType: 'File', ...(empty ? {} : { response: output }) },
  ];
  const edges = [
    { source: `${id}-in`, target: `${id}-act`, relation: 'usedBy' },
    { source: `${id}-act`, target: `${id}-out`, relation: 'generatedBy' },
    ...(repeat ? [{ source: `${id}-in`, target: `${id}-act2`, relation: 'usedBy' }] : []),
  ];
  return { nodes, edges };
};
const family = (instances) => [{ id: 'family', kind: 'JoinedActivity', label: 'family', operationGroups:[], instances: instances.map(([runId, calls]) => ({
  id: `instance-${runId}`, run: runId, calls: calls.map((id, index) => ({ id: `${runId}-call${index ? '2' : ''}`, tool: 'read', step: index })), internalCalls: [], source: undefined,
})) }];
const dags = Object.fromEntries(['a', 'b', 'args', 'input', 'output', 'failed', 'repeat', 'punct', 'number', 'string', 'empty'].map((id) => [id, run(id)]));
dags.args = run('args', { args: { path: 'b' } });
dags.input = run('input', { input: 'other' });
dags.output = run('output', { output: 'different' });
dags.failed = run('failed', { status: 'failed' });
dags.repeat = run('repeat', { repeat: true });
dags.punct = run('punct', { args: { text: 'a,b: "x"' } });
dags.number = run('number', { args: { value: 1 } });
dags.string = run('string', { args: { value: '1' } });
dags.empty = run('empty', { empty: true });
const before = structuredClone(dags);
const instances = Object.keys(dags).map((id) => [id, [id]]);
// Add the repeated call to the family selection for its second occurrence.
const families = family(instances);
families[0].instances.find((item) => item.run === 'repeat').calls.push({ id: 'repeat-call2', tool: 'read', step: 1 });
const graph = buildProvCluster(families, dags);
assert.deepEqual(dags, before, 'source DAGs are not mutated');
assert.equal(graph.rawActivityCount, 12);
assert.equal(graph.nodes.filter((node) => node.kind === 'Activity' && node.members.some((member) => member.run === 'a')).length, 1);
assert.equal(graph.nodes.find((node) => node.kind === 'Activity' && node.members.some((member) => member.run === 'a')).members.length, 3, 'matching runs quotient together while the repeated run contributes only its first occurrence');
assert.equal(graph.nodes.filter((node) => node.kind === 'Activity' && node.members.some((member) => member.run === 'repeat')).length, 2, 'same-run repeats remain distinct');
assert.equal(graph.nodes.filter((node) => node.kind === 'Activity').length, 10, 'args, input, output and status differences remain separate');
assert.equal(graph.nodes.filter((node) => node.kind === 'Entity' && node.members.some((member) => member.run === 'empty')).length, 2, 'missing payload entities never merge');
assert(graph.edges.some((edge) => edge.members.some((member) => member.run === 'a')));
assert(graph.edges.every((edge) => edge.members.every((member) => member.edge.source && member.edge.target)));

assert(graph.edges.some((edge) => edge.members.length >= 2), 'matching edge witnesses are retained');

const punctuationVsNumber = buildProvCluster(family([['punct', ['punct']], ['number', ['number']], ['string', ['string']]]), dags);
assert.equal(punctuationVsNumber.nodes.filter((node) => node.kind === 'Activity').length, 3, 'punctuation and number/string JSON fidelity is preserved');
console.log('prov_cluster offline tests passed');

// Reuse reviewed operation alignment while retaining distinct parameter/output records.
const alignedFamilies=family([['a',['a']],['args',['args']],['failed',['failed']]]);
alignedFamilies[0].operationGroups=[{id:'reviewed',failure:false,members:[{run:'a',callId:'a-call'},{run:'args',callId:'args-call'},{run:'failed',callId:'failed-call'}]}];
const aligned=buildProvCluster(alignedFamilies,dags);
assert.equal(aligned.nodes.filter(node=>node.kind==='Activity').length,2,'Failed and successful calls stay separate even under one reviewed operation anchor');
assert.equal(aligned.nodes.find(node=>node.kind==='Activity'&&!node.failed).members.length,2);
assert.equal(aligned.nodes.filter(node=>node.kind==='Entity'&&node.members.some(member=>member.node.endsWith('-out'))).length,3,'Different producer arguments retain different output entities');

const external=(id,producerTool)=>({nodes:[
 {id:`${id}-producer`,kind:'Activity',toolCallId:'external',tool:producerTool,args:{},timeIndex:0},
 {id:`${id}-in`,kind:'Entity',entityType:'Data',response:'same'},
 {id:`${id}-act`,kind:'Activity',toolCallId:`${id}-call`,tool:'consume',args:{},timeIndex:1},
 {id:`${id}-out`,kind:'Entity',entityType:'Data',response:'equal result'}],edges:[
 {source:`${id}-producer`,target:`${id}-in`,relation:'generatedBy'},
 {source:`${id}-in`,target:`${id}-act`,relation:'usedBy'},
 {source:`${id}-act`,target:`${id}-out`,relation:'generatedBy'}]});
const origins=buildProvCluster(family([['x',['x']],['y',['y']]]),{x:external('x','producer-a'),y:external('y','producer-b')});
assert.equal(origins.nodes.filter(node=>node.kind==='Activity').length,2,'Equal input values from different external producers are not interchangeable');
assert.equal(origins.rawActivityCount,2,'External producer activities stay outside the selected cluster');
assert.equal(origins.nodes.filter(node=>node.kind==='Entity').length,4);
for(const edge of aligned.edges)for(const member of edge.members){
 assert(aligned.nodes.find(node=>node.id===edge.source).members.some(item=>item.run===member.run&&item.node===member.edge.source));
 assert(aligned.nodes.find(node=>node.id===edge.target).members.some(item=>item.run===member.run&&item.node===member.edge.target));
}
const emptyDags={x:run('x',{input:{},empty:true}),y:run('y',{input:{},empty:true})};
assert.equal(buildProvCluster(family([['x',['x']],['y',['y']]]),emptyDags).nodes.filter(node=>node.kind==='Entity').length,4,'Empty object payloads do not establish entity identity');
const mixed=run('a');mixed.edges.push({...mixed.edges[0],inferred:true});
assert.equal(buildProvCluster(family([['a',['a']]]),{a:mixed}).edges.filter(edge=>edge.relation==='usedBy').length,2,'Recorded and inferred witnesses stay separate');
console.log('Reviewed alignment, exact entity lineage, mixed evidence and per-run witness endpoints passed');

const variantInputs={nodes:[
 {id:'a',kind:'Activity',label:'consume',members:[{run:'one',node:'a'}]},
 ...['condition','data1','data2','output'].map((id,index)=>({id,kind:'Entity',entityType:'Data',label:id==='condition'?'constraint source':id==='output'?'consume output':'attribute source',members:[{run:index===2?'two':'one',node:id}]}))
],edges:[
 ...['condition','data1','data2'].map(id=>({source:id,target:'a',relation:'usedBy',inferred:id==='data2',members:[{run:id==='data2'?'two':'one',edge:{source:id,target:'a',relation:'usedBy'}}]})),
 {source:'a',target:'output',relation:'generatedBy',inferred:false,members:[{run:'one',edge:{source:'a',target:'output',relation:'generatedBy'}}]}
],rawActivityCount:1,rawEntityCount:4,rawNodeCount:5};
const sourceBefore=JSON.stringify(variantInputs);
const bundled=groupProvEntities(variantInputs),bundle=bundled.nodes.find(node=>node.variants);
assert.equal(bundle.variants.length,2,'Same-role data variants fold without claiming exact identity');
assert.equal(bundled.nodes.filter(node=>node.kind==='Entity').length,3,'Complementary condition, attributes and output roles remain separate');
assert.equal(bundled.edges.filter(edge=>edge.source===bundle.id).length,2,'Recorded and inferred evidence stay distinct inside bundles');
assert.equal(bundled.edges.reduce((total,edge)=>total+edge.members.length,0),variantInputs.edges.length);
assert.deepEqual(groupProvEntities(variantInputs,new Set([bundle.id])).nodes,variantInputs.nodes,'Unfolding restores all exact entities');
assert.equal(JSON.stringify(variantInputs),sourceBefore,'Variant grouping never changes source identities or witnesses');
const differentType=structuredClone(variantInputs);differentType.nodes.find(node=>node.id==='data2').entityType='Other';
assert(!groupProvEntities(differentType).nodes.some(node=>node.variants),'Entity types are not conflated');
const differentConsumer=structuredClone(variantInputs);differentConsumer.nodes.push({id:'b',kind:'Activity',label:'other consumer',members:[]});differentConsumer.edges.find(edge=>edge.source==='data2').target='b';
assert(!groupProvEntities(differentConsumer).nodes.some(node=>node.variants),'Different activity branches remain distinct');
console.log('Reversible entity variant groups preserve complementary roles, typed neighborhoods and all original witnesses');
const repeatedFamily=family([['repeat',['repeat']]]);
repeatedFamily[0].instances[0].calls.push({id:'repeat-call2',tool:'read',step:2});
repeatedFamily[0].operationGroups=[{id:'reviewed-repeat',tool:'read',failure:false,members:[{run:'repeat',callId:'repeat-call'},{run:'repeat',callId:'repeat-call2'}]}];
assert.equal(buildProvCluster(repeatedFamily,{repeat:dags.repeat}).nodes.filter(node=>node.kind==='Activity').length,1,'Independent reviewed calls share an Activity glyph, retaining both occurrences');
const dependent=structuredClone(dags.repeat);dependent.edges.push({source:'repeat-out',target:'repeat-act2',relation:'usedBy'});
assert.equal(buildProvCluster(repeatedFamily,{repeat:dependent}).nodes.filter(node=>node.kind==='Activity').length,2,'Repeated calls linked by dataflow cannot collapse into one Activity');
console.log('Independent repeated operations aggregate; dependent occurrences remain separate');
