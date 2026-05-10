import type { NodeDef } from '../core/node-def.js';
import type { FloatCloudValue, PointCloudValue } from '../core/resources.js';

function hash1(i: number, seed: number): number {
  const a = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453123;
  return a - Math.floor(a);
}

export const randomFloatCloudNode: NodeDef = {
  id: 'core/random-float-cloud',
  category: 'Distribution/Attributes',
  inputs: [
    { name: 'points', type: 'PointCloud' },
    { name: 'min', type: 'Float', default: 0 },
    { name: 'max', type: 'Float', default: 1 },
    { name: 'seed', type: 'Float', default: 0 },
  ],
  outputs: [{ name: 'values', type: 'FloatCloud' }],
  evaluate(_ctx, inputs): { values: FloatCloudValue } {
    const points = inputs.points as PointCloudValue;
    const min = inputs.min as number;
    const max = inputs.max as number;
    const seed = inputs.seed as number;

    const count = points.count;
    const values = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      values[i] = min + hash1(i, seed) * (max - min);
    }

    return { values: { count, values } };
  },
};
