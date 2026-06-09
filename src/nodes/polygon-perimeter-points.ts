import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue, PolygonValue } from '../core/resources.js';

// Distribute points along the polygon's outer ring at a fixed
// arc-length spacing. Outputs a PointCloud whose `normals` are world
// up (so `instance-scene-on-points` with `align: true` keeps instances
// upright) and whose `tangents` point INWARD along the edge — this
// orients scattered buildings to face the polygon interior without
// any per_point_yaw plumbing.
//
// Walking convention: every edge contributes points starting at its
// start vertex (offset by `spacing/2` to avoid double-counting the
// shared vertex with the previous edge) and continuing every
// `spacing` metres. The leftover at the end of the perimeter is
// absorbed by the implicit wrap from the last edge back to the first.
//
// For a CCW polygon (the convention this codebase normalises to via
// polygon-from-points / polygon-aabb), the inward normal of an edge
// with direction `(dx, dz)` is `(-dz, dx)` — left of the direction
// of travel.

function len2(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

// Total perimeter (arc-length sum of all edges) of the outer ring.
function perimeter(outer: Float32Array): number {
  const n = outer.length / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = outer[j * 2]! - outer[i * 2]!;
    const dz = outer[j * 2 + 1]! - outer[i * 2 + 1]!;
    sum += len2(dx, dz);
  }
  return sum;
}

export const polygonPerimeterPointsNode: NodeDef = {
  id: 'core/polygon-perimeter-points',
  category: 'Polygon',
  inputs: [
    {
      name: 'polygon',
      type: 'Polygon',
      description: 'polygon whose outer ring is sampled',
    },
    {
      name: 'spacing',
      type: 'Float',
      default: 20,
      min: 0.01,
      description: 'distance between consecutive points along the perimeter, in world units. A 20 m spacing on a 200 m block edge gives 10 points per edge',
    },
    {
      name: 'y',
      type: 'Float',
      default: 0,
      description: 'world Y the points sit at',
    },
  ],
  outputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: 'evenly-spaced points along the polygon edge. `normals` are world up (+Y); `tangents` point INWARD along each edge so downstream `instance-scene-on-points` orients buildings to face the polygon interior',
    },
  ],
  doc: {
    summary: 'Evenly-spaced points along a polygon\'s outer ring.',
    description: `
Walks the polygon edge at a constant arc-length step and emits one
point per step. Useful for the "place a building / lamp / fence post
every N metres along the block perimeter" pattern.

Per-point output:
  • position — on the edge at Y = \`y\`
  • normal   — \`(0, 1, 0)\` (world up; keeps buildings upright when
               a downstream scatter uses \`align: true\`)
  • tangent  — inward unit vector along the edge, so the scatter's
               local +Z (forward) ends up pointing at the polygon
               interior — buildings face inward without any
               per_point_yaw work
`,
    sampleGraph: () => {
      const g = createGraph();
      const aabb = addNode(g, 'core/polygon-aabb', {
        id: 'aabb',
        position: { x: 0, y: 0 },
        inputValues: { center: [0, 0], size: [40, 60] },
      });
      const pts = addNode(g, 'core/polygon-perimeter-points', {
        id: 'pts',
        position: { x: 280, y: 0 },
        inputValues: { spacing: 5 },
      });
      addEdge(g, { node: aabb.id, socket: 'polygon' }, { node: pts.id, socket: 'polygon' });
      return { graph: g, rootNodeId: 'pts' };
    },
  },
  evaluate(_ctx, inputs): { points: PointCloudValue } {
    const poly = inputs.polygon as PolygonValue;
    const spacing = Math.max(0.01, inputs.spacing as number);
    const y = inputs.y as number;
    if (!poly || poly.outer.length < 6) {
      return { points: { positions: new Float32Array(0), normals: new Float32Array(0), tangents: new Float32Array(0), count: 0 } };
    }
    const outer = poly.outer;
    const n = outer.length / 2;
    const perim = perimeter(outer);
    if (perim <= 0) {
      return { points: { positions: new Float32Array(0), normals: new Float32Array(0), tangents: new Float32Array(0), count: 0 } };
    }
    const count = Math.max(1, Math.floor(perim / spacing));
    // Actual spacing rounded so the points distribute evenly around
    // the closed ring with no leftover at the wraparound seam.
    const step = perim / count;

    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const tangents = new Float32Array(count * 3);

    let edgeIdx = 0;
    let edgeDist = 0; // distance ALONG current edge
    let edgeLen = 0;
    let edgeDx = 0, edgeDz = 0;       // edge direction (unit)
    let inwardX = 0, inwardZ = 0;     // inward normal (unit)
    let edgeStartX = 0, edgeStartZ = 0;
    const loadEdge = (i: number) => {
      const j = (i + 1) % n;
      edgeStartX = outer[i * 2]!;
      edgeStartZ = outer[i * 2 + 1]!;
      const dx = outer[j * 2]! - edgeStartX;
      const dz = outer[j * 2 + 1]! - edgeStartZ;
      edgeLen = len2(dx, dz);
      if (edgeLen < 1e-12) {
        // Degenerate edge — direction undefined; skip cleanly.
        edgeDx = 1; edgeDz = 0;
        inwardX = 0; inwardZ = 1;
        return;
      }
      edgeDx = dx / edgeLen;
      edgeDz = dz / edgeLen;
      // Inward = rotate edge direction 90° CCW in XZ for a CCW polygon
      // (left of travel direction is inside the polygon).
      inwardX = -edgeDz;
      inwardZ =  edgeDx;
    };
    loadEdge(0);

    // First point sits half a step in so the points are symmetric
    // around the ring without falling exactly on vertices.
    let arc = step * 0.5;
    for (let p = 0; p < count; p++) {
      // Walk forward until `arc` lands within the current edge.
      while (arc > edgeLen) {
        arc -= edgeLen;
        edgeIdx = (edgeIdx + 1) % n;
        loadEdge(edgeIdx);
      }
      const x = edgeStartX + edgeDx * arc;
      const z = edgeStartZ + edgeDz * arc;
      positions[p * 3]     = x;
      positions[p * 3 + 1] = y;
      positions[p * 3 + 2] = z;
      normals[p * 3]     = 0;
      normals[p * 3 + 1] = 1;
      normals[p * 3 + 2] = 0;
      tangents[p * 3]     = inwardX;
      tangents[p * 3 + 1] = 0;
      tangents[p * 3 + 2] = inwardZ;
      arc += step;
      edgeDist += step;
    }
    void edgeDist; // kept for symmetry with edge-walking pattern; not surfaced
    return { points: { positions, normals, tangents, count } };
  },
};
