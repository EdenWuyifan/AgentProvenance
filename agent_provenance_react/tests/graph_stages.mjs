import assert from 'node:assert/strict';
import { DEFAULT_RUN_RESULT, summarizeRunResults } from '../app/components/run_result.ts';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { explicitOutcome, stageSummary, toolErrored, workflowStageGroups, humanToolTitle, stageParameterCount } from '../app/components/graph_stages.ts';

const node = (id, run, label='Inspect evidence', tool='inspect') => ({
  id, label, methods:[tool], semanticRole:'inspection', supportTraces:[run],
  importance:{semantic:{level:'key'}}, operationGroups:[],
  instances:[{run,id:`instance-${id}`,calls:[{id:`call-${id}`,tool}],internalCalls:[`call-${id}`]}],
});
const edge = (id,source,target,run,inferred=false) => ({id,source,target,supportCount:1,supportTraces:[run],
  witnesses:[{run,sourceInstance:`instance-${source}`,targetInstance:`instance-${target}`,inferred}]});
const a=node('a','r1'), b=node('b','r2');
const graph={nodes:[node('input','r1','Read input','read'),a,b,node('consumer','r1','Consume','consume')],
  edges:[edge('in-a','input','a','r1'),edge('in-b','input','b','r2'),edge('a-out','a','consumer','r1'),edge('b-out','b','consumer','r2')]};
for (const node of [graph.nodes[0],graph.nodes[3]]) {node.instances.push({...node.instances[0],run:'r2'});node.supportTraces.push('r2');}
const before=JSON.stringify(graph);
const groups=workflowStageGroups(graph);
assert.deepEqual(groups[0].memberIds,['a','b']);
assert.equal(JSON.stringify(graph),before);
const distinct=structuredClone(graph);distinct.nodes[2].label='Exclude noisy evidence';
assert.equal(workflowStageGroups(distinct).length,0,'Distinct selection intents remain separate');
distinct.nodes[2].label=a.label;distinct.nodes[2].operationGroups=[{failure:true,members:[]}];
assert.equal(workflowStageGroups(distinct).length,1,'Success and error variants share an operation container while original outcomes remain distinct');
assert.equal(explicitOutcome({trainingOutcome:{status:'failure'},score:1}),'failure');
assert.equal(explicitOutcome({score:0}),'unknown','A score alone is not a run outcome label');
assert.equal(toolErrored({status:'success',response:{error:0.05}}),false,'Statistical error values are not tool failures');
assert.equal(toolErrored({response:{error:{message:'Missing input'}}}),true);
const traces=[{id:'r1',trainingOutcome:{status:'success'},toolCalls:[{id:'call-a',status:'success'}]},
  {id:'r2',trainingOutcome:{status:'failure'},toolCalls:[{id:'call-b',status:'success'}]}];
const withPreparation=structuredClone(a);withPreparation.instances[0].internalCalls.push('prepare');
const summary=stageSummary([withPreparation,b],traces);
assert.deepEqual(summary,{calls:2,covered:3,runs:2,errors:0,success:1,failure:1});

const require=createRequire(new URL('../package.json',import.meta.url));
const ts=require('typescript');
const source=readFileSync(new URL('../app/components/semantic_graph.tsx',import.meta.url),'utf8');
const compiled=ts.transpileModule(source.slice(source.indexOf('function stageDisplay('),source.indexOf('function WorkflowCard(')),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const project=new Function('stageSummary','humanToolTitle','stageParameterCount','summarizeRunResults','importanceValue','importanceMaximum','importanceBackground','supportEdgeWidth','RESULT_PATH_COLOR',`${compiled};return stageDisplay;`)(stageSummary,humanToolTitle,stageParameterCount,summarizeRunResults,()=>0,()=>1,()=> '#fff',n=>n,'#2563eb');
const motif=groups[0];
const rendered={nodes:[{id:'input',data:{kind:'family'}},{id:motif.id,style:{},data:{kind:'family',motif,semanticLevel:'key'}},{id:'consumer',data:{kind:'family'}}],edges:graph.edges.map(e=>({id:e.id,source:motif.memberIds.includes(e.source)?motif.id:e.source,target:motif.memberIds.includes(e.target)?motif.id:e.target,data:{semanticEdge:e,supportTraces:e.supportTraces},style:{}}))};
const folded=project(rendered,graph,traces,()=>{},'semantic','r2',DEFAULT_RUN_RESULT);
assert.equal(folded.edges.length,2);
assert.equal(folded.nodes.find(n=>n.id===motif.id).style.opacity,1,'Run highlighting uses all stage variants');
assert(folded.edges.every(e=>e.data.supportTraces.length===2));
assert.deepEqual(folded.edges.flatMap(e=>e.data.memberEdges.map(m=>m.id)).sort(),graph.edges.map(e=>e.id).sort());
assert.equal(JSON.stringify(graph),before,'Bundling retains the canonical graph and original witness objects');
console.log('Stage grouping, outcome/error separation, hidden-step counts and original connection witnesses passed');

// First framing must use completed display geometry, even before React Flow measures its nodes.
const fitCode=ts.transpileModule(source.slice(source.indexOf('function InitialFit('),source.indexOf('function WorkflowEdge(')),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const {getViewportForBounds}=require('@xyflow/react');
let fittedViewport; let fitWidth=1000;
const initialFit=new Function('useStore','useReactFlow','useRef','useEffect','getViewportForBounds','WORKFLOW_FIT_PADDING',`${fitCode};return InitialFit;`)(select=>select({width:fitWidth,height:480}),()=>({setViewport:value=>{fittedViewport=value;}}),value=>({current:value}),effect=>effect(),getViewportForBounds,0.14);
const workspace={};
initialFit({workspace,ready:true,revision:0,boxes:[{id:'left',x:40,y:20,width:208,height:76},{id:'right',x:800,y:180,width:208,height:76}]});
assert.deepEqual(fittedViewport,getViewportForBounds({x:40,y:20,width:968,height:236},1000,480,0.2,1.2,0.14));
assert.equal(workspace.viewport,fittedViewport);
console.log('Initial framing uses final projected bounds rather than stale node measurements');

fitWidth=480;
initialFit({workspace:{},ready:true,revision:0,boxes:[{id:'left',x:40,y:20,width:208,height:76},{id:'right',x:800,y:180,width:208,height:76}]});
assert(fittedViewport.zoom<0.8,'The overview fits the entire graph; detail can be enlarged separately');
assert(fittedViewport.x+40*fittedViewport.zoom>=0,'The earliest calls remain within the fitted overview');

assert.equal(humanToolTitle('service_a__authenticate',['service_a__authenticate','service_b__authenticate']),'service_a.authenticate');
assert.equal(humanToolTitle('service_a__lookup',['service_a__lookup']),'lookup');
