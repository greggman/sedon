import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { computeAabb } from './points-aabb.js';

// Measure the LOCAL-space axis-aligned bounding box of a Geometry.
// Outputs min / max / centre / size — all Vec3s.
//
// "Local space" because the AABB is over the mesh's vertex positions
// as authored, BEFORE any per-entity transform a scene/entity might
// apply. For the post-transform world-space AABB of a scene, use
// scene/aabb instead.
//
// Requires CPU-side mesh data. Compute-only meshes (geometry produced
// purely on the GPU with no readback) emit a zero AABB — same fail-
// soft contract as other CPU-only modifiers (geom/bevel, geom/inset).

export const geomAabbNode: NodeDef = {
  id: 'geom/aabb',
  category: 'Geometry/Measure',
  inputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'mesh to measure (must carry CPU-side vertex data)',
    },
  ],
  outputs: [
    { name: 'min',    type: 'Vec3', description: 'component-wise minimum across every vertex (local space)' },
    { name: 'max',    type: 'Vec3', description: 'component-wise maximum across every vertex (local space)' },
    { name: 'centre', type: 'Vec3', description: '(min + max) / 2 — the AABB centre' },
    { name: 'size',   type: 'Vec3', description: 'max − min — the AABB extents per axis' },
  ],
  doc: {
    summary: 'Local-space axis-aligned bounding box of a Geometry.',
    description: `
Sweeps every vertex of the mesh once to find the component-wise min
and max in LOCAL space. The "fit to" / "centre on" / "scale by
extent" patterns all want one of the four outputs.

Pairs with [math/floats-from-vec3](../../math/floats-from-vec3) when
you need a single axis — e.g. \`size\` → split → take \`x\` → derive
a uniform scale that fits the mesh into a target width.

Requires CPU-side vertex data. GPU-only geometry (rare today — only
some advanced compute-only emitters) emits a zero AABB.
`,
    sampleGraph: () => {
      const g = createGraph();
      const cube = addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 0, y: 0 },
        inputValues: { size: 2 },
      });
      const bb = addNode(g, 'geom/aabb', {
        id: 'bb',
        position: { x: 280, y: 0 },
      });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: bb.id, socket: 'geometry' });
      return { graph: g, rootNodeId: 'bb' };
    },
  },
  evaluate(_ctx, inputs): {
    min: [number, number, number];
    max: [number, number, number];
    centre: [number, number, number];
    size: [number, number, number];
  } {
    const geom = inputs.geometry as GeometryValue | undefined;
    const positions = geom?.mesh?.positions;
    const count = positions ? positions.length / 3 : 0;
    return computeAabb(positions, count);
  },
};
