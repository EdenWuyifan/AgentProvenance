import type { Tracing } from './types';

export type RunResultConfig={mode:'auto'|'score'|'outcome'|'threshold';metric:string;threshold:number;direction:'atLeast'|'atMost'};
export const DEFAULT_RUN_RESULT:RunResultConfig={mode:'auto',metric:'score',threshold:1,direction:'atLeast'};
export type RunResult={kind:'success'|'failure'|'score'|'unknown';label:string;detail:string;value:number|null};
const numeric=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'&&value.trim()&&Number.isFinite(Number(value))?Number(value):null;
export function resultMetrics(traces:Tracing[]){
  return [...new Set(['score',...traces.flatMap(trace=>Object.keys(trace).filter(key=>key!=='id'&&numeric(trace[key])!==null))])];
}
export function runResult(trace:Tracing|undefined,config:RunResultConfig):RunResult {
  const status=(trace?.trainingOutcome as {status?:string}|undefined)?.status;
  if(config.mode==='outcome'||config.mode==='auto'&&(status==='success'||status==='failure'))return status==='success'||status==='failure'
    ?{kind:status,label:status==='success'?'Passed':'Failed',detail:'Recorded run outcome; not the status of this individual tool',value:null}
    :{kind:'unknown',label:'Unknown',detail:'No recorded run outcome',value:null};
  const value=numeric(trace?.[config.metric]);
  if(value===null)return {kind:'unknown',label:'Unknown',detail:`No ${config.metric} value`,value:null};
  if(config.mode==='threshold'){
    const passed=config.direction==='atLeast'?value>=config.threshold:value<=config.threshold;
    return {kind:passed?'success':'failure',label:passed?'Meets rule':'Outside rule',detail:`User rule: ${config.metric} ${config.direction==='atLeast'?'≥':'≤'} ${config.threshold}; actual value ${value}`,value};
  }
  return {kind:'score',label:`${config.metric} ${Number(value.toPrecision(4))}`,detail:`Original ${config.metric}; no success/failure classification`,value};
}
export function summarizeRunResults(ids:string[],traces:Tracing[],config:RunResultConfig){
  const results=[...new Set(ids)].map(id=>runResult(traces.find(trace=>String(trace.id)===id)!,config));
  const success=results.filter(result=>result.kind==='success').length,failure=results.filter(result=>result.kind==='failure').length;
  const values=results.filter(result=>result.kind==='score').map(result=>result.value!);
  const pieces=[success?`${success} ${config.mode==='threshold'?'meet rule':'passed'}`:'',failure?`${failure} ${config.mode==='threshold'?'outside rule':'failed'}`:'',values.length?`${config.metric} ${Number(Math.min(...values).toPrecision(3))}${Math.min(...values)!==Math.max(...values)?`–${Number(Math.max(...values).toPrecision(3))}`:''}`:'',results.some(result=>result.kind==='unknown')?'unknown':''].filter(Boolean);
  return {label:pieces.join(' · ')||'Unknown',kind:success>0&&success===results.length?'success':failure>0&&failure===results.length?'failure':'score',success,failure};
}
