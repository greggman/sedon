import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue, PointCloudValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { instanceOnPoints, uploadMeshToGpu } from '../render/mesh.js';

export const instanceOnPointsNode: NodeDef = {
  id: 'core/instance-on-points',
  category: 'Geometry/Distribution',
  inputs: [
    { name: 'points', type: 'PointCloud' },
    { name: 'instance', type: 'Geometry' },
    { name: 'scale', type: 'Float', default: 0.1 },
    { name: 'align', type: 'Bool', default: true, description: 'rotate each instance to align local +Y with the point normal' },
  ],
  outputs: [{ name: 'geometry', type: 'Geometry' }],
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const points = inputs.points as PointCloudValue;
    const instanceGeom = inputs.instance as GeometryValue;
    if (!instanceGeom.mesh) {
      throw new Error(
        'core/instance-on-points requires a CPU-side mesh on the instance ' +
          'geometry; the upstream node produced GPU-only data.',
      );
    }
    const realized = instanceOnPoints(
      instanceGeom.mesh,
      points,
      inputs.scale as number,
      inputs.align as boolean,
    );
    return { geometry: uploadMeshToGpu(device, realized) };
  },
};
