import type { NodeDef } from '../core/node-def.js';
import type { MaterialValue, Texture2DValue } from '../core/resources.js';

export const materialNode: NodeDef = {
  id: 'core/material',
  category: 'Materials',
  inputs: [
    { name: 'basecolor', type: 'Texture2D' },
    { name: 'roughness', type: 'Float', default: 0.5 },
    { name: 'metallic', type: 'Float', default: 0 },
  ],
  outputs: [{ name: 'material', type: 'Material' }],
  evaluate(_ctx, inputs): { material: MaterialValue } {
    return {
      material: {
        basecolor: inputs.basecolor as Texture2DValue,
        roughness: inputs.roughness as number,
        metallic: inputs.metallic as number,
      },
    };
  },
};
