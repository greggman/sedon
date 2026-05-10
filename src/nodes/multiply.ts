import type { NodeDef } from '../core/node-def.js';

export const multiplyNode: NodeDef = {
  id: 'core/multiply',
  category: 'Math',
  inputs: [
    { name: 'a', type: 'Float', default: 1 },
    { name: 'b', type: 'Float', default: 1 },
  ],
  outputs: [{ name: 'result', type: 'Float' }],
  evaluate(_ctx, inputs) {
    return { result: (inputs.a as number) * (inputs.b as number) };
  },
};
