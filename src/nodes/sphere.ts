import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { uploadMeshToGpu } from '../render/mesh.js';
import { generateSphere } from '../render/sphere.js';

export const sphereNode: NodeDef = {
  id: 'core/sphere',
  category: 'Geometry/Primitives',
  inputs: [
    { name: 'radius', type: 'Float', default: 1 },
    { name: 'segments', type: 'Int', default: 32 },
    { name: 'rings', type: 'Int', default: 16 },
  ],
  outputs: [{ name: 'geometry', type: 'Geometry' }],
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
