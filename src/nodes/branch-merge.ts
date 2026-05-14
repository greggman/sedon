import type { NodeDef } from '../core/node-def.js';
import {
  mergeBranchGraphs,
  type BranchGraphValue,
} from '../render/branch-graph.js';

// Combine two BranchGraphs into one. `b`'s branches are appended after
// `a`'s; their parentIndex values are shifted to remain valid, their
// root branches stay as roots, and their vertex ranges concatenate.
//
// Primary use: multi-stem bushes — chain a few `branch/recursive`
// instances with different seeds/positions through this. Also useful for
// adding dead/snapped branches to a main tree.
export const branchMergeNode: NodeDef = {
  id: 'branch/merge',
  category: 'Branches/Modifiers',
  inputs: [
    { name: 'a', type: 'BranchGraph' },
    { name: 'b', type: 'BranchGraph' },
  ],
  outputs: [{ name: 'branches', type: 'BranchGraph' }],
  evaluate(_ctx, inputs): { branches: BranchGraphValue } {
    return {
      branches: mergeBranchGraphs(
        inputs.a as BranchGraphValue,
        inputs.b as BranchGraphValue,
      ),
    };
  },
};
