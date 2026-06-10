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
// The walk is PER-EDGE: each edge gets points uniformly distributed
// within `[corner_clearance, edgeLen - corner_clearance]`, centred
// in that usable span. `corner_clearance` is the minimum distance
// from the edge endpoint to any placement — set to the building's
// HALF-WIDTH (the extent perpendicular to the inward axis) so the
// scattered building's full width fits within the edge and doesn't
// poke past a polygon corner into an adjacent road. With clearance=0
// (the default) the behaviour matches the original "place points
// every `spacing` along the perimeter" rule.
//
// Edges shorter than `2 * corner_clearance` are skipped — they're
// too short to fit a single building's width.

function len2(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

export const polygonPerimeterPointsNode: NodeDef = {
  id: 'points/polygon-perimeter',
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
      name: 'corner_clearance',
      type: 'Float',
      default: 0,
      min: 0,
      description: 'minimum distance from each polygon corner before a point is placed. Set to the scattered instance\'s HALF-WIDTH so its footprint can\'t extend past a corner into an adjacent edge. Edges shorter than 2 × this are skipped entirely',
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
      const aabb = addNode(g, 'poly/aabb', {
        id: 'aabb',
        position: { x: 0, y: 0 },
        inputValues: { center: [0, 0], size: [40, 60] },
      });
      const pts = addNode(g, 'points/polygon-perimeter', {
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
    const cornerClearance = Math.max(0, (inputs.corner_clearance as number) ?? 0);
    const y = inputs.y as number;
    const empty: PointCloudValue = {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      tangents: new Float32Array(0),
      count: 0,
    };
    if (!poly || poly.outer.length < 6) return { points: empty };
    const outer = poly.outer;
    const n = outer.length / 2;

    // Two-pass: count first, then allocate exact-sized typed arrays.
    // Any candidate placement that lands AT or past the edge's end
    // vertex is dropped — the next edge starts at that same vertex,
    // so without this filter polygons would have duplicate corner
    // points (and corner buildings would render twice). With
    // clearance > 0, all candidates lie strictly inside the edge and
    // the filter is a no-op.
    let total = 0;
    const perEdge: { count: number; startOffset: number; edgeLen: number;
                     edgeStartX: number; edgeStartZ: number;
                     edgeDx: number; edgeDz: number;
                     inwardX: number; inwardZ: number }[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const startX = outer[i * 2]!;
      const startZ = outer[i * 2 + 1]!;
      const dx = outer[j * 2]! - startX;
      const dz = outer[j * 2 + 1]! - startZ;
      const edgeLen = len2(dx, dz);
      if (edgeLen < 1e-12) continue;
      // Usable span = edge length minus clearance at each end. If the
      // edge is shorter than 2 × clearance, no placement here at all
      // (a building's full width wouldn't fit between the corners).
      const usableSpan = edgeLen - 2 * cornerClearance;
      if (usableSpan < 0) continue;
      const numCandidates = Math.max(1, Math.floor(usableSpan / spacing) + 1);
      const totalSpan = (numCandidates - 1) * spacing;
      const startOffset = cornerClearance + (usableSpan - totalSpan) / 2;
      // Count placements after filtering out any that touch the edge
      // end (shared with the next edge's start vertex).
      let actualCount = 0;
      for (let k = 0; k < numCandidates; k++) {
        const arc = startOffset + k * spacing;
        if (arc >= edgeLen - 1e-9) break;
        actualCount++;
      }
      if (actualCount === 0) continue;
      const dxN = dx / edgeLen;
      const dzN = dz / edgeLen;
      perEdge.push({
        count: actualCount,
        startOffset,
        edgeLen,
        edgeStartX: startX,
        edgeStartZ: startZ,
        edgeDx: dxN,
        edgeDz: dzN,
        // Inward = rotate edge direction 90° CCW in XZ. The codebase's
        // polygon-from-points / polygon-aabb normalise to positive
        // XZ-shoelace winding (= CW from above; see polygon-to-mesh's
        // fan-triangulation comment) so (-dz, dx) points INSIDE for
        // those outputs.
        inwardX: -dzN,
        inwardZ:  dxN,
      });
      total += actualCount;
    }
    if (total === 0) return { points: empty };

    const positions = new Float32Array(total * 3);
    const normals = new Float32Array(total * 3);
    const tangents = new Float32Array(total * 3);
    let p = 0;
    for (const e of perEdge) {
      for (let k = 0; k < e.count; k++) {
        const arc = e.startOffset + k * spacing;
        const x = e.edgeStartX + e.edgeDx * arc;
        const z = e.edgeStartZ + e.edgeDz * arc;
        positions[p * 3]     = x;
        positions[p * 3 + 1] = y;
        positions[p * 3 + 2] = z;
        normals[p * 3]     = 0;
        normals[p * 3 + 1] = 1;
        normals[p * 3 + 2] = 0;
        tangents[p * 3]     = e.inwardX;
        tangents[p * 3 + 1] = 0;
        tangents[p * 3 + 2] = e.inwardZ;
        p++;
      }
    }
    return { points: { positions, normals, tangents, count: total } };
  },
};
