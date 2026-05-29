import { addEdge, addNode, createGraph } from '../core/graph.js';
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
    {
      name: 'points',
      type: 'PointCloud',
      description: 'where to place copies. Each point\'s position drives the instance location; its normal drives orientation when `align` is on',
    },
    {
      name: 'instance',
      type: 'Geometry',
      description: 'the source mesh to copy. Must carry CPU-side data (primitives do; the merge bakes vertex data per point)',
    },
    {
      name: 'scale',
      type: 'Float',
      default: 0.1,
      description: 'uniform scale applied to every instance',
    },
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
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'one merged mesh containing a transformed copy of `instance` at every point. CPU-side data is preserved so downstream modifiers can still read vertices',
    },
  ],
  doc: {
    summary: 'CPU-merge a Geometry at every point in a PointCloud → one big Geometry.',
    description: `
For each point, transforms the source mesh by (scale, align-to-normal,
translate-to-point) and concatenates the result into one merged mesh.
The output is a SINGLE Geometry containing every copy's vertices.

Use this when you need a single mesh downstream — for mesh modifiers
(future bend / smooth / boolean), or when "the result is logically one
continuous thing" (a track of ties along a spline, ridges marching up
a hill). For independent scattered OBJECTS that should retain entity
boundaries (forests, debris, rocks), use
[core/instance-scene-on-points](../../core/instance-scene-on-points)
instead — it preserves per-entity identity for instanced rendering and
GPU picking.

Per-point variation comes through the three optional cloud inputs:
- \`per_point_scale\`: Vec3 cloud, multiplies base scale per-axis per
  point. Combine with [core/random-vec3-cloud](../../core/random-vec3-cloud)
  for natural size variation.
- \`per_point_yaw\`: Float cloud, rotation around local +Y per point.
  Pair with [core/random-float-cloud](../../core/random-float-cloud)
  in [0, 2π] for random orientation.
- \`per_point_active\`: Float cloud, mask. Values ≥ 0.5 are realised;
  below are skipped. Pair with [core/cloud-step](../../core/cloud-step)
  on a slope/altitude derived cloud for "scatter only where condition X".
`,
    sampleGraph: () => {
      const g = createGraph();
      // Grid of 64 points → 64 cubes via the instancer. Wireframe
      // preview shows the resulting merged mesh.
      const points = addNode(g, 'core/grid-distribute', {
        id: 'points',
        position: { x: 0, y: 0 },
        inputValues: { cols: 8, rows: 8, spacing: 0.6, jitter: 0, seed: 0 },
      });
      const cube = addNode(g, 'core/cube', {
        id: 'cube',
        position: { x: 0, y: 200 },
        inputValues: { size: 1 },
      });
      const inst = addNode(g, 'core/instance-geometry-on-points', {
        id: 'inst',
        position: { x: 280, y: 100 },
        inputValues: { scale: 0.18, align: true },
      });
      addEdge(g, { node: points.id, socket: 'points' }, { node: inst.id, socket: 'points' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: inst.id, socket: 'instance' });
      return { graph: g, rootNodeId: 'inst' };
    },
  },
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
