import type { NodeDef } from '../core/node-def.js';

export const colorNode: NodeDef = {
  id: 'core/color',
  category: 'Constants',
  inputs: [
    { name: 'value', type: 'Color', default: [1, 1, 1, 1] },
  ],
  outputs: [
    { name: 'color', type: 'Color' },
  ],
  evaluate(_ctx, inputs) {
    return { color: inputs.value };
  },
};
