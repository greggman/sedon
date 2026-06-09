import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PolygonValue } from '../core/resources.js';

// Author a Polygon by drawing its outer ring in the point-list 2D
// canvas (same widget as terrain paths and curve-2d profiles, with
// `closed: true` so the editor renders the wraparound segment).
//
// Coords from the editor are stored as `[x, y, z, ...extras]` tuples.
// The polygon's outer ring takes the X/Z components of each point
// (Y is ignored — polygons live on the world ground plane). Output
// is a `PolygonValue` whose `outer` is the packed [x, z, x, z, ...]
// Float32Array, implicitly closed.
//
// Winding: we normalise to COUNTER-CLOCKWISE (when viewed from +Y)
// regardless of the author's draw order, so downstream consumers
// (polygon-to-mesh's triangulator, future polygon-difference /
// polygon-offset) can rely on a consistent orientation. The signed-
// area test below catches CW input and reverses it on the way out.

export type Point = [number, number, number, ...number[]];

function normalisePoints(raw: unknown): Point[] {
  if (!Array.isArray(raw)) return [];
  const out: Point[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 3) continue;
    const x = typeof p[0] === 'number' && Number.isFinite(p[0]) ? p[0] : 0;
    const y = typeof p[1] === 'number' && Number.isFinite(p[1]) ? p[1] : 0;
    const z = typeof p[2] === 'number' && Number.isFinite(p[2]) ? p[2] : 0;
    out.push([x, y, z]);
  }
  return out;
}

// 2× signed area of a polygon defined by packed XZ pairs. Positive
// when wound COUNTER-CLOCKWISE in the standard math sense (+X right,
// +Z up). We use the standard shoelace formula. Returns 0 for
// degenerate polygons (< 3 distinct vertices); callers should treat
// that as "no polygon" rather than guess winding.
function signedAreaXZ(packed: Float32Array): number {
  let sum = 0;
  const n = packed.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += packed[i * 2]! * packed[j * 2 + 1]! - packed[j * 2]! * packed[i * 2 + 1]!;
  }
  return sum;
}

export const polygonFromPointsNode: NodeDef = {
  id: 'core/polygon-from-points',
  category: 'Polygon',
  inputs: [
    {
      name: 'points',
      type: 'Vec3',
      widget: 'point-list',
      hideSocket: true,
      closed: true,
      default: [
        [-10, 0, -10],
        [ 10, 0, -10],
        [ 10, 0,  10],
        [-10, 0,  10],
      ] satisfies Point[],
      description:
        'outer-ring vertices, drawn in the 2D editor. The polygon closes back to the first vertex automatically (no need to repeat). Right-click a vertex to delete; click an empty area to add',
    },
  ],
  outputs: [
    {
      name: 'polygon',
      type: 'Polygon',
      description: 'closed polygon on the world XZ plane, normalised to counter-clockwise winding so downstream polygon ops can assume a consistent orientation',
    },
  ],
  doc: {
    summary: 'Author a closed 2D polygon by drawing its outer ring.',
    description: `
The polygon counterpart to [core/point-list](../../core/point-list):
same 2D top-down editor, but the points define a closed RING (the last
vertex implicitly connects back to the first) instead of an open path.

Pair with [core/polygon-to-mesh](../../core/polygon-to-mesh) to
visualise the shape as a flat fill, or feed downstream polygon ops
(offset, difference, fill-with-buildings) as those nodes come online.

The output is normalised to counter-clockwise winding regardless of
the author's draw order so downstream polygon ops can assume a
consistent orientation.
`,
    sampleGraph: () => {
      const g = createGraph();
      const poly = addNode(g, 'core/polygon-from-points', {
        id: 'poly',
        position: { x: 0, y: 0 },
      });
      const mesh = addNode(g, 'core/polygon-to-mesh', {
        id: 'mesh',
        position: { x: 280, y: 0 },
      });
      const mat = addNode(g, 'core/material', {
        id: 'mat',
        position: { x: 280, y: 160 },
        inputValues: { basecolor: [0.55, 0.7, 0.45, 1], roughness: 0.85, metallic: 0 },
      });
      const ent = addNode(g, 'core/scene-entity', {
        id: 'ent',
        position: { x: 560, y: 80 },
      });
      addEdge(g, { node: poly.id, socket: 'polygon' }, { node: mesh.id, socket: 'polygon' });
      addEdge(g, { node: mesh.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
      addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
      return { graph: g, rootNodeId: 'ent' };
    },
  },
  evaluate(_ctx, inputs): { polygon: PolygonValue } {
    const points = normalisePoints(inputs.points);
    if (points.length < 3) {
      // Fewer than 3 points = degenerate; emit an empty polygon
      // (Float32Array(0)). Downstream consumers should treat
      // outer.length === 0 as "no polygon" rather than crash.
      return { polygon: { outer: new Float32Array(0) } };
    }
    const outer = new Float32Array(points.length * 2);
    for (let i = 0; i < points.length; i++) {
      outer[i * 2]     = points[i]![0];
      outer[i * 2 + 1] = points[i]![2];
    }
    // Normalise to CCW. The shoelace formula gives positive area for
    // CCW polygons in our XZ frame (+X right, +Z down on screen but
    // +Z forward in world). We reverse in-place if CW.
    if (signedAreaXZ(outer) < 0) {
      const n = points.length;
      for (let i = 0; i < n / 2; i++) {
        const j = n - 1 - i;
        const ax = outer[i * 2]!,     az = outer[i * 2 + 1]!;
        const bx = outer[j * 2]!,     bz = outer[j * 2 + 1]!;
        outer[i * 2]     = bx; outer[i * 2 + 1] = bz;
        outer[j * 2]     = ax; outer[j * 2 + 1] = az;
      }
    }
    return { polygon: { outer } };
  },
};
