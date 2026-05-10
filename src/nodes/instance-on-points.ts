import type { NodeDef } from '../core/node-def.js';
import type {
  FloatCloudValue,
  GeometryValue,
  PointCloudValue,
  Vec3CloudValue,
} from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { instanceOnPoints, uploadMeshToGpu } from '../render/mesh.js';

export const instanceOnPointsNode: NodeDef = {
  id: 'core/instance-on-points',
  category: 'Geometry/Distribution',
  inputs: [
    { name: 'points', type: 'PointCloud' },
    { name: 'instance', type: 'Geometry' },
    { name: 'scale', type: 'Float', default: 0.1 },
    {
      name: 'align',
      type: 'Bool',
      default: true,
      description: 'rotate each instance to align local +Y with the point normal',
    },
    {
      name: 'per_point_scale',
      type: 'Vec3Cloud',
      optional: true,
      description: 'optional per-point per-axis scale, multiplies base scale',
    },
    {
      name: 'per_point_yaw',
      type: 'FloatCloud',
      optional: true,
      description: 'optional per-point rotation around local +Y, in radians',
    },
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
    const perPointScale = inputs.per_point_scale as Vec3CloudValue | undefined;
    const perPointYaw = inputs.per_point_yaw as FloatCloudValue | undefined;
    if (perPointScale && perPointScale.count !== points.count) {
      throw new Error(
        `per_point_scale count (${perPointScale.count}) does not match ` +
          `points count (${points.count})`,
      );
    }
    if (perPointYaw && perPointYaw.count !== points.count) {
      throw new Error(
        `per_point_yaw count (${perPointYaw.count}) does not match ` +
          `points count (${points.count})`,
      );
    }

    const realized = instanceOnPoints(instanceGeom.mesh, points, {
      scale: inputs.scale as number,
      align: inputs.align as boolean,
      ...(perPointScale ? { perPointScale: perPointScale.values } : {}),
      ...(perPointYaw ? { perPointYaw: perPointYaw.values } : {}),
    });
    return { geometry: uploadMeshToGpu(device, realized) };
  },
};
