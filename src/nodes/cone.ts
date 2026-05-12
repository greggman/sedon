import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { generateCone } from '../render/cone.js';
import { uploadMeshToGpu } from '../render/mesh.js';

export const coneNode: NodeDef = {
  id: 'core/cone',
  category: 'Geometry/Primitives',
  inputs: [
    { name: 'radius', type: 'Float', default: 0.5 },
    { name: 'height', type: 'Float', default: 1 },
    { name: 'segments', type: 'Int', default: 16 },
  ],
  outputs: [{ name: 'geometry', type: 'Geometry' }],
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const mesh = generateCone(
      inputs.radius as number,
      inputs.height as number,
      inputs.segments as number,
    );
    return {
      geometry: uploadMeshToGpu(device, mesh, ctx.previousOutput?.geometry as GeometryValue | undefined),
    };
  },
};
