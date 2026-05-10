import type { NodeDef } from '../core/node-def.js';
import type { MaterialValue, Texture2DValue } from '../core/resources.js';

// Two-layer splat-painted terrain material. Each layer brings its own
// basecolor + roughness; the mask's red channel selects between them per
// pixel (0 = layer A, 1 = layer B). Pair with core/slope-from-height to
// route grass to flats and rock to steeps; pair with the heightfield
// texture itself for altitude-based snow/grass; or compose your own mask
// via blend / colorize / step-from-tex.
//
// This is the v1 of the terrain-splat material kind. Multi-layer (4+),
// per-layer normals, triplanar projection, and heightblend transitions are
// the natural extensions but out of scope for the initial seam.
export const terrainMaterialNode: NodeDef = {
  id: 'core/terrain-material',
  category: 'Materials',
  inputs: [
    { name: 'layer_a', type: 'Texture2D', description: 'basecolor where mask is 0' },
    { name: 'layer_b', type: 'Texture2D', description: 'basecolor where mask is 1' },
    { name: 'mask', type: 'Texture2D', description: 'R channel selects between layers' },
    { name: 'roughness_a', type: 'Float', default: 0.9 },
    { name: 'roughness_b', type: 'Float', default: 0.7 },
  ],
  outputs: [{ name: 'material', type: 'Material' }],
  evaluate(_ctx, inputs): { material: MaterialValue } {
    return {
      material: {
        kind: 'terrain-splat',
        layerA: inputs.layer_a as Texture2DValue,
        layerB: inputs.layer_b as Texture2DValue,
        mask: inputs.mask as Texture2DValue,
        roughnessA: inputs.roughness_a as number,
        roughnessB: inputs.roughness_b as number,
      },
    };
  },
};
