import type { JoinedProvenanceGraph, JoinedProvenanceNode } from './types';

export type ImportanceAxis = 'outcome' | 'evidence' | 'semantic';

export function importanceValue(family: JoinedProvenanceNode, axis: ImportanceAxis, tool?: string): number | null {
  if (axis === 'semantic') return family.importance.semantic.level === 'unknown' ? null : family.importance.semantic.level === 'key' ? 1 : 0;
  if (axis === 'evidence') return new Set([
    ...family.importance.result.supportedClaims, ...family.importance.result.contradictedClaims,
  ]).size;
  const values = family.importance.outcome.globalTools.filter((entry) => !tool || entry.tool === tool).map((entry) => entry.importance);
  if (!tool) values.push(...(family.importance.outcome.patterns ?? []).map((entry) => entry.importance));
  return values.length ? Math.max(...values) : null;
}

export function importanceMaximum(graph: JoinedProvenanceGraph, axis: ImportanceAxis) {
  return Math.max(0, ...graph.nodes.map((node) => importanceValue(node, axis) ?? 0));
}

export function importanceBackground(value: number | null, maximum: number) {
  if (value === null) return '#ffffff';
  const fraction = maximum ? Math.min(1, value / maximum) : 0;
  // Opaque pale blue avoids stacking transparency across grouped and child cards.
  const alpha = 0.035 + fraction * 0.21;
  return `rgb(${[37, 99, 235].map((channel) => Math.round(255 + (channel - 255) * alpha)).join(' ')})`;
}

export function importanceGradient(maximum: number) {
  const stops = Array.from({ length: 9 }, (_, index) => {
    const fraction = index / 8;
    return `${importanceBackground(fraction * maximum, maximum)} ${fraction * 100}%`;
  });
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
