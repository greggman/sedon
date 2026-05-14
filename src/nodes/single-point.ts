import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue } from '../core/resources.js';

// One-point PointCloud at a user-provided position. Useful when you need
// `core/instance-scene-on-points` to drop a single scene at a specific
// world-space location — e.g. placing each species at its own offset in a
// "tree family" demo where there's no Scene-level transform node yet.
export const singlePointNode: NodeDef = {
  id: 'core/single-point',
  category: 'Geometry/Distribution',
  inputs: [
    { name: 'position', type: 'Vec3', default: [0, 0, 0] },
    {
      name: 'normal',
      type: 'Vec3',
      default: [0, 1, 0],
      description: 'surface normal at the point (drives align-to-normal in downstream scatter)',
    },
  ],
  outputs: [{ name: 'points', type: 'PointCloud' }],
  evaluate(_ctx, inputs): { points: PointCloudValue } {
    const pos = inputs.position as [number, number, number];
    const norm = inputs.normal as [number, number, number];
    return {
      points: {
        positions: new Float32Array([pos[0], pos[1], pos[2]]),
        normals: new Float32Array([norm[0], norm[1], norm[2]]),
        count: 1,
      },
    };
  },
};
