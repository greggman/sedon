import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { generateCube } from '../render/cube.js';
import { uploadMeshToGpu } from '../render/mesh.js';

export const cubeNode: NodeDef = {
  id: 'geom/cube',
  category: 'Geometry/Primitives',
  inputs: [
    {
      name: 'size',
      type: 'Float',
      default: 1,
      description: 'edge length. The cube is centred on the origin and extends ±size/2 along each axis',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'an axis-aligned cube mesh with per-face normals and standard cube-map UVs',
    },
  ],
  doc: {
    summary: 'An axis-aligned cube primitive mesh.',
    description: `
The simplest primitive: 6 faces, 12 triangles, hard edges. Centred at the
origin, axis-aligned, with per-face normals so it shades crisply (no
averaged vertex normals smoothing the corners off).

Use as a stand-in for buildings, crates, or any other rectangular shape;
wire through [geom/transform](../../geom/transform) to scale it
non-uniformly into a box, or feed into
[geom/instance-on-points](../../geom/instance-on-points)
to scatter blocks across a point cloud.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 0, y: 0 },
        inputValues: { size: 1 },
      });
      return { graph: g, rootNodeId: 'cube' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const mesh = generateCube(inputs.size as number);
    return {
      geometry: uploadMeshToGpu(device, mesh, ctx.previousOutput?.geometry as GeometryValue | undefined),
    };
  },
};
