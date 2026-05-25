import type { NodeDef } from '../core/node-def.js';
import type {
  HeightfieldValue,
  MaterialValue,
  SceneValue,
  TerrainFieldValue,
  TerrainMultiLayerMaterial,
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
// `core/scene-merge` and `core/output` compose with it the same way
// they compose grass fields.
export const terrainRendererNode: NodeDef = {
  id: 'terrain/renderer',
  category: 'Terrain',
  inputs: [
    { name: 'heightfield', type: 'Heightfield' },
    {
      name: 'material',
      type: 'Material',
      description: 'must be a terrain-multi-layer material (from terrain/material)',
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
      description: 'vertex count per edge at LOD 0 (finest LOD). Each LOD level halves this',
    },
    {
      name: 'lod_levels',
      type: 'Int',
      default: 4,
      description: 'number of LOD levels; vertex count at level i = base_divisions / 2^i',
    },
    {
      name: 'lod_distance',
      type: 'Float',
      default: 30,
      description: 'world distance per LOD step. Chunk at distance d uses LOD floor(d / lod_distance)',
    },
  ],
  outputs: [{ name: 'scene', type: 'Scene' }],
  evaluate(_ctx, inputs): { scene: SceneValue } {
    const heightfield = inputs.heightfield as HeightfieldValue;
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
      heightfield,
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
