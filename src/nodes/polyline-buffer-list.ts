import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PolygonListValue, PolygonValue } from '../core/resources.js';

// Companion to `core/polygon-subdivide-by-lines`: take the same
// authored-as-pairs line set, clip every line to the input polygon,
// and emit one rectangular road-shaped polygon per line as a
// PolygonList. Wire the output through
// `core/polygon-list-to-mesh` + a material to render the road
// network as asphalt.
//
// Algorithm: for each line through P1, P2:
//   1. Parametrise as P(t) = P1 + t·(P2 − P1).
//   2. Find every intersection of the infinite line with a polygon
//      edge — record the parameter t.
//   3. For a convex polygon the line either misses (no intersections)
//      or crosses exactly twice (entry + exit). Take the smallest and
//      largest t; the segment between them is the clipped centerline.
//   4. Compute the unit perpendicular `(-dz, dx) / |·|` (the "left"
//      side of the direction of travel) and emit a 4-vertex rect
//      with the two endpoints offset ±width/2 along the perpendicular.
//
// Limitations: input polygon must be CONVEX (matches polygon-
// subdivide-by-lines's assumption). Non-convex outlines may produce
// more than two intersections; this v1 still picks min/max t, which
// is wrong but bounded — output is always a single rectangle per
// line. Concave-clip support comes when proper polygon clipping
// ships.

const EPS = 1e-9;

type Point = [number, number, number, ...number[]];

function pairsXZ(raw: unknown): Float32Array {
  if (!Array.isArray(raw)) return new Float32Array(0);
  const out: number[] = [];
  for (const p of raw as Point[]) {
    if (!Array.isArray(p) || p.length < 3) continue;
    const x = typeof p[0] === 'number' && Number.isFinite(p[0]) ? p[0] : 0;
    const z = typeof p[2] === 'number' && Number.isFinite(p[2]) ? p[2] : 0;
    out.push(x, z);
  }
  return new Float32Array(out);
}

// Intersect the infinite line through (P1, P2) with the SEGMENT from
// Q1 to Q2. Returns the parameter `t` on the line where the
// intersection lies (= P1 + t·(P2 − P1)), or null if no valid
// intersection on the segment. We solve for s on the segment too
// and require 0 ≤ s ≤ 1.
function intersectLineSegment(
  p1x: number, p1z: number, p2x: number, p2z: number,
  q1x: number, q1z: number, q2x: number, q2z: number,
): number | null {
  const dx = p2x - p1x, dz = p2z - p1z;
  const ex = q2x - q1x, ez = q2z - q1z;
  const denom = dx * ez - dz * ex;
  if (Math.abs(denom) < EPS) return null; // parallel
  const rx = q1x - p1x, rz = q1z - p1z;
  const t = (rx * ez - rz * ex) / denom;
  const s = (rx * dz - rz * dx) / denom;
  if (s < -EPS || s > 1 + EPS) return null;
  return t;
}

