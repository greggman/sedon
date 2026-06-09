import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue, PolygonValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { uploadMeshToGpu } from '../render/mesh.js';
import type { CpuMesh } from '../render/mesh.js';

// Convert a Polygon into a flat triangulated mesh on the XZ plane at
// the given Y. Triangulation is fan-from-centroid: cheap, allocation-
// free, correct for convex AND star-shaped polygons (every vertex is
// visible from the centroid). For the polygons users author by hand
// or get from `polygon-aabb` this is the right algorithm — going to
// full ear-clipping only matters once we have polygon-difference /
// road-subtraction producing concave irregular blocks. That upgrade
// can come as its own chunk; the type and the API don't change.
//
// UV mapping: U follows the polygon's bbox X, V follows bbox Z, both
// in [0, 1]. Matches `core/plane`'s convention so a texture authored
// for plane works without re-mapping.
//
// Note: holes are ignored in this chunk (no node creates them yet).
// When polygon-difference / canal authoring lands we'll upgrade this
// to ear-clipping with hole-bridging.

function buildFanMesh(polygon: PolygonValue, y: number): CpuMesh | null {
  const outer = polygon.outer;
  const ringLen = outer.length / 2;
  if (ringLen < 3) return null;
  // Centroid (average of vertices — not the proper area-weighted
  // centroid, but good enough for fan triangulation since we only
  // need a point inside any star-shaped polygon).
  let cx = 0, cz = 0;
  for (let i = 0; i < ringLen; i++) {
    cx += outer[i * 2]!;
    cz += outer[i * 2 + 1]!;
  }
  cx /= ringLen;
  cz /= ringLen;
  // Bbox for UV mapping. Avoid div-by-zero for degenerate (zero-area)
  // polygons by clamping to 1 — UVs are arbitrary on a zero-area mesh.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < ringLen; i++) {
    const x = outer[i * 2]!, z = outer[i * 2 + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const sx = Math.max(1e-6, maxX - minX);
  const sz = Math.max(1e-6, maxZ - minZ);

  const numVerts = ringLen + 1; // outer + centroid
  const positions = new Float32Array(numVerts * 3);
  const normals = new Float32Array(numVerts * 3);
  const uvs = new Float32Array(numVerts * 2);

  // Centroid → index 0.
  positions[0] = cx;
  positions[1] = y;
  positions[2] = cz;
  normals[0] = 0; normals[1] = 1; normals[2] = 0;
  uvs[0] = (cx - minX) / sx;
  uvs[1] = (cz - minZ) / sz;
  for (let i = 0; i < ringLen; i++) {
    const x = outer[i * 2]!, z = outer[i * 2 + 1]!;
    const vi = i + 1;
    positions[vi * 3]     = x;
    positions[vi * 3 + 1] = y;
    positions[vi * 3 + 2] = z;
    normals[vi * 3]     = 0;
    normals[vi * 3 + 1] = 1;
    normals[vi * 3 + 2] = 0;
    uvs[vi * 2]     = (x - minX) / sx;
    uvs[vi * 2 + 1] = (z - minZ) / sz;
  }

  // Fan triangles: (centroid, outer[i+1], outer[i]). Our polygon
  // convention is "positive shoelace in (X, Z) coords" — which
  // corresponds to CW order when viewed from +Y down (Z is mirrored
  // on screen vs. the standard XY shoelace convention). To get
  // upward-facing triangle normals we therefore have to walk the
  // ring in REVERSE relative to the (centroid, v_i, v_{i+1}) order
  // that would be correct in flat XY.
  const indices = new Uint32Array(ringLen * 3);
  for (let i = 0; i < ringLen; i++) {
    const a = i + 1;
    const b = ((i + 1) % ringLen) + 1;
    indices[i * 3]     = 0;
    indices[i * 3 + 1] = b;
    indices[i * 3 + 2] = a;
  }
  return { positions, normals, uvs, indices };
}

export const polygonToMeshNode: NodeDef = {
  id: 'core/polygon-to-mesh',
  category: 'Polygon',
  inputs: [
    {
      name: 'polygon',
      type: 'Polygon',
      description: 'closed XZ polygon to triangulate',
    },
    {
      name: 'y',
      type: 'Float',
      default: 0,
      description: 'world Y the resulting mesh sits at',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'a flat triangulated mesh lying at Y = y, normal +Y, UVs spanning [0,1] across the polygon\'s bounding rect',
    },
  ],
  doc: {
    summary: 'Triangulate a Polygon into a flat mesh on the XZ plane.',
    description: `
Fan-triangulation from the polygon's centroid. Correct for any
convex polygon and any star-shaped polygon (every vertex visible from
the centroid) — which is what hand-authored polygons and
\`polygon-aabb\` rects always are.

A future upgrade to full ear-clipping will handle arbitrary concave
polygons + holes (needed once \`polygon-difference\` lands), but the
node's input/output contract stays the same.

Pair with [core/scene-entity](../../core/scene-entity) and a
material to render the polygon as a coloured patch on the ground
plane. Useful for visualising what your polygon ops produced.
`,
    sampleGraph: () => {
      const g = createGraph();
      const aabb = addNode(g, 'core/polygon-aabb', {
        id: 'aabb',
        position: { x: 0, y: 0 },
        inputValues: { center: [0, 0], size: [4, 4] },
      });
      const mesh = addNode(g, 'core/polygon-to-mesh', {
        id: 'mesh',
        position: { x: 280, y: 0 },
      });
      addEdge(g, { node: aabb.id, socket: 'polygon' }, { node: mesh.id, socket: 'polygon' });
      return { graph: g, rootNodeId: 'mesh' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const polygon = inputs.polygon as PolygonValue;
    const y = inputs.y as number;
    const mesh = buildFanMesh(polygon, y);
    if (!mesh) {
      // Degenerate polygon — return a single-triangle zero-area mesh
      // at the origin. Avoids downstream null-checks; the renderer
      // happily draws nothing for a degenerate triangle.
      const empty: CpuMesh = {
        positions: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]),
        normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: new Float32Array([0, 0, 0, 0, 0, 0]),
        indices: new Uint32Array([0, 1, 2]),
      };
      return {
        geometry: uploadMeshToGpu(device, empty, ctx.previousOutput?.geometry as GeometryValue | undefined),
      };
    }
    return {
      geometry: uploadMeshToGpu(device, mesh, ctx.previousOutput?.geometry as GeometryValue | undefined),
    };
  },
};
