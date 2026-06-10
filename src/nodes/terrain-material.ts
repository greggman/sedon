import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { MaterialValue, Texture2DValue } from '../core/resources.js';

// Two-layer splat-painted terrain material. Each layer brings its own
// basecolor + roughness; the mask's red channel selects between them per
// pixel (0 = layer A, 1 = layer B). Pair with tex/slope-from-height to
// route grass to flats and rock to steeps; pair with the heightfield
// texture itself for altitude-based snow/grass; or compose your own mask
// via blend / colorize / step-from-tex.
//
// This is the v1 of the terrain-splat material kind. Multi-layer (4+),
// per-layer normals, triplanar projection, and heightblend transitions are
// the natural extensions but out of scope for the initial seam.
export const terrainMaterialNode: NodeDef = {
  id: 'material/terrain',
  category: 'Materials',
  inputs: [
    { name: 'layer_a', type: 'Texture2D', description: 'basecolor where mask is 0' },
    { name: 'layer_b', type: 'Texture2D', description: 'basecolor where mask is 1' },
    { name: 'mask', type: 'Texture2D', description: 'R channel selects between layers' },
    { name: 'roughness_a', type: 'Float', default: 0.9 },
    { name: 'roughness_b', type: 'Float', default: 0.7 },
    {
      name: 'tile_scale',
      type: 'Vec2',
      default: [1, 1],
      description: 'tile rate for layers (mask is not tiled, so the splat follows terrain shape)',
    },
    {
      name: 'normal_a',
      type: 'Texture2D',
      optional: true,
      description: 'tangent-space normal map for layer A; falls back to flat if unwired',
    },
    {
      name: 'normal_b',
      type: 'Texture2D',
      optional: true,
      description: 'tangent-space normal map for layer B; falls back to flat if unwired',
    },
  ],
  outputs: [
    {
      name: 'material',
      type: 'Material',
      description: 'two-layer terrain-splat material; consumed by [terrain/renderer](../../terrain/renderer) or by an ordinary [scene/entity](../../scene/entity) on top of a heightfield mesh',
    },
  ],
  doc: {
    summary: 'Two-layer splat-painted terrain material — grass / rock on the same surface.',
    description: `
The basic terrain authoring move: two basecolor textures (grass and
rock, say), one mask that picks which one shows where, plus per-layer
roughness and optional per-layer normal maps.

The mask's red channel selects between layers per pixel — 0 = layer A,
1 = layer B, intermediate values blend smoothly. Common mask sources:

- [tex/slope-from-height](../../tex/slope-from-height) routes grass
  to flats and rock to steeps.
- The heightfield texture itself routes by altitude (snow up high,
  forest mid, beach low).
- A composed [tex/blend](../../tex/blend) /
  [tex/colorize](../../tex/colorize) chain authors the splat by
  hand.

\`tile_scale\` tiles the two BASECOLOR samples at a tighter rate than
the mask — so the splat boundary follows the terrain shape (large
features) while the grass/rock textures themselves repeat densely for
close-up detail. For more than two layers, reach for
[core/terrain-multi-layer-material](../../core/terrain-multi-layer-material)
instead.
`,
    sampleGraph: () => {
      const g = createGraph();
      // Two flat colours stand in for grass + rock textures; a perlin
      // noise mask routes them across the surface.
      const grassCol = addNode(g, 'tex/solid-color', {
        id: 'grass',
        position: { x: 0, y: 0 },
        inputValues: { color: [0.28, 0.46, 0.18, 1], resolution: 32 },
      });
      const rockCol = addNode(g, 'tex/solid-color', {
        id: 'rock',
        position: { x: 0, y: 180 },
        inputValues: { color: [0.55, 0.5, 0.45, 1], resolution: 32 },
      });
      const mask = addNode(g, 'tex/perlin', {
        id: 'mask',
        position: { x: 0, y: 360 },
        inputValues: { scale: [3, 3], octaves: 4, lacunarity: 2, gain: -0.75, seed: 0, resolution: 256 },
      });
      const sphere = addNode(g, 'geom/sphere', {
        id: 'sphere',
        position: { x: 280, y: -100 },
        inputValues: { radius: 1, segments: 48, rings: 24 },
      });
      const material = addNode(g, 'material/terrain', {
        id: 'material',
        position: { x: 280, y: 180 },
        inputValues: { roughness_a: 0.9, roughness_b: 0.7, tile_scale: [1, 1] },
      });
      const entity = addNode(g, 'scene/entity', {
        id: 'entity',
        position: { x: 560, y: 50 },
        inputValues: {},
      });
      addEdge(g, { node: grassCol.id, socket: 'texture' }, { node: material.id, socket: 'layer_a' });
      addEdge(g, { node: rockCol.id, socket: 'texture' }, { node: material.id, socket: 'layer_b' });
      addEdge(g, { node: mask.id, socket: 'texture' }, { node: material.id, socket: 'mask' });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
      addEdge(g, { node: material.id, socket: 'material' }, { node: entity.id, socket: 'material' });
      return { graph: g, rootNodeId: 'entity' };
    },
  },
  evaluate(_ctx, inputs): { material: MaterialValue } {
    const normalA = inputs.normal_a as Texture2DValue | undefined;
    const normalB = inputs.normal_b as Texture2DValue | undefined;
    const material: MaterialValue = {
      kind: 'terrain-splat',
      layerA: inputs.layer_a as Texture2DValue,
      layerB: inputs.layer_b as Texture2DValue,
      mask: inputs.mask as Texture2DValue,
      roughnessA: inputs.roughness_a as number,
      roughnessB: inputs.roughness_b as number,
      tileScale: inputs.tile_scale as [number, number],
    };
    if (normalA) material.normalA = normalA;
    if (normalB) material.normalB = normalB;
    return { material };
  },
};
