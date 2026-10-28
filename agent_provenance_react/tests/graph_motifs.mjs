import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { displayMotifs } from '../app/components/graph_motifs.ts';
const node = (id, tool='transform') => ({id,methods:[tool],semanticRole:'selection',supportTraces:['r'],
  importance:{semantic:{level:'key'},result:{status:'none'}},operationGroups:[],instances:[{resultTargets:[]}]});
const edge = (source,target,inferred=false) => ({id:`${source}-${target}`,source,target,witnesses:[{inferred}]});
const graph = {nodes:[node('source','read'),node('variant-a'),node('variant-b'),node('consumer','write')],
  edges:[edge('source','variant-a'),edge('source','variant-b'),edge('variant-a','consumer'),edge('variant-b','consumer')]};
const before=JSON.stringify(graph);
const [connector]=displayMotifs(graph);
assert.equal(connector.kind,'connector');
assert.deepEqual(connector.memberIds,['variant-a','variant-b']);
assert.deepEqual(connector.inputIds,['source']);
assert.deepEqual(connector.outputIds,['consumer']);
assert.equal(JSON.stringify(graph),before);
assert.equal(displayMotifs(graph,new Set(['variant-a'])).length,0);
const fan={...graph,edges:graph.edges.slice(0,2)};
assert.equal(displayMotifs(fan)[0].kind,'fan');
const changedEvidence=structuredClone(graph);changedEvidence.edges[1].witnesses[0].inferred=true;
assert.equal(displayMotifs(changedEvidence).length,0,'Recorded and inferred neighborhoods must remain distinguishable');
const changedRole=structuredClone(graph);changedRole.nodes[2].methods=['validate'];
assert.equal(displayMotifs(changedRole).length,0,'Structural matches alone must not mix unrelated tools');
for(const protectedKind of ['failure','result','path','shared','actor']) {
  const modified=structuredClone(graph);
  if(protectedKind==='failure')modified.nodes[2].operationGroups=[{failure:true}];
  if(protectedKind==='result')modified.nodes[2].importance.result.status='supported';
  if(protectedKind==='path')modified.nodes[2].instances[0].resultBackbone=true;
  if(protectedKind==='shared')modified.nodes[2].supportTraces=['r','other'];
  if(protectedKind==='actor')modified.nodes[2].executionContext={laneId:'actor-2',roundStart:1,roundEnd:1};
  assert.equal(displayMotifs(modified).length,0,`${protectedKind} boundaries must remain visible`);
}
assert.equal(displayMotifs({nodes:[node('one'),node('two')],edges:[]}).length,0,'Disconnected nodes cannot be folded merely because their tools match');
console.log('Directed fan/connector display motifs preserve evidence and result boundaries');

const require = createRequire(new URL('../package.json', import.meta.url));
const ts = require('typescript');
const componentSource = readFileSync(new URL('../app/components/semantic_graph.tsx', import.meta.url),'utf8');
const compile = text => ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
// Display motif projection preserves every original edge and its inspectable witness payload.
const project = new Function(`${compile(componentSource.slice(componentSource.indexOf('function motifDisplay('), componentSource.indexOf('function WorkflowCard(')))}; return motifDisplay;`)();
const motif = { id:'motif:variants', kind:'fan', memberIds:['variant-a','variant-b'], toolNames:['arbitrary-tool'], inputIds:['input'], outputIds:[] };
const visual = { nodes:['input','variant-a','variant-b'].map(id => ({id,style:{width:220,height:72},data:{kind:'family'}})), edges:['a','b'].map((id,i) => ({id,source:'input',target:motif.memberIds[i],data:{semanticEdge:{id,witnesses:[{run:id,sourceCallId:'source-'+id,targetCallId:'consumer-'+id}]}}})) };
const visualBefore = JSON.stringify(visual);
const folded = project(visual,[motif],new Set(),()=>{});
assert.equal(folded.nodes.length,2);
assert.equal(folded.edges.length,visual.edges.length);
assert.deepEqual(folded.edges.map(e=>e.target),[motif.id,motif.id]);
for(let i=0;i<folded.edges.length;i++) assert.equal(folded.edges[i].data,visual.edges[i].data);
assert.equal(JSON.stringify(visual),visualBefore);
assert.equal(project(visual,[motif],new Set([motif.id]),()=>{}).nodes.length,3);
console.log('Variant glyph projection keeps original edge witnesses and expands reversibly');
