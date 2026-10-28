'use client';
import type { Tracing } from './types';
import { resultMetrics, type RunResultConfig } from './run_result';

export function RunResultControls({traces,value,onChange}:{traces:Tracing[];value:RunResultConfig;onChange:(value:RunResultConfig)=>void}){
  return <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
    <label>Run labels <select aria-label="Run result display" className="rounded border border-slate-200 bg-white px-1 py-1" value={value.mode} onChange={event=>onChange({...value,mode:event.target.value as RunResultConfig['mode']})}><option value="auto">Source default</option><option value="score">Numeric value</option><option value="outcome">Recorded outcome</option><option value="threshold">My score rule</option></select></label>
    {value.mode==='score'||value.mode==='threshold'?<label>Metric <select aria-label="Run result metric" className="rounded border border-slate-200 bg-white px-1 py-1" value={value.metric} onChange={event=>onChange({...value,metric:event.target.value})}>{resultMetrics(traces).map(metric=><option key={metric}>{metric}</option>)}</select></label>:null}
    {value.mode==='threshold'?<><select aria-label="Run result rule direction" className="rounded border border-slate-200 bg-white px-1 py-1" value={value.direction} onChange={event=>onChange({...value,direction:event.target.value as RunResultConfig['direction']})}><option value="atLeast">≥</option><option value="atMost">≤</option></select><input aria-label="Run result threshold" type="number" step="any" className="w-16 rounded border border-slate-200 px-1 py-1" value={value.threshold} onChange={event=>onChange({...value,threshold:Number(event.target.value)})}/><span className="text-slate-400">Display rule; original scores stay unchanged.</span></>:null}
  </div>;
}
