import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PolygonListValue, PolygonValue } from '../core/resources.js';

// Split a polygon by a sequence of straight lines and emit the
// resulting block polygons as a PolygonList. Each line is defined by
// two authored points (the line through them, treated as INFINITE) —
// so a line at the centre of the city splits ALL polygons it
// intersects regardless of where the user dropped the endpoints.
// This matches major-artery semantics (Yamate-dori, Loop 7) and
// trades segment-aware splitting for an order-of-magnitude simpler
// algorithm.
//
// Algorithm: recursive Sutherland-Hodgman.
//   • Start with [input polygon].
//   • For each line, walk the current polygon list. For every
//     polygon, run a half-plane clip against the line: the polygon
//     either stays whole (line doesn't intersect its interior) or
//     splits into two halves.
//   • Output the union of all resulting polygons.
//
// Sutherland-Hodgman is correct for CONVEX inputs (which is what
// polygon-aabb produces; the city demo passes its rectangular
// footprint in). The recursion preserves convexity as long as lines
// are straight: every clip of a convex polygon by a half-plane is
// convex. Concave inputs CAN produce wrong output (the algorithm
// would emit overlapping pieces). Once we have proper polygon
// clipping that handles concave + holes, this node grows to accept
// arbitrary polygons.
//
// Authoring: `lines` is a Vec3 point list (the point-list widget).
// Every pair of consecutive points defines one line — points 0+1 =
// line 0, points 2+3 = line 1, and so on. An odd trailing point is
// ignored.

type Point = [number, number, number, ...number[]];

// Pull (x, z) pairs from a [x, y, z] tuple list, dropping y. Mirrors
// the convention point-list / polygon-from-points already use.
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

// Signed perpendicular distance of (x, z) from the line through
// (p1x, p1z) and (p2x, p2z). Sign tells us which side of the line
// the point is on; magnitude isn't used.
//   ax + bz + c, where (a, b) = (p1z - p2z, p2x - p1x).
function sideOfLine(
  x: number, z: number,
  p1x: number, p1z: number, p2x: number, p2z: number,
): number {
  const a = p1z - p2z;
  const b = p2x - p1x;
  const c = -(a * p1x + b * p1z);
  return a * x + b * z + c;
}

// Clip one convex polygon against the line through (p1, p2). Returns
// up to two polygons:
//   • pos: vertices with side ≥ 0 plus intersection points
//   • neg: vertices with side ≤ 0 plus intersection points
// Whichever side has < 3 vertices is dropped (line doesn't cross
// the polygon). The other side is returned as the unchanged polygon
// if NEITHER side has 3+ vertices (degenerate).
const EPS = 1e-9;

function splitConvexByLine(
  poly: Float32Array,
  p1x: number, p1z: number, p2x: number, p2z: number,
): Float32Array[] {
  const n = poly.length / 2;
  if (n < 3) return [];
  const sides: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    sides[i] = sideOfLine(poly[i * 2]!, poly[i * 2 + 1]!, p1x, p1z, p2x, p2z);
  }
  const pos: number[] = [];
  const neg: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const sx = poly[i * 2]!, sz = poly[i * 2 + 1]!;
    const ex = poly[j * 2]!, ez = poly[j * 2 + 1]!;
    const si = sides[i]!;
    const sj = sides[j]!;
    if (si >= -EPS) pos.push(sx, sz);
    if (si <=  EPS) neg.push(sx, sz);
    // Edge crosses the line — compute intersection and add to BOTH.
    if ((si > EPS && sj < -EPS) || (si < -EPS && sj > EPS)) {
      const t = si / (si - sj);
      const ix = sx + t * (ex - sx);
      const iz = sz + t * (ez - sz);
      pos.push(ix, iz);
      neg.push(ix, iz);
    }
  }
  const out: Float32Array[] = [];
  if (pos.length / 2 >= 3) out.push(new Float32Array(pos));
  if (neg.length / 2 >= 3) out.push(new Float32Array(neg));
  // Line didn't cross — every vertex collected on one side; return
  // the polygon untouched so the caller's list count stays sensible.
  if (out.length === 0) out.push(new Float32Array(poly));
  return out;
}