// Build the road polygon for one line clipped to the polygon. Returns
// null when the line misses the polygon entirely.
function clipAndBuffer(
  polyOuter: Float32Array,
  p1x: number, p1z: number, p2x: number, p2z: number,
  width: number,
): Float32Array | null {
  const ringLen = polyOuter.length / 2;
  let tMin = +Infinity, tMax = -Infinity;
  for (let i = 0; i < ringLen; i++) {
    const j = (i + 1) % ringLen;
    const t = intersectLineSegment(
      p1x, p1z, p2x, p2z,
      polyOuter[i * 2]!, polyOuter[i * 2 + 1]!,
      polyOuter[j * 2]!, polyOuter[j * 2 + 1]!,
    );
    if (t === null) continue;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  if (!Number.isFinite(tMin) || !Number.isFinite(tMax) || tMax - tMin < EPS) {
    return null;
  }
  const ax = p1x + tMin * (p2x - p1x);
  const az = p1z + tMin * (p2z - p1z);
  const bx = p1x + tMax * (p2x - p1x);
  const bz = p1z + tMax * (p2z - p1z);
  // Direction along the road centerline.
  const dx = bx - ax;
  const dz = bz - az;
  const L = Math.sqrt(dx * dx + dz * dz);
  if (L < EPS) return null;
  // Unit perpendicular ("left" relative to travel direction). Choose
  // either side; the rect vertex order below uses both ±sides so the
  // polygon stays CCW regardless of which way the line was authored.
  const nx = -dz / L;
  const nz =  dx / L;
  const h = width / 2;
  // 4-vertex CCW rectangle:
  //   v0 = A − h·n  (entry, right of travel)
  //   v1 = B − h·n  (exit, right)
  //   v2 = B + h·n  (exit, left)
  //   v3 = A + h·n  (entry, left)
  return new Float32Array([
    ax - h * nx, az - h * nz,
    bx - h * nx, bz - h * nz,
    bx + h * nx, bz + h * nz,
    ax + h * nx, az + h * nz,
  ]);
}

export const polylineBufferListNode: NodeDef = {
  id: 'core/polyline-buffer-list',
  category: 'Polygon',
  inputs: [
    {
      name: 'clip',
      type: 'Polygon',
      description: 'convex polygon to clip each line against (typically the city footprint). Lines outside the polygon emit nothing',
    },
    {
      name: 'lines',
      type: 'Vec3',
      widget: 'point-list',
      hideSocket: true,
      default: [] as Point[],
      description: 'authored road centerlines, same convention as `core/polygon-subdivide-by-lines`: every two consecutive points (0+1, 2+3, …) define one INFINITE line. Each line is clipped to `clip` and buffered to `width`',
    },
    {
      name: 'width',
      type: 'Float',
      default: 18,
      min: 0.01,
      description: 'full road width in metres. 18 m matches the chunk-4 city\'s 4-lane streets',
    },
  ],
  outputs: [
    {
      name: 'polygons',
      type: 'PolygonList',
      description: 'one rectangular road polygon per line. Lines that miss the clip polygon are skipped, so the list length can be smaller than the line count',
    },
  ],
  doc: {
    summary: 'Clip authored lines to a polygon and buffer them into rectangular road polygons.',
    description: `
The road-rendering counterpart to
[core/polygon-subdivide-by-lines](../../core/polygon-subdivide-by-lines).
Same \`lines\` input convention (pairs of points → one infinite
line each); each line is clipped to the \`clip\` polygon and turned
into a 4-vertex rectangle straddling the line at \`width\` metres
wide. The resulting PolygonList feeds straight into
[core/polygon-list-to-mesh](../../core/polygon-list-to-mesh) for
asphalt rendering.

Wire the same \`lines\` value into both this node and
\`polygon-subdivide-by-lines\` to keep the road network and the
block subdivision in sync.
`,
    sampleGraph: () => {
      const g = createGraph();
      const aabb = addNode(g, 'core/polygon-aabb', {
        id: 'aabb',
        position: { x: 0, y: 0 },
        inputValues: { center: [0, 0], size: [40, 40] },
      });
      const lines = addNode(g, 'core/polyline-buffer-list', {
        id: 'lines',
        position: { x: 280, y: 0 },
        inputValues: {
          lines: [
            [0, 0, -100], [0, 0, 100],
            [-100, 0, 0], [100, 0, 0],
          ],
          width: 3,
        },
      });
      addEdge(g, { node: aabb.id, socket: 'polygon' }, { node: lines.id, socket: 'clip' });
      return { graph: g, rootNodeId: 'lines' };
    },
  },
  evaluate(_ctx, inputs): { polygons: PolygonListValue } {
    const clip = inputs.clip as PolygonValue | undefined;
    const linePairs = pairsXZ(inputs.lines);
    const width = inputs.width as number;
    if (!clip || clip.outer.length < 6) {
      return { polygons: { polygons: [] } };
    }
    const numLines = Math.floor(linePairs.length / 4);
    const out: PolygonValue[] = [];
    for (let li = 0; li < numLines; li++) {
      const p1x = linePairs[li * 4]!;
      const p1z = linePairs[li * 4 + 1]!;
      const p2x = linePairs[li * 4 + 2]!;
      const p2z = linePairs[li * 4 + 3]!;
      if (Math.abs(p1x - p2x) < EPS && Math.abs(p1z - p2z) < EPS) continue;
      const outer = clipAndBuffer(clip.outer, p1x, p1z, p2x, p2z, width);
      if (outer) out.push({ outer });
    }
    return { polygons: { polygons: out } };
  },
};
