import type { JoinedProvenanceGraph } from './types';
import type { Box, GraphWorkspace, LayoutLink, Point } from './graph_layout';

export type StageTime = { order: number; firstStep: number; lastStep: number; support: number };

/** Equal weight per run; exact occurrence steps remain in the provenance inspector. */
export function stageChronology(graph: JoinedProvenanceGraph, groups: Array<{ id: string; memberIds: string[] }>) {
  const families = new Map(graph.nodes.map(node => [node.id, node]));
  const times = new Map<string, StageTime>();
  for (const group of groups) {
    const steps = new Map<string, number[]>();
    for (const id of group.memberIds) for (const instance of families.get(id)!.instances) {
      const values = steps.get(instance.run) ?? [];
      values.push(...instance.calls.map(call => call.step)); steps.set(instance.run, values);
    }
    const all = [...steps.values()].flat();
    const progress = [...steps.values()].filter(values => values.length).map(values => Math.min(...values)).sort((a, b) => a - b);
    const middle = Math.floor(progress.length / 2);
    times.set(group.id, { order: progress.length ? (progress[middle] + progress[Math.floor((progress.length - 1) / 2)]) / 2 : 0,
      firstStep: all.length ? Math.min(...all) : 0, lastStep: all.length ? Math.max(...all) : 0, support: steps.size });
  }
  return times;
}

/** Source order controls x; dependencies only align branches. No sequence edges are generated. */
export function layoutChronologicalGroups(boxes: Box[], links: LayoutLink[], times: Map<string, StageTime>, workspace: GraphWorkspace) {
  const ordered = [...boxes].sort((a, b) => times.get(a.id)!.order - times.get(b.id)!.order
    || times.get(a.id)!.firstStep - times.get(b.id)!.firstStep || a.id.localeCompare(b.id));
  const order = new Map(ordered.map((box, index) => [box.id, index]));
  const forward = links.filter(link => order.get(link.source)! < order.get(link.target)!);
  const parents = new Map(ordered.map(box => [box.id, forward.filter(link => link.target === box.id)]));
  const columns = new Map<string, number>();
  const paths = new Map<string, { score: number; ids: string[] }>();
  const bands = Math.min(6, Math.max(2, Math.ceil(Math.sqrt(boxes.length))));
  const firstStep = Math.min(...[...times.values()].map(time => time.order));
  const stepRange = Math.max(1, Math.max(...[...times.values()].map(time => time.order)) - firstStep);
  let lastColumn = 0;
  for (const box of ordered) {
    const incoming = parents.get(box.id)!;
    lastColumn = Math.max(lastColumn, Math.floor((times.get(box.id)!.order - firstStep) / stepRange * (bands - 1)),
      ...incoming.map(link => columns.get(link.source)! + 1));
    columns.set(box.id, lastColumn);
    const best = incoming.map(link => ({ score: paths.get(link.source)!.score + link.recordedSupport + 1,
      ids: paths.get(link.source)!.ids })).sort((a, b) => b.score - a.score || a.ids.join().localeCompare(b.ids.join()))[0];
    paths.set(box.id, { score: (best?.score ?? 0) + times.get(box.id)!.support,
      ids: [...best?.ids ?? [], box.id] });
  }
  const spine = new Set([...paths.values()].sort((a, b) => b.score - a.score || a.ids.join().localeCompare(b.ids.join()))[0]?.ids ?? []);
  const rows = new Map<string, number>();
  const used = new Map<number, Set<number>>();
  const connected = new Set(links.flatMap(link => [link.source, link.target]));
  for (const box of ordered.filter(box => spine.has(box.id))) {
    rows.set(box.id, 0); used.set(columns.get(box.id)!, new Set([0]));
  }
  for (const box of ordered.filter(box => !spine.has(box.id))) {
    const column = columns.get(box.id)!;
    const occupied = used.get(column) ?? new Set<number>();
    const previous = parents.get(box.id)!.map(link => rows.get(link.source)).filter((row): row is number => row !== undefined);
    const desired = previous.length ? previous.reduce((sum, row) => sum + row, 0) / previous.length : connected.has(box.id) ? 0 : 1;
    const candidates = Array.from({length: boxes.length * 2 + 1}, (_, index) => index - boxes.length)
      .filter(row => !occupied.has(row) && (connected.has(box.id) || row >= 1))
      .sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired) || Math.abs(a) - Math.abs(b) || a - b);
    rows.set(box.id, candidates[0]); occupied.add(candidates[0]); used.set(column, occupied);
  }
  const columnIds = [...new Set(columns.values())].sort((a, b) => a - b);
  const offsets = new Map<number, number>(); let x = 40;
  for (const column of columnIds) {
    offsets.set(column, x); x += Math.max(...ordered.filter(box => columns.get(box.id) === column).map(box => box.width)) + 112;
  }
  const rowIds=[...new Set(rows.values())].sort((a,b)=>a-b);
  const rowTops=new Map<number,number>(),rowHeights=new Map<number,number>();let y=32;
  for(const row of rowIds){const height=Math.max(...boxes.filter(box=>rows.get(box.id)===row).map(box=>box.height));rowTops.set(row,y);rowHeights.set(row,height);y+=height+48;}
  return new Map(ordered.map(box => [box.id, workspace.pinned.has(box.id) ? workspace.positions.get(box.id)! : {
    x: offsets.get(columns.get(box.id)!)!, y: rowTops.get(rows.get(box.id)!)!+(rowHeights.get(rows.get(box.id)!)!-box.height)/2,
  } as Point]));
}
