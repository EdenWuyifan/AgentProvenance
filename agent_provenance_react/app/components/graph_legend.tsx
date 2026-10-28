'use client';

import type { ReactNode } from 'react';
import { importanceGradient, type ImportanceAxis } from './graph_importance';

export function GraphLegend({ axis, maximum, traceCount, workflow, onAxisChange, flowColor, resultControls }: {
  axis: ImportanceAxis; maximum: number; traceCount: number; workflow: boolean;
  onAxisChange: (axis: ImportanceAxis) => void; flowColor: string; resultControls:ReactNode;
}) {
  const description = axis === 'outcome'
    ? `Predictive score association, maximum ${maximum.toFixed(3)} sigma. Association is not a causal effect.`
    : axis === 'evidence' ? `Linked result evidence, maximum ${maximum}.` : 'Reviewed semantic role. Unreviewed activities have no role estimate.';
  return <aside aria-label="Graph legend" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-500">
    <label className="flex items-center gap-2 font-medium text-slate-700">Color
      <select aria-label="Color meaning" className="rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px]" value={axis} onChange={event=>onAxisChange(event.target.value as ImportanceAxis)}>
        <option value="semantic">Semantic role</option><option value="evidence">Result evidence</option><option value="outcome">Score association</option>
      </select>
    </label>
    <span className="flex items-center gap-1.5" title={description}><i className="h-2.5 w-14 rounded" style={{background:axis==='semantic'?'linear-gradient(90deg,#fff,#c9d7ff)':importanceGradient(maximum)}}/>{axis==='semantic'?'Supporting → key':'Low → high'}</span>
    <span className="flex items-center gap-1.5" title={`Wider lines and left borders mean more supporting runs, up to ${traceCount}.`}><svg aria-hidden="true" viewBox="0 0 26 10" className="h-3 w-7"><path d="M1 7H11M15 7H25" stroke={flowColor} strokeWidth="2"/><path d="M15 7H25" stroke={flowColor} strokeWidth="5"/></svg>Shared runs</span>
    <span className="flex items-center gap-1.5"><i className="w-5 border-t-2 border-slate-500"/>Recorded<i className="ml-1 w-5 border-t-2 border-dashed border-blue-500"/>Inferred</span>
    <span className="flex items-center gap-1.5" title="A recorded tool error; different from the outcome of the whole run."><i className="h-3 w-3 rounded-sm border border-red-400 bg-red-50"/>Tool error</span>
    {!workflow ? resultControls : null}
  </aside>;
}
