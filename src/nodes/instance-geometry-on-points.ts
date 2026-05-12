import type { NodeDef } from '../core/node-def.js';
import type {
  FloatCloudValue,
  GeometryValue,
  PointCloudValue,
  Vec3CloudValue,
} from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { instanceOnPoints, uploadMeshToGpu } from '../render/mesh.js';

// CPU-merge a single Geometry at every point in a PointCloud, returning one
// big merged Geometry. Use this when you need a single mesh downstream — for
// mesh modifiers (bend, smooth, boolean), or when "the result is logically
// one continuous thing" (a track of ties along a spline). For independent
// scattered objects (forests, debris) use core/instance-scene-on-points
// instead — it preserves entity boundaries for instanced rendering.
export const instanceGeometryOnPointsNode: NodeDef = {
  id: 'core/instance-geometry-on-points',
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
    {
      name: 'per_point_active',
      type: 'FloatCloud',
      optional: true,
      description: 'optional per-point activation mask; only values >= 0.5 are realized',
    },
  ],
  outputs: [{ name: 'geometry', type: 'Geometry' }],
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const points = inputs.points as PointCloudValue;
    const instanceGeom = inputs.instance as GeometryValue;
    if (!instanceGeom.mesh) {
      throw new Error(
        'core/instance-geometry-on-points requires a CPU-side mesh on the ' +
          'instance geometry; the upstream node produced GPU-only data.',
      );
    }
    const perPointScale = inputs.per_point_scale as Vec3CloudValue | undefined;
    const perPointYaw = inputs.per_point_yaw as FloatCloudValue | undefined;
    const perPointActive = inputs.per_point_active as FloatCloudValue | undefined;
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
    if (perPointActive && perPointActive.count !== points.count) {
      throw new Error(
        `per_point_active count (${perPointActive.count}) does not match ` +
          `points count (${points.count})`,
      );
    }

    const realized = instanceOnPoints(instanceGeom.mesh, points, {
      scale: inputs.scale as number,
      align: inputs.align as boolean,
      ...(perPointScale ? { perPointScale: perPointScale.values } : {}),
      ...(perPointYaw ? { perPointYaw: perPointYaw.values } : {}),
      ...(perPointActive ? { perPointActive: perPointActive.values } : {}),
    });
    return {
      geometry: uploadMeshToGpu(device, realized, ctx.previousOutput?.geometry as GeometryValue | undefined),
    };
  },
};
