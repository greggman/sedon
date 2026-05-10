import type { NodeDef } from '../core/node-def.js';
import type { HeightfieldValue, Texture2DValue } from '../core/resources.js';

// Wrap a Texture2D with world-space metadata so downstream terrain nodes can
// interpret it as a heightfield. Any Texture2D-producing node (Perlin,
// Worley, Blend, Warp, Colorize, etc.) plugs straight in, so the entire
// texture toolkit composes for terrain authoring.
export const heightfieldNode: NodeDef = {
  id: 'core/heightfield',
  category: 'Heightfield/Generators',
  inputs: [
    { name: 'texture', type: 'Texture2D' },
    { name: 'worldSize', type: 'Vec2', default: [10, 10] },
    { name: 'heightRange', type: 'Vec2', default: [0, 2] },
  ],
  outputs: [{ name: 'heightfield', type: 'Heightfield' }],
  evaluate(_ctx, inputs): { heightfield: HeightfieldValue } {
    return {
      heightfield: {
        texture: inputs.texture as Texture2DValue,
        worldSize: inputs.worldSize as [number, number],
        heightRange: inputs.heightRange as [number, number],
      },
    };
  },
};
