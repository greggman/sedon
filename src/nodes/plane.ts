import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { uploadMeshToGpu } from '../render/mesh.js';
import { generatePlane } from '../render/plane.js';

export const planeNode: NodeDef = {
  id: 'core/plane',
  category: 'Geometry/Primitives',
  inputs: [
    { name: 'size', type: 'Vec2', default: [4, 4] },
    { name: 'divisions', type: 'Vec2i', default: [4, 4] },
  ],
  outputs: [{ name: 'geometry', type: 'Geometry' }],
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const size = inputs.size as [number, number];
    const divisions = inputs.divisions as [number, number];
    const mesh = generatePlane(
      size[0],
      size[1],
      Math.max(1, Math.round(divisions[0])),
      Math.max(1, Math.round(divisions[1])),
    );
    return { geometry: uploadMeshToGpu(device, mesh) };
  },
};
