import type { NodeDef } from '../core/node-def.js';
import type {
  MaterialValue,
  TerrainLayerValue,
  Texture2DValue,
} from '../core/resources.js';

// Multi-layer terrain material. Up to 4 user-defined layers (snow,
// tundra, forest, meadow, rocks, …) blended per pixel by an RGBA splat
// texture: R = layer 0 weight, G = layer 1, B = layer 2, A = layer 3.
// Each layer is a `TerrainLayer` value produced by `terrain/layer`.
//
// Variadic layer sockets follow the same authoring pattern as
// `core/scene-merge`: the node ships with no `layer_*` inputs declared
// at the type level — users add them via the +Add input button (or a
// demo pre-declares them via `extraInputs`), then wire each one to a
// `terrain/layer` instance. Up to 4 are sampled by the shader; extras
// are ignored in v1.
//
// Pair with `core/heightfield-to-mesh` + `core/scene-entity` the same
// way the old 2-layer `core/terrain-material` does. The shader runs
// per-layer PBR shading at each layer's roughness and blends the lit
// results — same blend-after-lighting trick used in `terrain-splat`,
// extended to 4 layers with height-weighted weights.
export const terrainMultiLayerMaterialNode: NodeDef = {
  id: 'terrain/material',
  category: 'Terrain',
  inputs: [
    {
      name: 'splat',
      type: 'Texture2D',
      description:
        'RGBA splat: R/G/B/A = weight for layers 0/1/2/3. Sampled at un-tiled UVs so the splat pattern spans the whole terrain',
    },
    {
      name: 'tile_scale',
      type: 'Vec2',
      default: [1, 1],
      description: 'UV tiling rate for per-layer textures (splat is not tiled)',
    },
    {
      name: 'metallic',
      type: 'Float',
      default: 0,
      description: 'global metallic value applied to every layer (terrain is usually 0)',
    },
    {
      name: 'height_blend_sharpness',
      type: 'Float',
      default: 4,
      description:
        'how strongly each layer\'s height channel biases the blend toward that layer. 0 = pure splat-weighted linear blend; higher = the locally tallest layer wins more sharply',
    },
  ],
  outputs: [{ name: 'material', type: 'Material' }],
  evaluate(_ctx, inputs): { material: MaterialValue } {
    // Variadic: scan inputs for layer_0..layer_3 in order, taking only
    // the contiguous prefix that's actually wired. v1 caps at 4.
    const layers: TerrainLayerValue[] = [];
    for (let i = 0; i < 4; i++) {
      const v = inputs[`layer_${i}`] as TerrainLayerValue | undefined;
      if (v) layers.push(v);
    }
    if (layers.length === 0) {
      throw new Error(
        'terrain/material: at least one layer must be wired (use the + button to add layer_0 and connect a terrain/layer node)',
      );
    }
    return {
      material: {
        kind: 'terrain-multi-layer',
        layers,
        splat: inputs.splat as Texture2DValue,
        tileScale: inputs.tile_scale as [number, number],
        metallic: inputs.metallic as number,
        heightBlendSharpness: inputs.height_blend_sharpness as number,
      },
    };
  },
};
