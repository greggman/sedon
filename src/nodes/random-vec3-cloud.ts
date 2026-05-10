import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue, Vec3CloudValue } from '../core/resources.js';

// Sin-based hash. Cheap; deterministic from (i, seed); good enough for
// "per-instance variation" purposes.
function hash3(i: number, seed: number): [number, number, number] {
  const a = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453123;
  const b = Math.sin(i * 39.346 + seed * 11.135) * 24634.6345;
  const c = Math.sin(i * 17.371 + seed * 51.853) * 31987.4321;
  return [a - Math.floor(a), b - Math.floor(b), c - Math.floor(c)];
}

export const randomVec3CloudNode: NodeDef = {
  id: 'core/random-vec3-cloud',
  category: 'Distribution/Attributes',
  inputs: [
    { name: 'points', type: 'PointCloud' },
    { name: 'min', type: 'Vec3', default: [0, 0, 0] },
    { name: 'max', type: 'Vec3', default: [1, 1, 1] },
    { name: 'seed', type: 'Float', default: 0 },
  ],
  outputs: [{ name: 'values', type: 'Vec3Cloud' }],
  evaluate(_ctx, inputs): { values: Vec3CloudValue } {
    const points = inputs.points as PointCloudValue;
    const min = inputs.min as [number, number, number];
    const max = inputs.max as [number, number, number];
    const seed = inputs.seed as number;

    const count = points.count;
    const values = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const [rx, ry, rz] = hash3(i, seed);
      values[i * 3]     = min[0] + rx * (max[0] - min[0]);
      values[i * 3 + 1] = min[1] + ry * (max[1] - min[1]);
      values[i * 3 + 2] = min[2] + rz * (max[2] - min[2]);
    }

    return { values: { count, values } };
  },
};
