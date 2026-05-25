import type { NodeDef } from '../core/node-def.js';
import type { TerrainLayerValue, Texture2DValue } from '../core/resources.js';

// One layer for a multi-layer terrain material. Pair N of these (snow,
// tundra, forest, meadow, rocks, …) with a `terrain/material` node and a
// splat texture that paints their per-pixel weights.
//
// Only `albedo` is required. Wiring `normal`, `height`, and `roughness`
// is incremental — a layer with just albedo renders fine (flat normal,
// neutral height, default roughness 0.6). The `height` channel matters
// when the splat blends two neighbours: a higher local height wins the
// blend ("painted" transitions instead of cross-fades). Roughness lets
// wet rock and dry grass have different specular response in the same
// terrain without separate scene entities.
export const terrainLayerNode: NodeDef = {
  id: 'terrain/layer',
  category: 'Terrain',
  inputs: [
    {
      name: 'albedo',
      type: 'Texture2D',
      description: 'sRGB basecolor for this layer',
    },
    {
      name: 'normal',
      type: 'Texture2D',
      optional: true,
      description: 'tangent-space normal map (falls back to flat if unwired)',
    },
    {
      name: 'height',
      type: 'Texture2D',
      optional: true,
      description: 'greyscale height for height-weighted blending (0.5 if unwired)',
    },
    {
      name: 'roughness',
      type: 'Texture2D',
      optional: true,
      description: 'greyscale roughness map (0.6 grey if unwired)',
    },
  ],
  outputs: [{ name: 'layer', type: 'TerrainLayer' }],
  evaluate(_ctx, inputs): { layer: TerrainLayerValue } {
    const normal = inputs.normal as Texture2DValue | undefined;
    const height = inputs.height as Texture2DValue | undefined;
    const roughness = inputs.roughness as Texture2DValue | undefined;
    const layer: TerrainLayerValue = {
      albedo: inputs.albedo as Texture2DValue,
    };
    if (normal) layer.normal = normal;
    if (height) layer.height = height;
    if (roughness) layer.roughness = roughness;
    return { layer };
  },
};
