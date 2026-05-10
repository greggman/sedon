import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { mergeMeshes, uploadMeshToGpu } from '../render/mesh.js';

export const mergeGeometryNode: NodeDef = {
  id: 'core/merge-geometry',
  category: 'Geometry/Composition',
  inputs: [
    { name: 'a', type: 'Geometry' },
    { name: 'b', type: 'Geometry' },
  ],
  outputs: [{ name: 'geometry', type: 'Geometry' }],
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
    return { geometry: uploadMeshToGpu(device, merged) };
  },
};
