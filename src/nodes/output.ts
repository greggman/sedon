import type { NodeDef } from '../core/node-def.js';

export const outputNode: NodeDef = {
  id: 'core/output',
  category: 'IO',
  inputs: [
    { name: 'geometry', type: 'Geometry' },
    { name: 'material', type: 'Material' },
  ],
  // Output's "outputs" are a passthrough of its inputs so the eval root has a
  // well-defined shape. The renderer reads geometry+material off the result.
  outputs: [
    { name: 'geometry', type: 'Geometry' },
    { name: 'material', type: 'Material' },
  ],
  evaluate(_ctx, inputs) {
    return { geometry: inputs.geometry, material: inputs.material };
  },
};
