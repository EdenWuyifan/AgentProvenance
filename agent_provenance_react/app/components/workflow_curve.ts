import type { Box, Point } from './graph_layout';

export type CubicCurve = [Point, Point, Point, Point, ...Point[]];

export function cubicPath(curve: CubicCurve) {
  let path = `M${curve[0].x},${curve[0].y}`;
  for (let i = 1; i < curve.length; i += 3) path += ` C${curve[i].x},${curve[i].y} ${curve[i + 1].x},${curve[i + 1].y} ${curve[i + 2].x},${curve[i + 2].y}`;
  return path;
}

export function curveSamples(curve: CubicCurve) {
  const points: Point[] = [];
  for (let offset = 0; offset < curve.length - 1; offset += 3) {
    const [a, b, c, d] = curve.slice(offset, offset + 4);
    const length = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y) + Math.hypot(d.x - c.x, d.y - c.y);
    const steps = Math.min(512, Math.max(24, Math.ceil(length / 10)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      points.push({ x: u ** 3 * a.x + 3 * u ** 2 * t * b.x + 3 * u * t ** 2 * c.x + t ** 3 * d.x,
        y: u ** 3 * a.y + 3 * u ** 2 * t * b.y + 3 * u * t ** 2 * c.y + t ** 3 * d.y });
    }
  }
  return points;
}

/** Cross-lane handoffs leave vertically; chronological links leave horizontally. */
export function workflowCurve(source: Box, target: Box, crossLane: boolean, obstacles: Box[]) {
  const down = target.y + target.height / 2 >= source.y + source.height / 2;
  const start = crossLane ? { x: source.x + source.width / 2, y: source.y + (down ? source.height : 0) }
    : { x: source.x + source.width, y: source.y + source.height / 2 };
  const end = crossLane ? { x: target.x + target.width / 2, y: target.y + (down ? 0 : target.height) }
    : { x: target.x, y: target.y + target.height / 2 };
  const distance = crossLane ? Math.max(32, Math.abs(end.y - start.y) * 0.5) : Math.max(32, Math.min(96, Math.abs(end.x - start.x) * 0.45));
  const direction = down ? 1 : -1;
  const make = (bend: number): CubicCurve => {
    // Long skips leave the event row promptly instead of sweeping over its dots.
    if (!crossLane && bend && end.x - start.x > 72) {
      const y = (bend > 0 ? Math.max(start.y, end.y) : Math.min(start.y, end.y)) + bend;
      const span = end.x - start.x - 72;
      return [start, { x: start.x + 14, y: start.y }, { x: start.x + 14, y }, { x: start.x + 36, y },
        { x: start.x + 36 + span / 3, y }, { x: end.x - 36 - span / 3, y }, { x: end.x - 36, y },
        { x: end.x - 14, y }, { x: end.x - 14, y: end.y }, end];
    }
    return crossLane ? [start, { x: start.x + bend, y: start.y + direction * distance },
      { x: end.x + bend, y: end.y - direction * distance }, end]
    : [start, { x: start.x + distance, y: start.y + bend },
      { x: end.x - distance, y: end.y + bend }, end];
  };
  let curve = make(0), best = Infinity;
  for (const bend of obstacles.length ? [0, 88, -88, 112, -112, 144, -144, 288, -288, 480, -480] : []) {
    const candidate = make(bend);
    const hits = curveSamples(candidate).filter((point) => obstacles.some((box) => point.x > box.x - 6
      && point.x < box.x + box.width + 6 && point.y > box.y - 6 && point.y < box.y + box.height + 6)).length;
    if (hits < best) { curve = candidate; best = hits; }
    if (!hits) break;
  }
  return { curve, sourceHandle: crossLane ? down ? 'out-bottom' : 'out-top' : undefined,
    targetHandle: crossLane ? down ? 'in-top' : 'in-bottom' : undefined };
}
