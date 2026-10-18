import ELK from 'elkjs/lib/elk.bundled.js';
import type { GraphFilters } from './graph_search';
import type { GraphHighlight } from './graph_controls';
import type { JoinedProvenanceGraph } from './types';

export type Point = { x: number; y: number };
export type Box = Point & { id: string; width: number; height: number; parentId?: string };
export type LayoutLink = { id: string; source: string; target: string; priority: number };
export type GraphWorkspace = {
  sourceKey: string;
  positions: Map<string, Point>;
  sizes: Map<string, string>;
  pinned: Set<string>;
  expanded: Set<string>;
  viewport?: { x: number; y: number; zoom: number };
  filters?: GraphFilters;
  focus?: GraphHighlight;
  axis?: 'outcome' | 'evidence' | 'semantic';
};

export type WorkflowLane = { id: string; label: string; kind: 'agent' | 'role'; participantIds: string[] };
export type WorkflowNodeContext = { laneId: string; roundStart: number; roundEnd: number; phase?: string; eventOrder?: number };
export type WorkflowLayout = { lanes: WorkflowLane[]; roundRange: [number, number]; roundLabel: string };

export function workflowGeometry(boxes: Box[], workflow: WorkflowLayout, contexts: Map<string, WorkflowNodeContext>) {
  const roundStarts = [...new Set(boxes.map((box) => contexts.get(box.id)?.roundStart).filter((round): round is number => round !== undefined))].sort((a, b) => a - b);
  if (!roundStarts.length) roundStarts.push(workflow.roundRange[0]);
  const cells = new Map<string, Box[]>();
  boxes.forEach((box) => {
    const context = contexts.get(box.id);
    const round = context?.roundStart ?? workflow.roundRange[0];
    const lane = context?.laneId ?? '';
    const key = `${round}:${lane}`;
    const members = cells.get(key) ?? [];
    members.push(box);
    cells.set(key, members);
  });
  const roundWidths = new Map<number, number>();
  const roundOffsets = new Map<number, number>();
  const cellWidths = new Map<number, number>();
  cells.forEach((members, key) => {
    const round = Number(key.split(':', 1)[0]);
    cellWidths.set(round, Math.max(cellWidths.get(round) ?? 0, members.reduce((sum, box) => sum + box.width + 24, -24)));
  });
  let totalWidth = 0;
  for (const round of roundStarts) {
    roundOffsets.set(round, totalWidth);
    const width = Math.max(96, cellWidths.get(round) ?? 0);
    roundWidths.set(round, width);
    totalWidth += width + 32;
  }
  const laneHeight = Math.max(190, ...boxes.map((box) => box.height + 48));
  return { roundStarts, roundWidths, roundOffsets, totalWidth, laneHeight };
}

export function workflowSizeSignature(box: Box) {
  return `workflow:${box.width}:${box.height}:events-v3-compact`;
}

/** Slot workflow events horizontally within each actor/round cell. */
export function layoutWorkflowLanes(boxes: Box[], workflow: WorkflowLayout, contexts: Map<string, WorkflowNodeContext>, workspace: GraphWorkspace, reset = false) {
  const { roundStarts, roundOffsets, laneHeight } = workflowGeometry(boxes, workflow, contexts);
  const geometryChanged = !reset && (boxes.length !== workspace.sizes.size || boxes.some((box) => !workspace.sizes.has(box.id)
    || workspace.sizes.get(box.id) !== workflowSizeSignature(box)));
  const roundRank = new Map(roundStarts.map((round, index) => [round, index]));
  const laneIndex = new Map(workflow.lanes.map((lane, index) => [lane.id, index]));
  const cellWidths = new Map<string, number>();
  const positions = new Map<string, Point>();
  const ordered = [...boxes].sort((a, b) => (contexts.get(a.id)?.roundStart ?? 0) - (contexts.get(b.id)?.roundStart ?? 0)
    || (laneIndex.get(contexts.get(a.id)?.laneId ?? '') ?? workflow.lanes.length) - (laneIndex.get(contexts.get(b.id)?.laneId ?? '') ?? workflow.lanes.length)
    || (contexts.get(a.id)?.eventOrder ?? 0) - (contexts.get(b.id)?.eventOrder ?? 0)
    || a.id.localeCompare(b.id));
  for (const box of ordered) {
    const context = contexts.get(box.id);
    const lane = laneIndex.get(context?.laneId ?? '') ?? workflow.lanes.length;
    const round = context?.roundStart ?? workflow.roundRange[0];
    const cell = `${round}:${lane}`;
    const offset = cellWidths.get(cell) ?? 0;
    cellWidths.set(cell, offset + box.width + 24);
    const automatic = { x: 48 + (roundOffsets.get(round) ?? (roundRank.get(round) ?? 0) * 352) + offset, y: 56 + lane * laneHeight };
    const saved = !reset && workspace.positions.has(box.id) && (!geometryChanged || workspace.pinned.has(box.id)) ? workspace.positions.get(box.id) : undefined;
    const candidate = { ...box, ...(saved ?? automatic) };
    // Slot geometry guarantees separation for automatic positions. Manual positions stay exact.
    positions.set(box.id, { x: candidate.x, y: candidate.y });
  }
  return positions;
}

