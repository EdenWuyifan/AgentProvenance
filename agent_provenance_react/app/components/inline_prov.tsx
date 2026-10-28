'use client';

import { useId, useMemo, useState } from 'react';
import type { AgentDag, Tracing } from './types';
import { groupProvEntities, layoutProvCluster, type ProvCluster, type ProvClusterNode, type ProvClusterEdge } from './prov_cluster';
import { runResult, summarizeRunResults, type RunResultConfig } from './run_result';

type Props={cluster:ProvCluster;traceDags:Record<string,AgentDag>;traces:Tracing[];resultConfig:RunResultConfig;highlightRun?:string};
const clipped=(value:string,length:number)=>value.length>length?value.slice(0,length-1)+'…':value;
const color=(kind:string)=>kind==='success'?'#16734b':kind==='failure'?'#b53748':'#61718a';
const badge=(kind:string)=>kind==='success'?'border-emerald-200 bg-emerald-50 text-emerald-800':kind==='failure'?'border-rose-200 bg-rose-50 text-rose-800':'border-slate-200 bg-slate-50 text-slate-600';

export function InlineProv({cluster,traceDags,traces,resultConfig,highlightRun}:Props){
  const marker=useId().replace(/:/g,'');
  const [run,setRun]=useState<string|null>(null);
  const [selected,setSelected]=useState<ProvClusterNode|ProvClusterEdge|null>(null);
  const [expanded,setExpanded]=useState(new Set<string>());
  const [hover,setHover]=useState<{node?:string;edge?:number}|null>(null);
  const activeRun=run??highlightRun??'';
  const runs=[...new Set(cluster.nodes.flatMap(node=>node.members.map(member=>member.run)))].sort((a,b)=>traces.findIndex(trace=>String(trace.id)===a)-traces.findIndex(trace=>String(trace.id)===b));
  const scoped=useMemo(()=>activeRun?{...cluster,nodes:cluster.nodes.filter(node=>node.members.some(member=>member.run===activeRun)).map(node=>({...node,members:node.members.filter(member=>member.run===activeRun)})),edges:cluster.edges.filter(edge=>edge.members.some(member=>member.run===activeRun)).map(edge=>({...edge,members:edge.members.filter(member=>member.run===activeRun)}))}:cluster,[cluster,activeRun]);
  const grouped=useMemo(()=>groupProvEntities(scoped),[scoped]);
  const visible=useMemo(()=>groupProvEntities(scoped,expanded),[scoped,expanded]);
  const geometry=useMemo(()=>layoutProvCluster(visible),[visible]);
  const entityGroups=grouped.nodes.filter(node=>node.variants);
  const anyExpanded=entityGroups.some(node=>expanded.has(node.id));
  const selectedNode=selected&&'kind' in selected?selected.id:undefined;
  const selectedEdge=selected&&!('kind' in selected)?visible.edges.indexOf(selected):undefined;
  const focus=hover??(selectedNode?{node:selectedNode}:selectedEdge!==undefined?{edge:selectedEdge}:null);
  const focusedEdges=new Set(visible.edges.flatMap((edge,index)=>focus&&(focus.edge===index||focus.node===edge.source||focus.node===edge.target)?[index]:[]));
  const focusedNodes=new Set([...focusedEdges].flatMap(index=>[visible.edges[index].source,visible.edges[index].target]));
  if(focus?.node)focusedNodes.add(focus.node);
  const chooseRun=(id:string)=>{setRun(id);setSelected(null);setHover(null);setExpanded(new Set());};
  const selectNode=(node:ProvClusterNode)=>{
    if(node.variants){setExpanded(current=>new Set([...current,node.id]));setSelected(null);setHover(null);}
    else setSelected(current=>current&&'kind' in current&&current.id===node.id?null:node);
  };
  const trace=(id:string)=>traces.find(trace=>String(trace.id)===id)!;
  const runName=(id:string)=>'R'+(traces.findIndex(trace=>String(trace.id)===id)+1);
  const records=selected?'kind' in selected?selected.members.filter(member=>!activeRun||member.run===activeRun).map(member=>({run:member.run,result:runResult(trace(member.run),resultConfig),record:traceDags[member.run].nodes.find(node=>node.id===member.node)})):selected.members.filter(member=>!activeRun||member.run===activeRun):[];
  return <div className="nodrag nopan nowheel flex min-h-0 flex-1 flex-col gap-2 p-3" onClick={event=>event.stopPropagation()} onMouseDown={event=>event.stopPropagation()}>
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
      <label>Run <select aria-label="Cluster run" className="rounded border border-slate-200 bg-white px-1 py-0.5" value={activeRun} onChange={event=>chooseRun(event.target.value)}><option value="">All runs</option>{runs.map(id=><option key={id} value={id}>{runName(id)+' · '+runResult(trace(id),resultConfig).label}</option>)}</select></label>
      <span><b className="rounded border border-blue-400 bg-blue-50 px-1 text-blue-800">A</b> Activity</span><span><b className="rounded-full border border-slate-400 bg-white px-1">E</b> Entity</span>
      {entityGroups.length?<button type="button" className="ml-auto rounded border border-slate-200 bg-white px-1.5 py-0.5 text-blue-700" onClick={()=>{setExpanded(anyExpanded?new Set():new Set(entityGroups.map(node=>node.id)));setSelected(null);setHover(null);}}>{anyExpanded?'Fold entity groups':'Expand entity groups'}</button>:null}
    </div>
    <div aria-label="Run results in this cluster" className="flex shrink-0 flex-wrap gap-1">
      <button type="button" className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-600" onClick={()=>chooseRun('')}>All</button>
      {runs.map(id=>{const result=runResult(trace(id),resultConfig);return <button type="button" key={id} aria-pressed={activeRun===id} title={result.detail} className={'rounded border px-1.5 py-0.5 text-[10px] '+badge(result.kind)+(activeRun===id?' ring-1 ring-blue-500':'')} onClick={()=>chooseRun(id)}>{runName(id)+' · '+result.label}</button>;})}
    </div>
    <div className="min-h-20 flex-1 overflow-auto rounded-lg border border-slate-200/80 bg-white/90">
      <svg width={geometry.width} height={geometry.height} className="block max-w-none" role="img" aria-label="Inline Activity–Entity provenance graph">
        <defs><marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L7,3.5 L0,7z" fill="#64748b"/></marker></defs>
        {visible.edges.map((edge,index)=>{
          const route=geometry.paths[index],included=!focus||focusedEdges.has(index);
          const source=visible.nodes.find(node=>node.id===edge.source)!,target=visible.nodes.find(node=>node.id===edge.target)!;
          const label=source.label+' → '+target.label+' · '+edge.relation+' · '+(edge.inferred?'inferred':'recorded');
          const stroke=1.5+Math.min(2,new Set(edge.members.map(member=>member.run)).size-1)*0.5;
          return <g key={index} role="button" tabIndex={0} aria-label={label} onMouseEnter={()=>setHover({edge:index})} onMouseLeave={()=>setHover(null)} onClick={()=>setSelected(edge)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setSelected(edge);}}} style={{opacity:included?1:0.08,cursor:'pointer'}}>
            <title>{label}</title><path d={route.path} fill="none" stroke="white" strokeWidth={stroke+4}/>
            <path d={route.path} fill="none" stroke={edge.inferred?'#5278c7':'#7c8fa9'} strokeWidth={stroke+(focus&&included?0.8:0)} strokeDasharray={edge.inferred?'5 4':undefined} markerEnd={'url(#'+marker+')'}/>
            <path d={route.path} fill="none" stroke="transparent" strokeWidth="12"/><circle cx={route.source.x} cy={route.source.y} r="2.5" fill="#7c8fa9" stroke="white"/>
          </g>;
        })}
        {visible.nodes.map(node=>{
          const point=geometry.positions.get(node.id)!,included=!focus||focusedNodes.has(node.id);
          const ids=[...new Set(node.members.map(member=>member.run))],count=ids.length;
          const result=summarizeRunResults(ids,traces,resultConfig);
          const outcome=ids.length===1?runName(ids[0])+' · '+runResult(trace(ids[0]),resultConfig).label:result.label;
          const active=selectedNode===node.id,badgeCount=node.variants?.length??count;
          const title=node.label+' · '+ids.map(id=>runName(id)+' '+runResult(trace(id),resultConfig).label).join('; ');
          return <g key={node.id} role="button" tabIndex={0} aria-label={(node.variants?'Entity group':node.kind)+': '+node.label+' · '+node.members.length+' records · '+count+' runs'} transform={'translate('+point.x+','+point.y+')'} onMouseEnter={()=>setHover({node:node.id})} onMouseLeave={()=>setHover(null)} onClick={()=>selectNode(node)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectNode(node);}}} style={{opacity:included?1:0.2,cursor:'pointer'}}>
            <title>{title+(node.variants?' · Click to expand data variants':'')}</title>
            {node.kind==='Activity'?<>
              <rect x="-98" y="-38" width="196" height="76" rx="8" fill={node.failed?'#fff1f2':active?'#dbeafe':'#eff4ff'} stroke={node.failed?'#dc2626':active?'#2563eb':'#9bb0d7'}/>
              <text x="-84" y="-13" fontSize="10" fontWeight="600" fill={node.failed?'#b91c1c':'#4c6594'}>A</text><text x="-68" y="-13" fontSize="12" fontWeight="600" fill="#243753">{clipped(node.label.replaceAll('__','.'),19)}</text>
              <text x="-68" y="5" fontSize="10" fill="#64748b">{node.members.length+' calls · '+count+' runs'}</text><text x="-68" y="23" fontSize="10" fill={color(result.kind)}>{clipped(outcome,29)}</text>
            </>:<>
              {node.variants?<circle cx="5" cy="4" r="20" fill="#f1f5fc" stroke="#b8c8e2"/>:null}<circle r="20" fill={active?'#e0eaff':node.variants?'#edf3ff':'#f8fafc'} stroke={active?'#2563eb':'#97a8c0'}/><text y="4" textAnchor="middle" fontSize="12" fill="#465a78">E</text>
              {badgeCount>1?<><circle cx="17" cy="-15" r="9" fill="#dce8ff"/><text x="17" y="-12" textAnchor="middle" fontSize="9" fill="#315ba4">{badgeCount}</text></>:null}<text y="37" textAnchor="middle" fontSize="10" fill="#64748b">{clipped(node.label.replaceAll('__','.'),23)}</text>
              {node.variants?<text y="51" textAnchor="middle" fontSize="9" fill="#8a98ad">{node.variants.length+' variants · expand +'}</text>:null}<text y={node.variants?66:53} textAnchor="middle" fontSize="10" fill={color(result.kind)}>{clipped(outcome,26)}</text>
            </>}
          </g>;
        })}
      </svg>
    </div>
    {selected?<div className="shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px]"><div className="flex items-center justify-between text-slate-600"><strong>{'kind' in selected?selected.kind+' · original records':selected.relation+' · original witnesses'}</strong><button type="button" className="text-slate-400" onClick={()=>setSelected(null)}>Close records</button></div><pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words text-slate-500">{JSON.stringify(records,null,2)}</pre></div>:null}
  </div>;
}
