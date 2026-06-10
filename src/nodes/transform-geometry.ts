import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { transformMesh, uploadMeshToGpu } from '../render/mesh.js';

export const transformGeometryNode: NodeDef = {
  id: 'geom/transform',
  category: 'Geometry/Modifiers',
  inputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'input mesh to transform (must carry CPU-side vertex data — primitive nodes always do)',
    },
    {
      name: 'translate',
      type: 'Vec3',
      default: [0, 0, 0],
      description: 'world-space offset added to every vertex',
    },
    {
      name: 'rotate',
      type: 'Vec3',
      default: [0, 0, 0],
      description: 'Euler rotation in radians (X, Y, Z order). Applied around the mesh origin BEFORE the translation',
    },
    {
      name: 'scale',
      type: 'Vec3',
      default: [1, 1, 1],
      description: 'per-axis scale factor. Applied first (before rotation), centred on the mesh origin. Non-uniform values stretch the mesh',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'the input mesh with scale → rotate → translate applied to every vertex (and the appropriate normal transform applied to its normals)',
    },
  ],
  doc: {
    summary: 'Translate / rotate / scale a mesh in world space.',
    description: `
Applies a standard scale → rotate → translate transform to every vertex
of the input mesh, with the matching inverse-transpose applied to the
normals so lighting still works after a non-uniform scale. Rotation order
is X then Y then Z (so \`rotate.y\` is yaw, \`rotate.x\` is pitch when
applied on its own).

Use to position primitive meshes ([geom/cube](../../geom/cube),
[geom/sphere](../../geom/sphere), …) before merging into a scene, to
non-uniformly stretch a cube into a box, or to scale a procedural mesh by
a noise-driven Float (run through
[math/map-range](../../math/map-range) into a Vec3 first) for per-instance
variation.
`,
    sampleGraph: () => {
      const g = createGraph();
      const cube = addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 0, y: 0 },
        inputValues: { size: 1 },
      });
      const tx = addNode(g, 'geom/transform', {
        id: 'transform-geometry',
        position: { x: 280, y: 0 },
        inputValues: { translate: [0, 0.5, 0], rotate: [0, 0.5, 0], scale: [2, 0.5, 1] },
      });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: tx.id, socket: 'geometry' });
      return { graph: g, rootNodeId: 'transform-geometry' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const input = inputs.geometry as GeometryValue;
    if (!input.mesh) {
      throw new Error(
        'geom/transform requires a CPU-side mesh on the input geometry; ' +
          'this source produced GPU-only data.',
      );
    }
    const transformed = transformMesh(
      input.mesh,
      inputs.translate as [number, number, number],
      inputs.rotate as [number, number, number],
      inputs.scale as [number, number, number],
    );
    return {
      geometry: uploadMeshToGpu(device, transformed, ctx.previousOutput?.geometry as GeometryValue | undefined),
    };
  },
};
