import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue, PolygonListValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import type { CpuMesh } from '../render/mesh.js';
import { uploadMeshToGpu } from '../render/mesh.js';

// List-mode of `geom/from-polygon`: triangulate every polygon in
// the input list and concatenate the results into ONE Geometry. Same
// fan-triangulation-from-centroid as the single-polygon node, just
// repeated per polygon with vertex / index offsets accumulated.
//
// One Geometry means downstream wires into ONE scene-entity with ONE
// material — and therefore ONE instanced draw at the renderer. Useful
// for "render every road / district / lot with the same asphalt /
// grass / concrete material in a single batch": cheaper than
// iterating the list with a for-each-polygon body that constructs a
// scene-entity per polygon.
//
// UV mapping: U / V span [0, 1] across each polygon's local bounding
// rect (same as `geom/from-polygon`). Each polygon gets its own
// independent UV range; if you want per-polygon tinting use
// per_point_tint on an instance-on-points scatter instead.

function buildFanMesh(polygons: { outer: Float32Array }[], y: number): CpuMesh | null {
  // Compute total vertex / index counts first so we can allocate
  // typed arrays once. Each polygon contributes (ringLen + 1)
  // vertices (centroid + ring) and 3 * ringLen indices.
  let totalVerts = 0;
  let totalIndices = 0;
  for (const p of polygons) {
    const ringLen = p.outer.length / 2;
    if (ringLen < 3) continue;
    totalVerts += ringLen + 1;
    totalIndices += ringLen * 3;
  }
  if (totalVerts === 0) return null;

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint32Array(totalIndices);

  let vCursor = 0; // running vertex index across all polygons
  let iCursor = 0; // running index-array write position
  for (const p of polygons) {
    const outer = p.outer;
    const ringLen = outer.length / 2;
    if (ringLen < 3) continue;

    // Per-polygon centroid + bbox for UVs.
    let cx = 0, cz = 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < ringLen; i++) {
      const x = outer[i * 2]!, z = outer[i * 2 + 1]!;
      cx += x; cz += z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    cx /= ringLen; cz /= ringLen;
    const sx = Math.max(1e-6, maxX - minX);
    const sz = Math.max(1e-6, maxZ - minZ);
    const centroidV = vCursor;

    positions[centroidV * 3]     = cx;
    positions[centroidV * 3 + 1] = y;
    positions[centroidV * 3 + 2] = cz;
    normals[centroidV * 3]     = 0;
    normals[centroidV * 3 + 1] = 1;
    normals[centroidV * 3 + 2] = 0;
    uvs[centroidV * 2]     = (cx - minX) / sx;
    uvs[centroidV * 2 + 1] = (cz - minZ) / sz;
    for (let i = 0; i < ringLen; i++) {
      const x = outer[i * 2]!, z = outer[i * 2 + 1]!;
      const vi = centroidV + 1 + i;
      positions[vi * 3]     = x;
      positions[vi * 3 + 1] = y;
      positions[vi * 3 + 2] = z;
      normals[vi * 3]     = 0;
      normals[vi * 3 + 1] = 1;
      normals[vi * 3 + 2] = 0;
      uvs[vi * 2]     = (x - minX) / sx;
      uvs[vi * 2 + 1] = (z - minZ) / sz;
    }
    // Fan triangulation: (centroid, v_{i+1}, v_i). Reverse order
    // relative to flat-XY shoelace's CCW convention because our
    // (X, Z) coordinates view the +Z axis as DOWN on screen — a
    // polygon with positive shoelace area is CW when viewed from +Y
    // down to ground, so the standard fan order would face triangles
    // downward. See polygon-to-mesh for the same reasoning.
    for (let i = 0; i < ringLen; i++) {
      indices[iCursor++] = centroidV;
      indices[iCursor++] = centroidV + 1 + ((i + 1) % ringLen);
      indices[iCursor++] = centroidV + 1 + i;
    }
    vCursor += ringLen + 1;
  }
  return { positions, normals, uvs, indices };
}

export const polygonListToMeshNode: NodeDef = {
  id: 'geom/from-polygon-list',
  category: 'Polygon',
  inputs: [
    {
      name: 'polygons',
      type: 'PolygonList',
      description: 'list of polygons to triangulate (typically a road network or a set of district fills)',
    },
    {
      name: 'y',
      type: 'Float',
      default: 0,
      description: 'world Y the merged mesh sits at',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'a single mesh holding every input polygon\'s triangulation, normal +Y, per-polygon UVs in [0,1] across that polygon\'s bbox. Empty / degenerate polygons are dropped',
    },
  ],
  doc: {
    summary: 'Triangulate every polygon in a PolygonList and merge into one Geometry.',
    description: `
Single-batch counterpart to running
[geom/from-polygon](../../geom/from-polygon) inside a
[iter/for-each-polygon](../../iter/for-each-polygon) body. Useful
when every polygon in the list shares the same material (road
network, district fills, building footprints).

UVs are per-polygon — each gets its own [0, 1] range across its
bounding rect. If you want per-polygon tinting, the instance-on-
points scatter route is the right primitive instead.
`,
    sampleGraph: () => {
      const g = createGraph();
      const aabb = addNode(g, 'poly/aabb', {
        id: 'aabb',
        position: { x: 0, y: 0 },
        inputValues: { center: [0, 0], size: [40, 40] },
      });
      const grid = addNode(g, 'poly/grid-subdivide', {
        id: 'grid',
        position: { x: 280, y: 0 },
        inputValues: { cols: 4, rows: 4 },
      });
      const mesh = addNode(g, 'geom/from-polygon-list', {
        id: 'mesh',
        position: { x: 560, y: 0 },
      });
      addEdge(g, { node: aabb.id, socket: 'polygon' }, { node: grid.id, socket: 'polygon' });
      addEdge(g, { node: grid.id, socket: 'polygons' }, { node: mesh.id, socket: 'polygons' });
      return { graph: g, rootNodeId: 'mesh' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const list = inputs.polygons as PolygonListValue | undefined;
    const y = inputs.y as number;
    const mesh = list ? buildFanMesh(list.polygons, y) : null;
    if (!mesh) {
      // Empty / all-degenerate list — return a zero-area triangle so
      // downstream consumers don't have to null-check. Renderer
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