export function createGraphWorkspace(sourceKey: string): GraphWorkspace {
  return { sourceKey, positions: new Map(), sizes: new Map(), pinned: new Set(), expanded: new Set() };
}

export function overlaps(a: Box, b: Box, gap = 0) {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x
    && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

/** Recorded handoffs define the spine; one chronological inferred parent may attach an otherwise detached stage. */
export function workflowLayoutLinks(graph: JoinedProvenanceGraph): LayoutLink[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const time = (id: string) => Math.min(...byId.get(id)!.instances.flatMap((i) => i.calls.map((call) => call.step)));
  const valid = graph.edges.filter((edge) => byId.has(edge.source) && byId.has(edge.target));
  const links: LayoutLink[] = valid.filter((edge) => edge.witnesses.some((w) => !w.inferred)).map((edge) => ({
    id: edge.id, source: edge.source, target: edge.target,
    priority: edge.witnesses.some((w) => w.highlighted && !w.inferred) ? 20 : 10,
  }));
  const incoming = new Set(links.map((edge) => edge.target));
  for (const edge of valid.filter((edge) => edge.witnesses.every((w) => w.inferred)).sort((a, b) => time(b.source) - time(a.source) || a.id.localeCompare(b.id))) {
    if (incoming.has(edge.target) || byId.get(edge.target)!.source || time(edge.source) >= time(edge.target)) continue;
    const seen = new Set([edge.target]); const queue = [edge.target];
    for (let i = 0; i < queue.length; i++) for (const next of links.filter((link) => link.source === queue[i]).map((link) => link.target)) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    if (seen.has(edge.source)) continue;
    links.push({ id: edge.id, source: edge.source, target: edge.target, priority: 1 }); incoming.add(edge.target);
  }
  return links;
}

function placeBox(box: Box, placed: Box[], gap: number) {
  const candidates = [box.y, ...placed.flatMap((other) => [other.y - box.height - gap, other.y + other.height + gap])];
  for (const y of candidates.sort((a, b) => Math.abs(a - box.y) - Math.abs(b - box.y) || a - b)) {
    const candidate = { ...box, y };
    if (!placed.some((other) => overlaps(candidate, other, gap - 1))) return candidate;
  }
  return { ...box, y: Math.max(0, ...placed.map((other) => other.y + other.height + gap)) };
}

export async function layoutGroups(boxes: Box[], links: LayoutLink[], workspace: GraphWorkspace, reset = false) {
  if (!reset && boxes.every((box) => workspace.positions.has(box.id) && workspace.sizes.get(box.id) === `${box.width}:${box.height}`)) {
    return new Map(boxes.map((box) => [box.id, workspace.positions.get(box.id)!]));
  }
  const elk = new ELK();
  const result = await elk.layout({
    id: 'workflow',
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '40', 'elk.spacing.componentComponent': '64',
      'elk.layered.spacing.nodeNodeBetweenLayers': '104',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.padding': '[top=32,left=40,bottom=32,right=40]',
    },
    children: boxes.map(({ id, width, height }) => ({ id, width, height,
      layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE' },
      ports: [{ id: `${id}:in`, layoutOptions: { 'elk.port.side': 'WEST' } },
        { id: `${id}:out`, layoutOptions: { 'elk.port.side': 'EAST' } }],
    })),
    edges: [...links].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)).map((edge) => ({
      id: edge.id, sources: [`${edge.source}:out`], targets: [`${edge.target}:in`],
      layoutOptions: { 'elk.layered.priority.direction': String(edge.priority),
        'elk.layered.priority.shortness': String(edge.priority) },
    })),
  });
  const automatic = new Map(result.children!.map((node) => [node.id, { x: node.x!, y: node.y! }]));
  const shared = boxes.filter((box) => workspace.positions.has(box.id));
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  const offset = reset ? { x: 0, y: 0 } : {
    x: median(shared.map((box) => workspace.positions.get(box.id)!.x - automatic.get(box.id)!.x)),
    y: median(shared.map((box) => workspace.positions.get(box.id)!.y - automatic.get(box.id)!.y)),
  };
  const placed: Box[] = [];
  const ordered = [...boxes].sort((a, b) => Number(workspace.pinned.has(b.id)) - Number(workspace.pinned.has(a.id))
    || Number(workspace.positions.has(b.id)) - Number(workspace.positions.has(a.id)));
  for (const box of ordered) {
    const saved = reset ? undefined : workspace.positions.get(box.id);
    const auto = automatic.get(box.id)!;
    const candidate = { ...box, ...(saved ?? { x: auto.x + offset.x, y: auto.y + offset.y }) };
    // Deliberate manual positions remain fixed; new and automatically placed boxes avoid them.
    const position = !reset && workspace.pinned.has(box.id) ? candidate : placeBox(candidate, placed, 32);
    placed.push(position);
  }
  return new Map(placed.map(({ id, x, y }) => [id, { x, y }]));
}

