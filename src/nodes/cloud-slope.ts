import type { NodeDef } from '../core/node-def.js';
import type { FloatCloudValue, PointCloudValue } from '../core/resources.js';

// Slope angle (radians) at each point: angle between the point normal and
// world up. 0 = flat, π/2 ≈ vertical wall.
export const cloudSlopeNode: NodeDef = {
  id: 'core/cloud-slope',
  category: 'Distribution/Attributes',
  inputs: [{ name: 'points', type: 'PointCloud' }],
  outputs: [{ name: 'values', type: 'FloatCloud' }],
  evaluate(_ctx, inputs): { values: FloatCloudValue } {
    const points = inputs.points as PointCloudValue;
    if (!points.normals) {
      throw new Error('core/cloud-slope requires the input PointCloud to have normals');
    }
    const count = points.count;
    const values = new Float32Array(count);
    const n = points.normals;
    for (let i = 0; i < count; i++) {
      const ny = n[i * 3 + 1]!;
      // Clamp before acos to avoid NaN from float drift on near-up normals.
      values[i] = Math.acos(Math.max(-1, Math.min(1, ny)));
    }
    return { values: { count, values } };
  },
};
