import type { NodeDef } from '../core/node-def.js';
import type { SceneValue } from '../core/resources.js';

// Combine two scenes by concatenating their entity lists. Chains
// (merge(merge(a, b), c)) for more than two; variadic inputs are a separate
// architectural slice that can come later if N=2 → N×merge gets annoying.
export const sceneMergeNode: NodeDef = {
  id: 'core/scene-merge',
  category: 'Scene',
  inputs: [
    { name: 'a', type: 'Scene' },
    { name: 'b', type: 'Scene' },
  ],
  outputs: [{ name: 'scene', type: 'Scene' }],
  evaluate(_ctx, inputs): { scene: SceneValue } {
    const a = inputs.a as SceneValue;
    const b = inputs.b as SceneValue;
    return { scene: { entities: [...a.entities, ...b.entities] } };
  },
};
