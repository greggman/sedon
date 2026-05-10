import type { NodeDef } from '../core/node-def.js';
import type { FloatCloudValue } from '../core/resources.js';

// Element-wise multiply two FloatClouds. For binary masks (0/1 values) this
// is logical AND. Useful when several filters need to compose: e.g. "trees
// only where slope is gentle AND altitude is below 1.0" stacks two cloud-step
// outputs through a cloud-multiply.
export const cloudMultiplyNode: NodeDef = {
  id: 'core/cloud-multiply',
  category: 'Distribution/Attributes',
  inputs: [
    { name: 'a', type: 'FloatCloud' },
    { name: 'b', type: 'FloatCloud' },
  ],
  outputs: [{ name: 'values', type: 'FloatCloud' }],
  evaluate(_ctx, inputs): { values: FloatCloudValue } {
    const a = inputs.a as FloatCloudValue;
    const b = inputs.b as FloatCloudValue;
    if (a.count !== b.count) {
      throw new Error(
        `core/cloud-multiply count mismatch: a=${a.count}, b=${b.count}`,
      );
    }
    const count = a.count;
    const values = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      values[i] = a.values[i]! * b.values[i]!;
    }
    return { values: { count, values } };
  },
};
