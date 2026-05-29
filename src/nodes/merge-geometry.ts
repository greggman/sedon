import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { mergeMeshes, uploadMeshToGpu } from '../render/mesh.js';

export const mergeGeometryNode: NodeDef = {
  id: 'core/merge-geometry',
  category: 'Geometry/Composition',
  inputs: [
    {
      name: 'a',
      type: 'Geometry',
      description: 'first input mesh',
    },
    {
      name: 'b',
      type: 'Geometry',
      description: 'second input mesh',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'the two input meshes combined into one Geometry — a\'s vertices first, then b\'s, with b\'s indices offset so they reference the right vertices',
    },
  ],
  doc: {
    summary: 'Combine two meshes into a single Geometry.',
    description: `
Concatenates two meshes into one. The vertex / normal / UV / index
arrays from both inputs are joined, with the second mesh's indices
shifted to point at the right vertices in the merged array. Each input
keeps its own per-vertex data — no re-tessellation, no overlap
resolution, just "draw both at once".

Use when you want a single Geometry output that contains multiple
primitives — e.g. a tree-trunk [core/cylinder](../../core/cylinder) merged
with a leaf-canopy [core/cone](../../core/cone) before scattering copies
via
[core/instance-geometry-on-points](../../core/instance-geometry-on-points).
The merged mesh draws in one call instead of two, and the instancer only
needs to track one source. For more than two meshes, chain multiple
merges together.
`,
    sampleGraph: () => {
      const g = createGraph();
      const sphere = addNode(g, 'core/sphere', {
        id: 'sphere',
        position: { x: 0, y: 0 },
        inputValues: { radius: 0.4, segments: 24, rings: 12 },
      });
      const cube = addNode(g, 'core/cube', {
        id: 'cube',
        position: { x: 0, y: 220 },
        inputValues: { size: 0.6 },
      });
      const merge = addNode(g, 'core/merge-geometry', {
        id: 'merge',
        position: { x: 280, y: 110 },
        inputValues: {},
      });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: merge.id, socket: 'a' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: merge.id, socket: 'b' });
      return { graph: g, rootNodeId: 'merge' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const a = inputs.a as GeometryValue;
    const b = inputs.b as GeometryValue;
    if (!a.mesh || !b.mesh) {
      throw new Error(
        'core/merge-geometry requires CPU-side meshes on both inputs; one of ' +
          'the upstream nodes produced GPU-only data.',
      );
    }
    const merged = mergeMeshes(a.mesh, b.mesh);
    return {
      geometry: uploadMeshToGpu(device, merged, ctx.previousOutput?.geometry as GeometryValue | undefined),
    };
  },
};
