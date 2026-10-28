import type { AgentDag, JoinedProvenanceNode, ProvEdge } from './types';
import { connectionPorts } from './graph_ports.ts';

export type ProvClusterMember = { run: string; node: string };
export type ProvClusterNode = {
  id: string; kind: 'Activity' | 'Entity'; label: string;
  members: ProvClusterMember[]; failed?: boolean; aligned?: boolean;
  entityType?: string; variants?: ProvClusterNode[];
};
export type ProvClusterEdge = {
  source: string; target: string; relation: ProvEdge['relation']; inferred: boolean;
  members: Array<{ run: string; edge: ProvEdge }>;
};
export type ProvCluster = {
  nodes: ProvClusterNode[]; edges: ProvClusterEdge[];
  rawNodeCount: number; rawActivityCount: number; rawEntityCount: number;
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? String(value);
};
const hasPayload = (value: unknown) => value !== undefined && value !== null && value !== ''
  && (typeof value !== 'object' || Object.keys(value).length > 0);

/** Display aligned operations; entity equality additionally requires exact content and producer lineage. */
export function buildProvCluster(families: JoinedProvenanceNode[], traceDags: Record<string, AgentDag>, includeSupporting = false): ProvCluster {
  const calls = new Map<string, Set<string>>();
  const alignment = new Map<string, { key: string; failed: boolean }>();
  for (const family of families) {
    for (const operation of family.operationGroups) for (const member of operation.members)
      alignment.set(`${member.run}\0${member.callId}`, {key:operation.tool, failed:operation.failure});
    for (const instance of family.instances) {
      const ids = calls.get(instance.run) ?? new Set<string>();
      instance.calls.forEach(call => ids.add(call.id));
      if (includeSupporting) instance.internalCalls.forEach(id => ids.add(id));
      if (instance.source?.callId) ids.add(instance.source.callId);
      calls.set(instance.run, ids);
    }
  }
  // Interned signatures retain exact equality without recursively copying long ancestor payloads.
  const signatures = new Map<string, string>();
  const intern = (value: unknown) => {const key=canonical(value);if(!signatures.has(key))signatures.set(key,`s${signatures.size}`);return signatures.get(key)!;};
  const groups = new Map<string, ProvClusterNode>();
  const mapping = new Map<string, string>();
  let rawActivityCount=0, rawEntityCount=0;
  for (const [run, selected] of calls) {
    const dag=traceDags[run];
    if (!dag) continue;
    const byId=new Map(dag.nodes.map(node=>[node.id,node]));
    const producers=new Map(dag.edges.filter(edge=>edge.relation==='generatedBy').map(edge=>[edge.target,edge.source]));
    const parents=new Map<string,string[]>(),ancestorCache=new Map<string,Set<string>>();
    for(const edge of dag.edges)if(edge.relation==='usedBy'&&producers.has(edge.source)){
      const items=parents.get(edge.target)??[];items.push(producers.get(edge.source)!);parents.set(edge.target,items);
    }
    const precedes=(a:string,b:string)=>{
      if(!ancestorCache.has(b)){
        const found=new Set<string>(),pending=[...parents.get(b)??[]];
        while(pending.length){const parent=pending.pop()!;if(found.has(parent))continue;found.add(parent);pending.push(...parents.get(parent)??[]);}
        ancestorCache.set(b,found);
      }
      return ancestorCache.get(b)!.has(a);
    };
    const exact=new Map<string,string>();
    for (const node of dag.nodes) if (node.kind==='Entity'&&!producers.has(node.id))
      exact.set(node.id,hasPayload(node.response)?intern(['input',node.entityType,node.response]):`unknown:${run}:${node.id}`);
    const rawOrder=[...dag.nodes].filter(node=>node.kind==='Activity').sort((a,b)=>a.timeIndex-b.timeIndex||a.id.localeCompare(b.id));
    const occurrences=new Map<string,number>();
    for(const activity of rawOrder){
      const inputs=dag.edges.filter(edge=>edge.target===activity.id&&edge.relation==='usedBy')
        .map(edge=>[exact.get(edge.source)??`unknown:${run}:${edge.source}`,Boolean(edge.inferred)]).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
      const outputs=dag.edges.filter(edge=>edge.source===activity.id&&edge.relation==='generatedBy').map(edge=>{
        const entity=byId.get(edge.target)!;return entity.kind==='Entity'&&hasPayload(entity.response)?[entity.entityType,entity.response]:`unknown:${run}:${edge.target}`;
      }).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
      const base=intern(['call',activity.tool,activity.args,activity.status??null,inputs,outputs]);
      const ordinal=occurrences.get(base)??0;occurrences.set(base,ordinal+1);
      const signature=intern([base,ordinal]);exact.set(activity.id,signature);
      for(const edge of dag.edges.filter(edge=>edge.source===activity.id&&edge.relation==='generatedBy')){
        const entity=byId.get(edge.target)!;
        exact.set(entity.id,entity.kind==='Entity'&&hasPayload(entity.response)?intern(['output',entity.entityType,entity.response,signature]):`unknown:${run}:${entity.id}`);
      }
    }
    const activities=rawOrder.filter(node=>selected.has(node.toolCallId));
    const selectedIds=new Set(activities.map(node=>node.id));
    const entityIds=new Set(dag.edges.filter(edge=>selectedIds.has(edge.source)||selectedIds.has(edge.target)).flatMap(edge=>[edge.source,edge.target]));
    const entities=dag.nodes.filter(node=>node.kind==='Entity'&&entityIds.has(node.id));
    const alignedOccurrences=new Map<string,string[][]>(),entityOccurrences=new Map<string,number>();
    for(const node of [...activities,...entities]){
      const aligned=node.kind==='Activity'?alignment.get(`${run}\0${node.toolCallId}`):undefined;
      const failed=node.kind==='Activity'&&(Boolean(aligned?.failed)||/^(error|failed|failure|fail)$/i.test(node.status??''));
      let key=exact.get(node.id)??`unknown:${run}:${node.id}`;
      if(aligned){
        const base=intern(['aligned',aligned.key,node.kind==='Activity'?node.tool:'',failed]);
        const buckets=alignedOccurrences.get(base)??[];
        let ordinal=buckets.findIndex(bucket=>bucket.every(id=>!precedes(id,node.id)&&!precedes(node.id,id)));
        if(ordinal<0){ordinal=buckets.length;buckets.push([]);}
        buckets[ordinal].push(node.id);alignedOccurrences.set(base,buckets);key=intern([base,ordinal]);
      }
      if(node.kind==='Entity'){const ordinal=entityOccurrences.get(key)??0;entityOccurrences.set(key,ordinal+1);key=intern([key,ordinal]);}
      const groupKey=`${node.kind}:${key}`;
      if(!groups.has(groupKey)){
        const producer=byId.get(producers.get(node.id)??'');
        const label=node.kind==='Activity'?node.tool:producer?.kind==='Activity'?`${producer.tool} output`:node.entityType;
        groups.set(groupKey,{id:`prov-${groups.size}`,kind:node.kind,label,members:[],failed,aligned:Boolean(aligned),entityType:node.kind==='Entity'?node.entityType:undefined});
      }
      const group=groups.get(groupKey)!;group.members.push({run,node:node.id});mapping.set(`${run}\0${node.id}`,group.id);
      if(node.kind==='Activity')rawActivityCount++;else rawEntityCount++;
    }
  }
  const edges=new Map<string,ProvClusterEdge>();
  for(const run of calls.keys())for(const edge of traceDags[run]?.edges??[]){
    const source=mapping.get(`${run}\0${edge.source}`),target=mapping.get(`${run}\0${edge.target}`);
    if(!source||!target)continue;
    const inferred=Boolean(edge.inferred),key=canonical([source,target,edge.relation,inferred]);
    if(!edges.has(key))edges.set(key,{source,target,relation:edge.relation,inferred,members:[]});
    edges.get(key)!.members.push({run,edge});
  }
  return {nodes:[...groups.values()],edges:[...edges.values()],rawActivityCount,rawEntityCount,rawNodeCount:rawActivityCount+rawEntityCount};
}

