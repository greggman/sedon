import { addEdge, addNode, createGraph } from '../core/graph.js';
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
    {
      name: 'a',
      type: 'BranchGraph',
      description: 'first input graph; its branches come first in the output',
    },
    {
      name: 'b',
      type: 'BranchGraph',
      description: 'second input graph; its branches are appended after `a`\'s, with parentIndex values shifted to remain valid',
    },
  ],
  outputs: [
    {
      name: 'branches',
      type: 'BranchGraph',
      description: 'combined BranchGraph — both inputs\' branches and vertices concatenated. Root branches stay as roots; downstream consumers see one tree with two trunks',
    },
  ],
  doc: {
    summary: 'Combine two BranchGraphs into one — multi-stem bushes, snapped branches.',
    description: `
Appends b's branches after a's, shifting parentIndex values so they
remain valid, keeping both inputs' root branches as roots in the
output, and concatenating vertex ranges.

The primary use is multi-stem bushes — chain a few
[branch/recursive](../../branch/recursive) instances at different
positions (each with its own \`seed\`) through this and get a clump of
stems sharing one canopy mass. Also useful for adding dead / snapped
branches to a main tree without modifying the main generator's
parameters.

For more than two stems, chain multiple merges (a + b + c = merge(merge(a, b), c)).
`,
    sampleGraph: () => {
      const g = createGraph();
      // Two recursive trees with different seeds + offset positions
      // (via core/transform on... wait, BranchGraph has no transform
      // node yet). Best demo: two trees with different `seed` values
      // merged; visually they overlap but the merge is still
      // meaningful — bump one's seed to vary the second's shape.
      const treeA = addNode(g, 'branch/recursive', {
        id: 'treeA',
        position: { x: 0, y: 0 },
        inputValues: {
          trunkHeight: 6, trunkRadius: 0.22, trunkSegments: 10,
          maxDepth: 3, branchesPerSegment: 1, branchStart: 0.4,
          branchAngle: 50, branchAngleJitter: 12,
          lengthRatio: 0.65, radiusRatio: 0.55,
          branchCurvature: 4, phyllotaxisAngle: 137.5,
          segmentRatio: 0.75, minSegmentsPerBranch: 3,
          tipRadiusFraction: 0.2, seed: 0.31,
        },
      });
      const treeB = addNode(g, 'branch/recursive', {
        id: 'treeB',
        position: { x: 0, y: 220 },
        inputValues: {
          trunkHeight: 4.5, trunkRadius: 0.18, trunkSegments: 8,
          maxDepth: 3, branchesPerSegment: 1, branchStart: 0.4,
          branchAngle: 50, branchAngleJitter: 12,
          lengthRatio: 0.65, radiusRatio: 0.55,
          branchCurvature: 4, phyllotaxisAngle: 137.5,
          segmentRatio: 0.75, minSegmentsPerBranch: 3,
          tipRadiusFraction: 0.2, seed: 0.78,
        },
      });
      const merge = addNode(g, 'branch/merge', {
        id: 'merge',
        position: { x: 280, y: 110 },
        inputValues: {},
      });
      const tube = addNode(g, 'branch/tube', {
        id: 'tube',
        position: { x: 560, y: 110 },
        inputValues: { sides: 8, uvTilingV: 0.5 },
      });
      addEdge(g, { node: treeA.id, socket: 'branches' }, { node: merge.id, socket: 'a' });
      addEdge(g, { node: treeB.id, socket: 'branches' }, { node: merge.id, socket: 'b' });
      addEdge(g, { node: merge.id, socket: 'branches' }, { node: tube.id, socket: 'branches' });
      return { graph: g, rootNodeId: 'tube' };
    },
  },
  evaluate(_ctx, inputs): { branches: BranchGraphValue } {
    return {
      branches: mergeBranchGraphs(
        inputs.a as BranchGraphValue,
        inputs.b as BranchGraphValue,
      ),
    };
  },
};
