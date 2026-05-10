import type { NodeDef } from '../core/node-def.js';
import type { FloatCloudValue, PointCloudValue } from '../core/resources.js';

export const cloudAltitudeNode: NodeDef = {
  id: 'core/cloud-altitude',
  category: 'Distribution/Attributes',
  inputs: [{ name: 'points', type: 'PointCloud' }],
  outputs: [{ name: 'values', type: 'FloatCloud' }],
  evaluate(_ctx, inputs): { values: FloatCloudValue } {
    const points = inputs.points as PointCloudValue;
    const count = points.count;
    const values = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      values[i] = points.positions[i * 3 + 1]!;
    }
    return { values: { count, values } };
  },
};