/** Fold data variants with the same origin role and directed activity neighborhood. No identity claim. */
export function groupProvEntities(cluster: ProvCluster, expanded = new Set<string>()): ProvCluster {
  const candidates=new Map<string,ProvClusterNode[]>();
  for(const node of cluster.nodes)if(node.kind==='Entity'){
    const neighborhood=cluster.edges.filter(edge=>edge.source===node.id||edge.target===node.id)
      .map(edge=>[edge.source===node.id?'out':'in',edge.relation,edge.source===node.id?edge.target:edge.source]);
    const key=canonical([node.entityType,node.label,[...new Set(neighborhood.map(canonical))].sort()]);
    const bucket=candidates.get(key)??[];bucket.push(node);candidates.set(key,bucket);
  }
  const replacements=new Map<string,ProvClusterNode>();
  for(const variants of candidates.values())if(variants.length>1){
    const id=`entities:${variants.map(node=>node.id).sort().join('|')}`;
    if(expanded.has(id))continue;
    const group={...variants[0],id,variants,members:variants.flatMap(node=>node.members)};
    for(const node of variants)replacements.set(node.id,group);
  }
  const nodes=[...new Map(cluster.nodes.map(node=>{const display=replacements.get(node.id)??node;return [display.id,display] as const;})).values()];
  const edges=new Map<string,ProvClusterEdge>();
  for(const edge of cluster.edges){
    const source=replacements.get(edge.source)?.id??edge.source,target=replacements.get(edge.target)?.id??edge.target;
    const key=canonical([source,target,edge.relation,edge.inferred]);
    if(!edges.has(key))edges.set(key,{...edge,source,target,members:[]});
    edges.get(key)!.members.push(...edge.members);
  }
  return {...cluster,nodes,edges:[...edges.values()]};
}

