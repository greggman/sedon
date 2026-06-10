import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { InputDef, NodeDef } from '../core/node-def.js';
import type {
  MaterialValue,
  SceneValue,
  TerrainFieldValue,
  TerrainMultiLayerMaterial,
  Texture2DValue,
} from '../core/resources.js';

// Chunked-LOD terrain renderer node. Bundles a heightfield + a
// terrain-multi-layer material into a TerrainFieldValue and emits a
// Scene that carries it. The renderer (src/render/terrain-render.ts)
// picks an LOD per chunk from camera distance each frame and issues
// one drawIndexedIndirect per LOD bucket — see that file for the
// per-frame architecture.
//
// Outputs a Scene rather than an Entity because terrain fields are a
// render-time recipe, not a (geometry, material) batch the standard
// renderer can draw. The Scene's `entities` array is left empty so
// `scene/merge` and `core/output` compose with it the same way
// they compose grass fields.
export const terrainRendererNode: NodeDef = {
  id: 'terrain/renderer',
  category: 'Terrain',
  inputs: [
    {
      name: 'heightTexture',
      type: 'Texture2D',
      description: 'heightfield texture; R channel = world Y in metres. Typically a [tex/perlin](../../tex/perlin) or eroded noise piped through [tex/convert](../../tex/convert) + [tex/map-range](../../tex/map-range), or the output of [terrain/hydraulic-erosion](../../terrain/hydraulic-erosion)',
    },
    {
      name: 'worldSize',
      type: 'Vec2',
      default: [40, 40],
      description: 'terrain XZ footprint in metres (centred on origin). Chunks span this footprint divided by `chunk_count`',
    },
    {
      name: 'material',
      type: 'Material',
      description: 'must be a terrain-multi-layer material (from [terrain/material](../../terrain/material))',
    },
    {
      name: 'chunk_count',
      type: 'Vec2i',
      default: [8, 8],
      description: 'chunks across X and Z. Larger = smaller chunks = finer LOD granularity',
    },
    {
      name: 'base_divisions',
      type: 'Int',
      default: 32,
      min: 1,
      description: 'vertex count per edge at LOD 0 (finest LOD). Each LOD level halves this',
    },
    {
      name: 'lod_levels',
      type: 'Int',
      default: 4,
      min: 1,
      description: 'number of LOD levels; vertex count at level i = base_divisions / 2^i',
    },
    {
      name: 'lod_distance',
      type: 'Float',
      default: 30,
      description: 'world distance per LOD step. Chunk at distance d uses LOD floor(d / lod_distance)',
    },
  ],
  outputs: [
    {
      name: 'scene',
      type: 'Scene',
      description: 'a Scene carrying the terrain field as a render-time recipe (empty entities list; the terrain renderer picks up the field sidecar). Wire into [scene/merge](../../scene/merge) or [core/output](../../core/output)',
    },
  ],
  doc: {
    summary: 'Chunked-LOD terrain renderer — heightfield + multi-layer material → renderable Scene.',
    description: `
The terminal node in the terrain authoring chain. Takes a heightfield
and a [terrain/material](../../terrain/material) (must be the
multi-layer kind), bundles them as a render-time recipe, and emits a
Scene that the engine's terrain renderer picks up at draw time.

The renderer splits the terrain into a \`chunk_count\` grid; each
chunk picks its own LOD level per frame based on distance to the
camera, and chunks at the same LOD draw in one indirect call. This is
what makes large terrains tractable — close chunks render at
\`base_divisions\` vertices per edge, far ones at \`base_divisions / 2^lod_level\`.

The output Scene's \`entities\` array is empty on purpose; the terrain
field lives in the Scene's \`terrain\` sidecar. That lets it compose
with [scene/merge](../../scene/merge) (which carries the
sidecar through) so you can build a scene that has terrain AND
entities AND grass AND water side by side, all rendered correctly.

Tuning notes:
- More \`chunk_count\` = finer LOD granularity (closer chunks render at
  high LOD, distant chunks at low LOD) but more draw calls. 8×8 is the
  sweet spot for medium terrains; 16×16 for very large worlds.
- \`base_divisions\` controls close-up density; bump up if the user
  spends most of their time near the surface.
- \`lod_distance\` controls how aggressively LOD drops with distance.
  Smaller = faster LOD falloff = cheaper at distance.
`,
    sampleGraph: () => {
      const g = createGraph();
      // Heightfield from a perlin/erosion chain.
      const noise = addNode(g, 'tex/perlin', {
        id: 'noise',
        position: { x: 0, y: 0 },
        inputValues: { scale: [3, 3], octaves: 5, lacunarity: 2, gain: 0.5, seed: 0, resolution: 256 },
      });
      const toFloat = addNode(g, 'tex/convert', {
        id: 'toFloat',
        position: { x: 280, y: 0 },
        inputValues: { format: 1 },
      });
      const heightTex = addNode(g, 'tex/map-range', {
        id: 'heightTex',
        position: { x: 560, y: 0 },
        inputValues: { in_min: 0, in_max: 1, out_min: 0, out_max: 6, clamp: false },
      });
      // Two-layer material (grass + rock) splat by a separate perlin.
      const grassCol = addNode(g, 'tex/solid-color', {
        id: 'grassCol',
        position: { x: 0, y: 200 },
        inputValues: { color: [0.28, 0.46, 0.18, 1], resolution: 32 },
      });
      const rockCol = addNode(g, 'tex/solid-color', {
        id: 'rockCol',
        position: { x: 0, y: 380 },
        inputValues: { color: [0.55, 0.5, 0.45, 1], resolution: 32 },
      });
      const layerA = addNode(g, 'terrain/layer', {
        id: 'layerA',
        position: { x: 280, y: 200 },
        inputValues: {},
      });
      const layerB = addNode(g, 'terrain/layer', {
        id: 'layerB',
        position: { x: 280, y: 380 },
        inputValues: {},
      });
      const splat = addNode(g, 'tex/perlin', {
        id: 'splat',
        position: { x: 0, y: 560 },
        inputValues: { scale: [3, 3], octaves: 4, lacunarity: 2, gain: 0.5, seed: 1, resolution: 256 },
      });
      const matExtras: InputDef[] = [
        { name: 'layer_0', type: 'TerrainLayer' },
        { name: 'layer_1', type: 'TerrainLayer' },
      ];
      const material = addNode(g, 'terrain/material', {
        id: 'material',
        position: { x: 560, y: 300 },
        extraInputs: matExtras,
        inputValues: { tile_scale: [4, 4], metallic: 0, height_blend_sharpness: 4 },
      });
      const renderer = addNode(g, 'terrain/renderer', {
        id: 'renderer',
        position: { x: 1120, y: 150 },
        inputValues: {
          worldSize: [40, 40],
          chunk_count: [8, 8],
          base_divisions: 32,
          lod_levels: 4,
          lod_distance: 30,
        },
      });
      addEdge(g, { node: noise.id, socket: 'texture' }, { node: toFloat.id, socket: 'texture' });
      addEdge(g, { node: toFloat.id, socket: 'texture' }, { node: heightTex.id, socket: 'texture' });
      addEdge(g, { node: grassCol.id, socket: 'texture' }, { node: layerA.id, socket: 'albedo' });
      addEdge(g, { node: rockCol.id, socket: 'texture' }, { node: layerB.id, socket: 'albedo' });
      addEdge(g, { node: layerA.id, socket: 'layer' }, { node: material.id, socket: 'layer_0' });
      addEdge(g, { node: layerB.id, socket: 'layer' }, { node: material.id, socket: 'layer_1' });
      addEdge(g, { node: splat.id, socket: 'texture' }, { node: material.id, socket: 'splat' });
      addEdge(g, { node: heightTex.id, socket: 'texture' }, { node: renderer.id, socket: 'heightTexture' });
      addEdge(g, { node: material.id, socket: 'material' }, { node: renderer.id, socket: 'material' });
      return { graph: g, rootNodeId: 'renderer' };
    },
  },
  evaluate(_ctx, inputs): { scene: SceneValue } {
    const heightTexture = inputs.heightTexture as Texture2DValue;
    const worldSize = inputs.worldSize as [number, number];
    const material = inputs.material as MaterialValue;
    if (material.kind !== 'terrain-multi-layer') {
      throw new Error(
        `terrain/renderer requires a terrain-multi-layer material (got '${material.kind}'). ` +
          'Wire a terrain/material node into the material input.',
      );
    }
    const chunkCount = inputs.chunk_count as [number, number];
    const baseDivisions = Math.max(2, Math.round(inputs.base_divisions as number));
    const lodLevels = Math.max(1, Math.round(inputs.lod_levels as number));
    const lodDistance = Math.max(0.01, inputs.lod_distance as number);
    const field: TerrainFieldValue = {
      heightTexture,
      worldSize,
      material: material as TerrainMultiLayerMaterial,
      chunkCount: [Math.max(1, Math.round(chunkCount[0])), Math.max(1, Math.round(chunkCount[1]))],
      lodLevels,
      baseDivisions,
      lodDistance,
    };
    return {
      scene: {
        entities: [],
        terrain: [field],
      },
    };
  },
};
