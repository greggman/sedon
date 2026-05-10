import type { NodeDef } from '../core/node-def.js';
import type { FloatCloudValue } from '../core/resources.js';

// Convert per-point analog values to a binary 0/1 mask via a threshold. With
// `invert`, the comparison flips so you can pick either side of the threshold.
export const cloudStepNode: NodeDef = {
  id: 'core/cloud-step',
  category: 'Distribution/Attributes',
  inputs: [
    { name: 'values', type: 'FloatCloud' },
    { name: 'threshold', type: 'Float', default: 0.5 },
    { name: 'invert', type: 'Bool', default: false },
  ],
  outputs: [{ name: 'mask', type: 'FloatCloud' }],
  evaluate(_ctx, inputs): { mask: FloatCloudValue } {
    const cloud = inputs.values as FloatCloudValue;
    const threshold = inputs.threshold as number;
    const invert = inputs.invert as boolean;
    const count = cloud.count;
    const mask = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const above = cloud.values[i]! >= threshold;
      mask[i] = (above !== invert) ? 1 : 0;
    }
    return { mask: { count, values: mask } };
  },
};
