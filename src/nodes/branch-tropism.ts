import type { NodeDef } from '../core/node-def.js';
import {
  applyTropismToBranchGraph,
  type BranchGraphValue,
} from '../render/branch-graph.js';

// Bend the curves in a BranchGraph under gravity / sun / random wobble.
// Out-of-place: returns a new BranchGraph; the trunk (depth 0) is never
// bent, and children's bases follow their bent parents so the topology
// stays glued (their offset is inherited from the parent's vertex
// offset at the attach point).
//
// Cheap, stackable, large naturalism payoff. Place between the generator
// and `branch/tube` / `branch/sample-points`.
export const branchTropismNode: NodeDef = {
  id: 'branch/tropism',
  category: 'Branches/Modifiers',
  inputs: [
    { name: 'branches', type: 'BranchGraph' },
    {
      name: 'gravity',
      type: 'Float',
      default: 0.12,
      description: 'sag strength per unit branch length (per depth tier); 0 = no sag',
    },
    {
      name: 'phototropism',
      type: 'Vec3',
      default: [0, 0, 0],
      description: 'world-space direction × strength branches bend toward (e.g. toward the sun)',
    },
    {
      name: 'wobble',
      type: 'Float',
      default: 0.02,
      description: 'per-vertex random jitter magnitude (scales with depth)',
    },
    { name: 'wobbleSeed', type: 'Float', default: 0.7 },
  ],
  outputs: [{ name: 'branches', type: 'BranchGraph' }],
  evaluate(_ctx, inputs): { branches: BranchGraphValue } {
    const branches = inputs.branches as BranchGraphValue;
    return {
      branches: applyTropismToBranchGraph(branches, {
        gravity: inputs.gravity as number,
        phototropism: inputs.phototropism as [number, number, number],
        wobble: inputs.wobble as number,
        wobbleSeed: inputs.wobbleSeed as number,
      }),
    };
  },
};