export function layoutProvCluster(cluster: ProvCluster) {
  const incoming=new Map(cluster.nodes.map(node=>[node.id,0]));
  const outgoing=new Map(cluster.nodes.map(node=>[node.id,new Set<string>()]));
  for(const edge of cluster.edges) if(!outgoing.get(edge.source)!.has(edge.target)){
    outgoing.get(edge.source)!.add(edge.target);incoming.set(edge.target,incoming.get(edge.target)!+1);
  }
  const queue=cluster.nodes.filter(node=>incoming.get(node.id)===0).map(node=>node.id);
  const levels=new Map(queue.map(id=>[id,0]));
  for(let index=0;index<queue.length;index++)for(const target of outgoing.get(queue[index])!){
    levels.set(target,Math.max(levels.get(target)??0,levels.get(queue[index])!+1));
    incoming.set(target,incoming.get(target)!-1);if(incoming.get(target)===0)queue.push(target);
  }
  for(const node of cluster.nodes)if(!levels.has(node.id))levels.set(node.id,Math.max(0,...levels.values())+1);
  const columns=new Map<number,string[]>();
  for(const node of cluster.nodes){const level=levels.get(node.id)!,ids=columns.get(level)??[];ids.push(node.id);columns.set(level,ids);}
  const layerIds=[...columns.keys()].sort((a,b)=>a-b);
  // Barycenter sweeps reorder within a layer; the dependency structure remains unchanged.
  for(let sweep=0;sweep<4;sweep++)for(const level of sweep%2?[...layerIds].reverse():layerIds){
    const ranks=new Map([...columns.values()].flatMap(ids=>ids.map((id,index)=>[id,index] as const)));
    const score=(id:string)=>{const peers=cluster.edges.filter(edge=>sweep%2?edge.source===id:edge.target===id).map(edge=>ranks.get(sweep%2?edge.target:edge.source)!);return peers.length?peers.reduce((sum,value)=>sum+value,0)/peers.length:ranks.get(id)!;};
    columns.get(level)!.sort((a,b)=>score(a)-score(b)||ranks.get(a)!-ranks.get(b)!);
  }
  const widths=new Map<number,number>();
  for(const node of cluster.nodes){const level=levels.get(node.id)!;widths.set(level,Math.max(widths.get(level)??0,node.kind==='Activity'?196:132));}
  const offsets=new Map<number,number>();let width=24;
  for(const level of layerIds){offsets.set(level,width);width+=widths.get(level)!+80;}
  const positions=new Map<string,{x:number;y:number}>();
  for(const [level,ids] of columns)ids.forEach((id,row)=>positions.set(id,{x:offsets.get(level)!+widths.get(level)!/2,y:52+row*114}));
  const boxes=cluster.nodes.map(node=>{const p=positions.get(node.id)!;return {id:node.id,x:p.x-(node.kind==='Activity'?98:20),y:p.y-(node.kind==='Activity'?38:20),width:node.kind==='Activity'?196:40,height:node.kind==='Activity'?76:40,circle:node.kind==='Entity'};});
  const ports=connectionPorts(boxes,cluster.edges.map((edge,index)=>({...edge,id:String(index)})));
  const paths=cluster.edges.map((edge,index)=>{const p=ports.get(String(index))!,dx=Math.max(40,(p.target.x-p.source.x)*0.45);return {...p,path:`M${p.source.x},${p.source.y} C${p.source.x+dx},${p.source.y} ${p.target.x-dx},${p.target.y} ${p.target.x},${p.target.y}`};});
  return {positions,paths,width:Math.max(500,width-56),height:Math.max(180,40+Math.max(0,...[...columns.values()].map(ids=>ids.length))*114)};
}
