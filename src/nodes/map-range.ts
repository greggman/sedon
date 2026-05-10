import type { NodeDef } from '../core/node-def.js';

// Remaps `value` from [in_min, in_max] to [out_min, out_max] linearly. With
// `clamp` true, the output is bounded to the output range; without, values
// outside the input range extrapolate.
export const mapRangeNode: NodeDef = {
  id: 'core/map-range',
  category: 'Math',
  inputs: [
    { name: 'value', type: 'Float', default: 0 },
    { name: 'in_min', type: 'Float', default: 0 },
    { name: 'in_max', type: 'Float', default: 1 },
    { name: 'out_min', type: 'Float', default: 0 },
    { name: 'out_max', type: 'Float', default: 1 },
    { name: 'clamp', type: 'Bool', default: false },
  ],
  outputs: [{ name: 'result', type: 'Float' }],
  evaluate(_ctx, inputs) {
    const v = inputs.value as number;
    const inMin = inputs.in_min as number;
    const inMax = inputs.in_max as number;
    const outMin = inputs.out_min as number;
    const outMax = inputs.out_max as number;
    const clamp = inputs.clamp as boolean;

    const range = inMax - inMin;
    // Pathological in_min === in_max: return out_min for value==in_min, otherwise
    // pin to whichever output side dominates.
    const t = range === 0 ? 0 : (v - inMin) / range;
    const tClamped = clamp ? Math.max(0, Math.min(1, t)) : t;
    return { result: outMin + tClamped * (outMax - outMin) };
  },
};
