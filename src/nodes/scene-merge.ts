import type { NodeDef } from '../core/node-def.js';
import type { GrassFieldValue, SceneValue } from '../core/resources.js';

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
    for (const v of Object.values(inputs)) {
      if (v && typeof v === 'object' && Array.isArray((v as SceneValue).entities)) {
        entities.push(...(v as SceneValue).entities);
        // Carry grass fields through the merge too — a grass scene
        // merged with a terrain scene should keep its grass, not just
        // its (empty) entity list.
        const g = (v as SceneValue).grass;
        if (g) grass.push(...g);
      }
    }
    return { scene: grass.length > 0 ? { entities, grass } : { entities } };
  },
};
