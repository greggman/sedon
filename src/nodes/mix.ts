import type { NodeDef } from '../core/node-def.js';

function asColor(v: unknown): [number, number, number, number] {
  if (!Array.isArray(v) || v.length !== 4) {
    throw new Error('expected Color (length-4 array)');
  }
  return v as [number, number, number, number];
}

function asFloat(v: unknown): number {
  if (typeof v !== 'number') {
    throw new Error('expected Float (number)');
  }
  return v;
}

export const mixNode: NodeDef = {
  id: 'core/mix',
  category: 'Math',
  inputs: [
    { name: 'a', type: 'Color', default: [0, 0, 0, 1] },
    { name: 'b', type: 'Color', default: [1, 1, 1, 1] },
    { name: 'factor', type: 'Float', default: 0.5 },
  ],
  outputs: [
    { name: 'result', type: 'Color' },
  ],
  evaluate(_ctx, inputs) {
    const a = asColor(inputs.a);
    const b = asColor(inputs.b);
    const t = asFloat(inputs.factor);
    return {
      result: [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
        a[3] + (b[3] - a[3]) * t,
      ],
    };
  },
};
