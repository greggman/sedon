import type { NodeDef } from '../core/node-def.js';
import type { GrassFieldValue, SceneValue, TerrainFieldValue } from '../core/resources.js';

// Variadic Scene merge. Starts with NO input sockets — every input is a
// per-instance extra added via the node's "+ Add scene" button (or by
// dragging a Scene output onto the phantom "+ Add" drop target on the
// left edge). The evaluator iterates every connected input and
// concatenates their entity lists; unconnected sockets are skipped, so
// partial wiring during authoring doesn't break the merge.
//
// `extraInputs` are stored on the GraphNode and persisted with the
// graph, so each merge node carries its own socket count.
export const sceneMergeNode: NodeDef = {
  id: 'core/scene-merge',
  category: 'Scene',
  inputs: [],
  outputs: [{ name: 'scene', type: 'Scene' }],
  extraInputsSpec: {
    type: 'Scene',
    namePrefix: 'scene',
    addLabel: '+ Add scene',
  },
  evaluate(_ctx, inputs): { scene: SceneValue } {
    const entities = [];
    const grass: GrassFieldValue[] = [];
    const terrain: TerrainFieldValue[] = [];
    let waterLevel: number | undefined;
    for (const v of Object.values(inputs)) {
      if (v && typeof v === 'object' && Array.isArray((v as SceneValue).entities)) {
        entities.push(...(v as SceneValue).entities);
        // Carry sidecar render-time recipes through. Without these,
        // wrapping a grass / terrain scene through scene-merge would
        // silently drop the field and the renderer would only see
        // the (often empty) `entities` list.
        const g = (v as SceneValue).grass;
        if (g) grass.push(...g);
        const t = (v as SceneValue).terrain;
        if (t) terrain.push(...t);
        // For waterLevel keep the MAX — the camera should "submerge"
        // the moment it falls below the tallest water surface in the
        // scene.
        const wl = (v as SceneValue).waterLevel;
        if (typeof wl === 'number') {
          waterLevel = waterLevel === undefined ? wl : Math.max(waterLevel, wl);
        }
      }
    }
    const out: SceneValue = { entities };
    if (grass.length > 0) out.grass = grass;
    if (terrain.length > 0) out.terrain = terrain;
    if (waterLevel !== undefined) out.waterLevel = waterLevel;
    return { scene: out };
  },
};