export const polygonSubdivideByLinesNode: NodeDef = {
  id: 'core/polygon-subdivide-by-lines',
  category: 'Polygon',
  inputs: [
    {
      name: 'polygon',
      type: 'Polygon',
      description: 'polygon to subdivide (typically the city footprint). Must be CONVEX — Sutherland-Hodgman clipping only handles convex inputs; rectangular footprints from polygon-aabb are fine',
    },
    {
      name: 'lines',
      type: 'Vec3',
      widget: 'point-list',
      hideSocket: true,
      default: [] as Point[],
      description: 'authored road centerlines. Every two consecutive points (0+1, 2+3, …) define one INFINITE line through those points. Drop pairs in the 2D editor to add major arteries; odd-trailing points are ignored',
    },
  ],
  outputs: [
    {
      name: 'polygons',
      type: 'PolygonList',
      description: 'block polygons left after splitting the input by every authored line, in subdivision order. Each block is CCW; collapsed (zero-area) pieces are dropped',
    },
  ],
  doc: {
    summary: 'Subdivide a convex polygon by a set of straight lines into block polygons.',
    description: `
The minimal road-network → block-polygons primitive. Drop pairs of
points in the 2D editor; every pair defines one INFINITE straight line
through those points. The node clips the input polygon by each line
in sequence using Sutherland-Hodgman, emitting the resulting block
polygons as a PolygonList ready for
[core/for-each-polygon](../../core/for-each-polygon).

Lines are infinite for now, which matches the semantics of major
arteries that cross the whole city. Dead-end / partial-extent roads
need a more elaborate planar-arrangement algorithm and come as a
follow-up.

Input polygon must be CONVEX (the algorithm assumes it). Rectangular
footprints from [core/polygon-aabb](../../core/polygon-aabb) are
fine; arbitrary hand-drawn outlines may produce wrong output.
`,
    sampleGraph: () => {
      const g = createGraph();
      const aabb = addNode(g, 'core/polygon-aabb', {
        id: 'aabb',
        position: { x: 0, y: 0 },
        inputValues: { center: [0, 0], size: [40, 40] },
      });
      const split = addNode(g, 'core/polygon-subdivide-by-lines', {
        id: 'split',
        position: { x: 280, y: 0 },
        inputValues: {
          lines: [
            // Two crossing lines through the centre.
            [-25, 0, -5], [25, 0, 5],
            [-25, 0, 5], [25, 0, -5],
          ],
        },
      });
      addEdge(g, { node: aabb.id, socket: 'polygon' }, { node: split.id, socket: 'polygon' });
      return { graph: g, rootNodeId: 'split' };
    },
  },
  evaluate(_ctx, inputs): { polygons: PolygonListValue } {
    const poly = inputs.polygon as PolygonValue | undefined;
    const linePairs = pairsXZ(inputs.lines);
    if (!poly || poly.outer.length < 6) {
      return { polygons: { polygons: [] } };
    }
    const numLines = Math.floor(linePairs.length / 4);
    let current: Float32Array[] = [poly.outer];
    for (let li = 0; li < numLines; li++) {
      const p1x = linePairs[li * 4]!;
      const p1z = linePairs[li * 4 + 1]!;
      const p2x = linePairs[li * 4 + 2]!;
      const p2z = linePairs[li * 4 + 3]!;
      // Degenerate (same point twice) → skip; doesn't define a line.
      if (Math.abs(p1x - p2x) < EPS && Math.abs(p1z - p2z) < EPS) continue;
      const next: Float32Array[] = [];
      for (const block of current) {
        const pieces = splitConvexByLine(block, p1x, p1z, p2x, p2z);
        for (const p of pieces) next.push(p);
      }
      current = next;
    }
    return {
      polygons: { polygons: current.map((outer) => ({ outer })) },
    };
  },
};
