import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { generateCube } from '../render/cube.js';
import { uploadMeshToGpu } from '../render/mesh.js';

export const cubeNode: NodeDef = {
  id: 'core/cube',
  category: 'Geometry/Primitives',
  inputs: [
    { name: 'size', type: 'Float', default: 1 },
  ],
  outputs: [{ name: 'geometry', type: 'Geometry' }],
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const mesh = generateCube(inputs.size as number);
    return { geometry: uploadMeshToGpu(device, mesh) };
  },
};
