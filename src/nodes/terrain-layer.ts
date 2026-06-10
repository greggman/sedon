import { addEdge, addNode, createGraph } from '../core/graph.js';
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
  outputs: [
    {
      name: 'layer',
      type: 'TerrainLayer',
      description: 'a layer bundle — consumed by [terrain/material](../../terrain/material) (which takes up to 4 of them)',
    },
  ],
  doc: {
    summary: 'One layer (albedo + optional normal / height / roughness) for a multi-layer terrain material.',
    description: `
Pairs N of these (snow, tundra, forest, meadow, rocks, …) with a
[terrain/material](../../terrain/material) node and a splat texture
that paints their per-pixel weights.

Only \`albedo\` is required. Wiring \`normal\`, \`height\`, and
\`roughness\` is incremental — a layer with just albedo renders fine
(flat normal, neutral height, default roughness 0.6).

The \`height\` channel matters when the splat blends two neighbouring
layers: a higher local height wins the blend, which produces "painted"
transitions (cobblestones poking through grass) instead of cross-fades.
The \`roughness\` map lets wet rock and dry grass have different
specular response in the same terrain without separate scene entities.
`,
    sampleGraph: () => {
      const g = createGraph();
      // Standalone preview: one layer is just a holder for textures;
      // it doesn't render on its own, but pairing it with the existing
      // terrain/material preview pipeline gives docs visitors something
      // visual. Here a flat green albedo + perlin normal map shows the
      // shading variation a single layer would contribute.
      const albedo = addNode(g, 'tex/solid-color', {
        id: 'albedo',
        position: { x: 0, y: 0 },
        inputValues: { color: [0.28, 0.46, 0.18, 1], resolution: 32 },
      });
      const noise = addNode(g, 'tex/perlin', {
        id: 'noise',
        position: { x: 0, y: 200 },
        inputValues: { scale: [8, 8], octaves: 4, lacunarity: 2, gain: 0.5, seed: 0, resolution: 256 },
      });
      const normalMap = addNode(g, 'tex/normal-from-height', {
        id: 'normal',
        position: { x: 280, y: 200 },
        inputValues: { strength: 3, resolution: 256 },
      });
      const layer = addNode(g, 'terrain/layer', {
        id: 'layer',
        position: { x: 560, y: 100 },
        inputValues: {},
      });
      addEdge(g, { node: noise.id, socket: 'texture' }, { node: normalMap.id, socket: 'height' });
      addEdge(g, { node: albedo.id, socket: 'texture' }, { node: layer.id, socket: 'albedo' });
      addEdge(g, { node: normalMap.id, socket: 'texture' }, { node: layer.id, socket: 'normal' });
      return { graph: g, rootNodeId: 'layer' };
    },
  },
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
