import type { NodeDef } from '../core/node-def.js';
import type { MaterialValue, Texture2DValue } from '../core/resources.js';

export const materialNode: NodeDef = {
  id: 'core/material',
  category: 'Materials',
  inputs: [
    { name: 'basecolor', type: 'Texture2D' },
    { name: 'roughness', type: 'Float', default: 0.5 },
    { name: 'metallic', type: 'Float', default: 0 },
    { name: 'normal', type: 'Texture2D', optional: true },
  ],
  outputs: [{ name: 'material', type: 'Material' }],
  evaluate(_ctx, inputs): { material: MaterialValue } {
    const normal = inputs.normal as Texture2DValue | undefined;
    const material: MaterialValue = {
      basecolor: inputs.basecolor as Texture2DValue,
      roughness: inputs.roughness as number,
      metallic: inputs.metallic as number,
    };
    if (normal) material.normal = normal;
    return { material };
  },
};