function segmentBlocked(a: Point, b: Point, obstacles: Box[]) {
  return obstacles.some((r) => a.y === b.y
    ? a.y > r.y && a.y < r.y + r.height && Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.width
    : a.x > r.x && a.x < r.x + r.width && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.height);
}

class Queue {
  items: Array<{ id: number; cost: number }> = [];
  push(item: { id: number; cost: number }) {
    let index = this.items.length;
    this.items.push(item);
    while (index) {
      const parent = (index - 1) >> 1;
      if (this.items[parent].cost <= item.cost) break;
      this.items[index] = this.items[parent]; index = parent;
    }
    this.items[index] = item;
  }
  pop() {
    const first = this.items[0]; const last = this.items.pop()!;
    if (!this.items.length) return first;
    let index = 0;
    while (index * 2 + 1 < this.items.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.items.length && this.items[child + 1].cost < this.items[child].cost) child++;
      if (this.items[child].cost >= last.cost) break;
      this.items[index] = this.items[child]; index = child;
    }
    this.items[index] = last;
    return first;
  }
}

/** Visibility-grid A*: rectilinear routes avoid card interiors, including after a drag. */
export function routeOrthogonal(source: Point, target: Point, boxes: Box[], lane = 0): Point[] {
  const obstacles = boxes.map((box) => ({ ...box, x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 }));
  const start = { x: source.x + 16 + lane * 3, y: source.y };
  const end = { x: target.x - 16 - lane * 3, y: target.y };
  const unique = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
  const xs = unique([start.x, end.x, ...obstacles.flatMap((r) => [r.x - 8, r.x + r.width + 8])]);
  const ys = unique([start.y, end.y, ...obstacles.flatMap((r) => [r.y - 8, r.y + r.height + 8])]);
  const width = xs.length;
  const point = (id: number) => ({ x: xs[Math.floor(id / 2) % width], y: ys[Math.floor(Math.floor(id / 2) / width)] });
  const startIndex = (ys.indexOf(start.y) * width + xs.indexOf(start.x)) * 2;
  const targetIndex = (ys.indexOf(end.y) * width + xs.indexOf(end.x)) * 2;
  const costs = new Map<number, number>([[startIndex, 0]]), previous = new Map<number, number>();
  const queue = new Queue(); queue.push({ id: startIndex, cost: 0 });
  const visited = new Set<number>();
  while (queue.items.length) {
    const { id } = queue.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    if (Math.floor(id / 2) === targetIndex / 2) {
      const points: Point[] = [target]; let cursor: number | undefined = id;
      while (cursor !== undefined) { points.push(point(cursor)); cursor = previous.get(cursor); }
      points.push(source); points.reverse();
      return points.filter((p, index) => !index || index === points.length - 1
        || (points[index - 1].x !== p.x || p.x !== points[index + 1].x)
          && (points[index - 1].y !== p.y || p.y !== points[index + 1].y));
    }
    const current = point(id), grid = Math.floor(id / 2), x = grid % width, y = Math.floor(grid / width);
    for (const [nx, ny, direction] of [[x - 1, y, 0], [x + 1, y, 0], [x, y - 1, 1], [x, y + 1, 1]]) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= ys.length) continue;
      const next = { x: xs[nx], y: ys[ny] };
      if (segmentBlocked(current, next, obstacles)) continue;
      const nextId = (ny * width + nx) * 2 + direction;
      const cost = costs.get(id)! + Math.abs(current.x - next.x) + Math.abs(current.y - next.y) + (id % 2 !== direction ? 24 : 0);
      if (cost >= (costs.get(nextId) ?? Infinity)) continue;
      costs.set(nextId, cost); previous.set(nextId, id);
      queue.push({ id: nextId, cost: cost + Math.abs(next.x - end.x) + Math.abs(next.y - end.y) });
    }
  }
  // A manually overlapped card can enclose a port. Keep the connection visible while it is moved out.
  return [source, start, { x: start.x, y: end.y }, end, target];
}

export function routePath(points: Point[]) {
  return points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ');
}

/** Round bends within the obstacle-free routing corridor; endpoints stay at the card ports. */
export function curvedRoutePath(points: Point[]) {
  if (points.length === 2) {
    const [a, b] = points;
    const dx = b.x - a.x, dy = b.y - a.y;
    return `M${a.x},${a.y} C${a.x + dx / 3},${a.y + dy / 3 + 8} ${a.x + 2 * dx / 3},${a.y + 2 * dy / 3 - 8} ${b.x},${b.y}`;
  }
  let path = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    const before = Math.hypot(b.x - a.x, b.y - a.y), after = Math.hypot(c.x - b.x, c.y - b.y);
    const radius = Math.min(16, before / 2, after / 2);
    if (!radius) continue;
    const entry = { x: b.x - (b.x - a.x) * radius / before, y: b.y - (b.y - a.y) * radius / before };
    const exit = { x: b.x + (c.x - b.x) * radius / after, y: b.y + (c.y - b.y) * radius / after };
    path += ` L${entry.x},${entry.y} Q${b.x},${b.y} ${exit.x},${exit.y}`;
  }
  const last = points[points.length - 1];
  return `${path} L${last.x},${last.y}`;
}
