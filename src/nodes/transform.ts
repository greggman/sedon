import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { transformMesh, uploadMeshToGpu } from '../render/mesh.js';

export const transformNode: NodeDef = {
  id: 'core/transform',
  category: 'Geometry/Modifiers',
  inputs: [
    { name: 'geometry', type: 'Geometry' },
    { name: 'translate', type: 'Vec3', default: [0, 0, 0] },
    { name: 'rotate', type: 'Vec3', default: [0, 0, 0] },
    { name: 'scale', type: 'Vec3', default: [1, 1, 1] },
  ],
  outputs: [{ name: 'geometry', type: 'Geometry' }],
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const input = inputs.geometry as GeometryValue;
    if (!input.mesh) {
      throw new Error(
        'core/transform requires a CPU-side mesh on the input geometry; ' +
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
