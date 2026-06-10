import { addEdge, addNode, createGraph } from '../core/graph.js';
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
// Layers wire into a single multi-fan-in `layers` socket — edge-creation
// order maps to splat channels (first edge → R, second → G, …). Up to
// 4 layers are sampled by the shader; extras beyond 4 are ignored.
//
// Pair with `geom/heightfield-from-texture` + `scene/entity` the same
// way the old 2-layer `material/terrain` does. The shader runs
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
        'RGBA splat: R/G/B/A = weight for layers 0/1/2/3 (in edge-creation order on `layers`). Sampled at un-tiled UVs so the splat pattern spans the whole terrain',
    },
    {
      name: 'layers',
      type: 'TerrainLayer',
      multi: true,
      description: 'wire one to four [terrain/layer](../../terrain/layer) outputs. Edge-creation order determines splat channel (1st → R, 2nd → G, 3rd → B, 4th → A). Extras beyond 4 are ignored in v1',
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
  outputs: [
    {
      name: 'material',
      type: 'Material',
      description: 'multi-layer terrain material, consumed by [terrain/renderer](../../terrain/renderer) or by an ordinary [scene/entity](../../scene/entity) on a heightfield mesh',
    },
  ],
  doc: {
    summary: 'Up-to-4-layer terrain material — RGBA splat selects per-pixel between authored layers.',
    description: `
The grown-up sibling of [material/terrain](../../material/terrain).
Up to four layers (snow, tundra, forest, meadow, rocks, beach, …) each
authored as a [terrain/layer](../../terrain/layer) instance with its
own albedo / normal / height / roughness, combined by an RGBA splat
texture: \`splat.r\` = layer 0 weight, \`splat.g\` = layer 1, \`splat.b\` = 2,
\`splat.a\` = 3.

Each layer's PBR shading is computed individually then blended — same
"blend-after-lighting" trick the 2-layer node uses, extended to 4. The
\`height_blend_sharpness\` knob biases the blend toward whichever layer
has the locally-tallest height channel at each pixel; high values
produce "painted" transitions (cobblestones poking through grass)
rather than cross-fades.

Layers feed into a single multi-fan-in \`layers\` socket. Edge-
creation order is the splat-channel mapping: first edge → R, second
→ G, third → B, fourth → A. Extras beyond 4 are silently ignored.
`,
    sampleGraph: () => {
      const g = createGraph();
      // Two layers (grass + rock) authored as terrain/layer instances,
      // a perlin-ish splat in the R/G channels selects between them,
      // applied to a sphere as a stand-in for a terrain mesh.
      const grassCol = addNode(g, 'tex/solid-color', {
        id: 'grassCol',
        position: { x: 0, y: 0 },
        inputValues: { color: [0.28, 0.46, 0.18, 1], resolution: 32 },
      });
      const rockCol = addNode(g, 'tex/solid-color', {
        id: 'rockCol',
        position: { x: 0, y: 180 },
        inputValues: { color: [0.55, 0.5, 0.45, 1], resolution: 32 },
      });
      const layerA = addNode(g, 'terrain/layer', {
        id: 'layerA',
        position: { x: 280, y: 0 },
        inputValues: {},
      });
      const layerB = addNode(g, 'terrain/layer', {
        id: 'layerB',
        position: { x: 280, y: 180 },
        inputValues: {},
      });
      // The splat: perlin in R/G so the two layers each get organic
      // coverage. (For 3+ layers you'd compose an RGBA splat directly.)
      const splat = addNode(g, 'tex/perlin', {
        id: 'splat',
        position: { x: 0, y: 360 },
        inputValues: { scale: [3, 3], octaves: 4, lacunarity: 2, gain: 0.5, seed: 0, resolution: 256 },
      });
      const sphere = addNode(g, 'geom/sphere', {
        id: 'sphere',
        position: { x: 560, y: -100 },
        inputValues: { radius: 1, segments: 48, rings: 24 },
      });
      const material = addNode(g, 'terrain/material', {
        id: 'material',
        position: { x: 560, y: 200 },
        inputValues: { tile_scale: [1, 1], metallic: 0, height_blend_sharpness: 4 },
      });
      const entity = addNode(g, 'scene/entity', {
        id: 'entity',
        position: { x: 840, y: 50 },
        inputValues: {},
      });
      addEdge(g, { node: grassCol.id, socket: 'texture' }, { node: layerA.id, socket: 'albedo' });
      addEdge(g, { node: rockCol.id, socket: 'texture' }, { node: layerB.id, socket: 'albedo' });
      addEdge(g, { node: layerA.id, socket: 'layer' }, { node: material.id, socket: 'layers' });
      addEdge(g, { node: layerB.id, socket: 'layer' }, { node: material.id, socket: 'layers' });
      addEdge(g, { node: splat.id, socket: 'texture' }, { node: material.id, socket: 'splat' });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
      addEdge(g, { node: material.id, socket: 'material' }, { node: entity.id, socket: 'material' });
      return { graph: g, rootNodeId: 'entity' };
    },
  },
  evaluate(_ctx, inputs): { material: MaterialValue } {
    // Multi-fan-in: every wired layer arrives as an array in edge-
    // creation order. v1 shader samples up to 4; drop extras.
    const incoming = (inputs['layers'] as TerrainLayerValue[] | undefined) ?? [];
    const layers = incoming.filter((v): v is TerrainLayerValue => !!v).slice(0, 4);
    if (layers.length === 0) {
      throw new Error(
        'terrain/material: at least one layer must be wired into the `layers` socket',
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
