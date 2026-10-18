'use client';

import { importanceGradient, type ImportanceAxis } from './graph_importance';

export function GraphLegend({ axis, maximum, traceCount, onAxisChange, flowColor }: {
  axis: ImportanceAxis; maximum: number; traceCount: number;
  onAxisChange: (axis: ImportanceAxis) => void; flowColor: string;
}) {
  const label = axis === 'outcome' ? 'Score association' : axis === 'evidence' ? 'Result evidence' : 'Semantic role';
  const description = axis === 'outcome'
    ? `Mean absolute predictive Shapley; current-view maximum ${maximum.toFixed(3)} sigma. Magnitude does not indicate a positive effect.`
    : axis === 'evidence' ? `Linked claims or structured milestones; current-view maximum ${maximum}` : 'Supporting to key role';
  return <aside aria-label="Graph legend" tabIndex={0} className="group absolute left-3 top-3 z-20 w-44 rounded-xl border border-slate-200/70 bg-white/90 p-2.5 text-[10px] leading-tight text-slate-600 shadow-lg shadow-slate-900/5 opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100">
    <div className="flex items-center justify-between gap-2">
      <span className="font-semibold text-slate-700">Legend</span>
      <select aria-label="Color meaning" className="w-24 rounded-md border border-slate-200 bg-white px-1 py-0.5 text-[10px] outline-none focus:ring-2 focus:ring-blue-200" value={axis} onChange={(event) => onAxisChange(event.target.value as ImportanceAxis)}>
        <option value="outcome">O · Association</option><option value="evidence">R · Evidence</option><option value="semantic">S · Role</option>
      </select>
    </div>
    <div className="mt-1.5" title={description}>
      <div className="mb-1 hidden justify-between text-[9px] group-hover:flex group-focus-within:flex"><span>{label}</span><span className="text-slate-400">{axis === 'semantic' ? 'support → key' : 'low → high'}</span></div>
      <div aria-label={`${label} color scale, low to high`} role="img" className="h-2 rounded-full border border-blue-200/60" style={{ background: importanceGradient(maximum) }} />
      <div className="mt-1 hidden justify-between text-[8px] text-slate-400 group-hover:flex group-focus-within:flex"><span className="flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-sm border border-slate-200 bg-white" />No estimate</span><span>{axis === 'outcome' ? `${maximum.toFixed(3)}σ max` : axis === 'evidence' ? `${maximum} linked max` : ''}</span></div>
    </div>
    <div className="mt-2 hidden space-y-1.5 border-t border-slate-100 pt-2 group-hover:block group-focus-within:block">
      <div className="flex items-center gap-2" title="Thicker left borders and connections mean more supporting traces">
        <svg aria-hidden="true" viewBox="0 0 28 15" className="h-3.5 w-7 shrink-0">{[1.5, 3, 5, 7].map((width, index) => <path key={index} d={`M${2 + index * 7} 14V${11 - index * 3}`} stroke="#64748b" strokeLinecap="round" strokeWidth={width} />)}</svg>
        <span>Trace support</span><span className="ml-auto text-[9px] text-slate-400">{traceCount > 1 ? `1 → ${traceCount}` : '1 trace'}</span>
      </div>
      <div className="flex items-center gap-2" title="Result paths and shared connections touching key steps use right angles">
        <svg aria-hidden="true" viewBox="0 0 28 12" className="h-3 w-7 shrink-0"><path d="M1 10H12V3H24M20 0l4 3-4 3" fill="none" stroke={flowColor} strokeWidth="2" /></svg><span>Key flow</span>
      </div>
      <div className="flex items-center gap-2" title="Ordinary connections use curves">
        <svg aria-hidden="true" viewBox="0 0 28 12" className="h-3 w-7 shrink-0"><path d="M1 10C8 10 7 2 14 2s6 8 13 8" fill="none" stroke="#94a3b8" strokeWidth="1.5" /></svg><span>Connection</span>
      </div>
      <div className="flex items-center justify-between pt-0.5 text-[9px] text-slate-500">
        <span className="flex items-center gap-1.5" title="Dashes mark inferred links, independently of color"><svg aria-hidden="true" viewBox="0 0 18 4" className="h-1 w-[18px]"><path d="M0 2H18" stroke="#94a3b8" strokeWidth="1.4" strokeDasharray="3 2" /></svg>Inferred</span>
        <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm border border-red-300 bg-red-50" />Failure</span>
      </div>
    </div>
  </aside>;
}
