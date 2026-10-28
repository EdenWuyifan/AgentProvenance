import type { ActivityNode, AgentDag, JoinedProvenanceGraph, JoinedProvenanceNode, JoinedProvenanceEdge } from './types';
import { toolErrored } from './graph_stages.ts';

/** Display-only partition of mixed preparation groups by fully qualified operation. */
export function projectToolStages(source: JoinedProvenanceGraph, dags: Record<string, AgentDag>, enabled=true) {
  const nodeOrigins=new Map<string,string>(),edgeOrigins=new Map<string,string>();
  const slices=new Map<string,Map<string,string>>();
  const key=(run:string,call:string)=>`${run}\0${call}`;
  const rawTools=new Map(Object.entries(dags).flatMap(([run,dag])=>dag.nodes.flatMap(node=>node.kind==='Activity'?[[key(run,node.toolCallId),node.tool] as const]:[])));
  for(const family of source.nodes){
    if(!enabled||source.workflow||family.source||family.methods.length<2)continue;
    const owners=new Map<string,string>();
    for(const instance of family.instances){
      instance.calls.forEach(call=>owners.set(key(instance.run,call.id),call.tool));
      instance.internalCalls.forEach(id=>{if(rawTools.has(key(instance.run,id)))owners.set(key(instance.run,id),rawTools.get(key(instance.run,id))!);});
    }
    // An opaque endpoint cannot be assigned to a tool without inventing evidence.
    const resolvable=source.edges.filter(edge=>edge.source===family.id||edge.target===family.id).every(edge=>edge.witnesses.length>0&&edge.witnesses.every(witness=>
      witness.callPath.some(id=>owners.has(key(witness.run,id)))));
    if(resolvable)slices.set(family.id,owners);
  }
  const part=(familyId:string,tool:string)=>`${familyId}:tool:${encodeURIComponent(tool)}`;
  const nodes=source.nodes.flatMap(family=>{
    const owners=slices.get(family.id);
    if(!owners){nodeOrigins.set(family.id,family.id);return [family];}
    return family.methods.map(tool=>{
      const id=part(family.id,tool);nodeOrigins.set(id,family.id);
      const instances=family.instances.flatMap(instance=>{
        const calls=instance.calls.filter(call=>call.tool===tool);
        const internalCalls=instance.internalCalls.filter(call=>owners.get(key(instance.run,call))===tool);
        if(!calls.length&&!internalCalls.length)return [];
        const ids=new Set([...calls.map(call=>call.id),...internalCalls]);
        return [{...instance,calls,internalCalls,internalFlow:instance.internalFlow.filter(edge=>ids.has(edge.source)&&ids.has(edge.target)),resultTargets:instance.resultTargets.filter(call=>ids.has(call))}];
      });
      const supportTraces=[...new Set(instances.map(instance=>instance.run))];
      return {...family,id,displayOrigin:family.id,methods:[tool],instances,supportTraces,supportCount:supportTraces.length,
        operationGroups:family.operationGroups.filter(operation=>operation.tool===tool)};
    });
  });
  const endpoint=(id:string,run:string,path:string[],last:boolean)=>{
    const owners=slices.get(id);if(!owners)return id;
    const call=(last?[...path].reverse():path).find(call=>owners.has(key(run,call)))!;
    return part(id,owners.get(key(run,call))!);
  };
  const edges:JoinedProvenanceEdge[]=[];
  for(const edge of source.edges){
    if(!slices.has(edge.source)&&!slices.has(edge.target)){edges.push(edge);edgeOrigins.set(edge.id,edge.id);continue;}
    const buckets=new Map<string,JoinedProvenanceEdge>();
    for(const witness of edge.witnesses){
      const from=endpoint(edge.source,witness.run,witness.callPath,true),to=endpoint(edge.target,witness.run,witness.callPath,false);
      const id=`${edge.id}:tools:${from}|${to}`;
      if(!buckets.has(id))buckets.set(id,{...edge,id,source:from,target:to,witnesses:[]});
      buckets.get(id)!.witnesses.push(witness);
    }
    for(const bucket of buckets.values()){
      bucket.supportTraces=[...new Set(bucket.witnesses.map(witness=>witness.run))];bucket.supportCount=bucket.supportTraces.length;
      bucket.inferred=bucket.witnesses.every(witness=>witness.inferred);edges.push(bucket);edgeOrigins.set(bucket.id,edge.id);
    }
  }
  const recovered=new Set<string>();
  if(enabled&&!source.workflow){
    const present=new Set(nodes.flatMap(node=>node.instances.flatMap(instance=>instance.calls.map(call=>key(instance.run,call.id)))));
    const rawNodes=new Map(Object.entries(dags).flatMap(([run,dag])=>dag.nodes.flatMap(node=>node.kind==='Activity'?[[key(run,node.toolCallId),node] as const]:[])));
    const omitted=new Map<string,typeof source.omittedCalls>();
    for(const call of source.omittedCalls)if(rawNodes.has(key(call.run,call.id))&&!present.has(key(call.run,call.id))){
      const group=omitted.get(call.tool)??[];group.push(call);omitted.set(call.tool,group);
    }
    for(const [tool,calls] of omitted){
      const id=`source-calls:${encodeURIComponent(tool)}`,operations=new Map<boolean,JoinedProvenanceNode['operationGroups'][number]>();
      const byRun=new Map<string,typeof calls>();
      for(const call of calls){
        const activity=rawNodes.get(key(call.run,call.id))!;recovered.add(key(call.run,call.id));
        const runCalls=byRun.get(call.run)??[];runCalls.push(call);byRun.set(call.run,runCalls);
        const failed=toolErrored({status:activity.status??undefined} as Parameters<typeof toolErrored>[0])||dags[call.run].edges.filter(edge=>edge.source===activity.id&&edge.relation==='generatedBy').some(edge=>{
          const output=dags[call.run].nodes.find(node=>node.id===edge.target)!;return output.kind==='Entity'&&toolErrored({response:output.response} as Parameters<typeof toolErrored>[0]);
        });
        if(!operations.has(failed))operations.set(failed,{id:`${id}:${failed}`,tool,failure:failed,supportTraces:[],members:[],parameterVariants:[]});
        const operation=operations.get(failed)!;
        operation.members.push({run:call.run,callId:call.id,step:call.step,inputEntityIds:dags[call.run].edges.filter(edge=>edge.target===activity.id&&edge.relation==='usedBy').map(edge=>edge.source),outputEntityIds:dags[call.run].edges.filter(edge=>edge.source===activity.id&&edge.relation==='generatedBy').map(edge=>edge.target)});
        operation.parameterVariants.push({parameters:activity.args as object,members:[{run:call.run,callId:call.id}]});
      }
      for(const operation of operations.values())operation.supportTraces=[...new Set(operation.members.map(member=>member.run))];
      const supportTraces=[...byRun.keys()];
      nodes.push({id,kind:'JoinedActivity',label:'Source supporting calls',semanticRole:'background',methods:[tool],supportTraces,supportCount:supportTraces.length,attention:'supporting',resultBackbone:false,displayRecovered:true,
        importance:{decision:'summarize',reasons:['Source calls omitted by the original overview; importance unassessed'],support:supportTraces.length,tier:'context',facets:[],semantic:{level:'unknown'},result:{status:'none',supportedClaims:[],contradictedClaims:[],onRecordedPath:false},outcome:{status:'unavailable',contributions:null,cohorts:[],globalTools:[]}},variants:[],operationGroups:[...operations.values()],
        instances:[...byRun].map(([run,items])=>({id:`${id}:${run}`,run,calls:items.map(call=>({id:call.id,tool,step:call.step})),internalCalls:items.map(call=>call.id),internalFlow:[],resultTargets:[],resultBackbone:false,background:true,attention:'supporting',targetEvidence:[]}))});
      nodeOrigins.set(id,id);
    }
    const owners=new Map<string,JoinedProvenanceNode>();
    for(const node of nodes)for(const instance of node.instances)for(const call of instance.calls)owners.set(key(instance.run,call.id),node);
    // Restore witnessed raw inputs, never sequential adjacency.
    const restored=new Map<string,JoinedProvenanceEdge>();
    for(const [run,dag] of Object.entries(dags)){
      const byId=new Map(dag.nodes.map(node=>[node.id,node]));
      const producers=new Map(dag.edges.filter(edge=>edge.relation==='generatedBy').map(edge=>[edge.target,edge]));
      for(const use of dag.edges.filter(edge=>edge.relation==='usedBy')){
        const generation=producers.get(use.source);if(!generation)continue;
        const a=byId.get(generation.source) as ActivityNode,b=byId.get(use.target) as ActivityNode;
        const from=owners.get(key(run,a.toolCallId)),to=owners.get(key(run,b.toolCallId));if(!from||!to||from.id===to.id)continue;
        const origin=nodeOrigins.get(from.id)!;
        const internal=slices.has(origin)&&origin===nodeOrigins.get(to.id);
        if(!internal&&!recovered.has(key(run,a.toolCallId))&&!recovered.has(key(run,b.toolCallId)))continue;
        const id=`source-input:${from.id}|${to.id}`;
        if(!restored.has(id))restored.set(id,{id,source:from.id,target:to.id,relation:'usedBy',supportTraces:[],supportCount:0,inferred:false,witnesses:[]});
        const instance=(node:JoinedProvenanceNode,call:string)=>node.instances.find(instance=>instance.run===run&&instance.calls.some(item=>item.id===call))!.id;
        restored.get(id)!.witnesses.push({run,sourceInstance:instance(from,a.toolCallId),targetInstance:instance(to,b.toolCallId),callPath:[a.toolCallId,b.toolCallId],inferred:Boolean(generation.inferred||use.inferred),highlighted:false,internalPath:[generation,use]});
      }
    }
    for(const edge of restored.values()){
      edge.supportTraces=[...new Set(edge.witnesses.map(witness=>witness.run))];edge.supportCount=edge.supportTraces.length;edge.inferred=edge.witnesses.every(witness=>witness.inferred);edges.push(edge);
    }
  }
  return {graph:slices.size||recovered.size?{...source,nodes,edges}:source,nodeOrigins,edgeOrigins,recoveredCalls:recovered.size};
}
