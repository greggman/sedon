import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { uploadMeshToGpu } from '../render/mesh.js';
import { generateSphere } from '../render/sphere.js';

export const sphereNode: NodeDef = {
  id: 'geom/sphere',
  category: 'Geometry/Primitives',
  inputs: [
    {
      name: 'radius',
      type: 'Float',
      default: 1,
      description: 'world-space radius',
    },
    {
      name: 'segments',
      type: 'Int',
      default: 32,
      min: 2,
      description: 'longitudinal subdivisions (around the equator). More = smoother silhouette; 16 reads as faceted, 64 is essentially smooth',
    },
    {
      name: 'rings',
      type: 'Int',
      default: 16,
      min: 2,
      description: 'latitudinal subdivisions (pole to pole). Usually half the segment count looks balanced',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'a UV sphere mesh centred at the origin, ready to wire into [scene/entity](../../scene/entity) or [geom/instance-on-points](../../geom/instance-on-points)',
    },
  ],
  doc: {
    summary: 'A UV-sphere primitive mesh.',
    description: `
The classic longitude/latitude sphere. Generates triangle strips from
\`rings\` × \`segments\` vertices on a unit sphere, scaled by \`radius\`.
Pinches at the poles like every UV sphere does — for cases where that
matters (close-up shading, even tessellation), an icosphere generator
would be a better choice; this one trades that for predictable UV layout.

Wire the output into a [scene/entity](../../scene/entity) to give
it a material and place it in a scene, into
[geom/instance-on-points](../../geom/instance-on-points)
to scatter copies across a point cloud, or into
[geom/merge](../../geom/merge) to combine with other
meshes before instancing.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'geom/sphere', {
        id: 'sphere',
        position: { x: 0, y: 0 },
        inputValues: { radius: 1, segments: 32, rings: 16 },
      });
      return { graph: g, rootNodeId: 'sphere' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const mesh = generateSphere(
      inputs.radius as number,
      inputs.segments as number,
      inputs.rings as number,
    );
    return {
      geometry: uploadMeshToGpu(device, mesh, ctx.previousOutput?.geometry as GeometryValue | undefined),
    };
  },
};
