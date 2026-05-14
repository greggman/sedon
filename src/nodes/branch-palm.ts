import type { NodeDef } from '../core/node-def.js';
import {
  generatePalmBranchGraph,
  type BranchGraphValue,
} from '../render/branch-graph.js';

// Single unbranched curving trunk — palm, banana, tree fern, agave. Crown
// fronds are placed downstream by `branch/sample-points` with onlyTips=true
// and tipCount=N feeding `core/instance-geometry-on-points`.
export const branchPalmNode: NodeDef = {
  id: 'branch/palm',
  category: 'Branches/Generators',
  inputs: [
    { name: 'height', type: 'Float', default: 8 },
    { name: 'trunkRadiusBase', type: 'Float', default: 0.18 },
    { name: 'trunkRadiusTip', type: 'Float', default: 0.12 },
    { name: 'trunkSegments', type: 'Int', default: 14 },
    {
      name: 'leanAngle',
      type: 'Float',
      default: 8,
      description: 'initial tilt from vertical at the trunk base (degrees)',
    },
    {
      name: 'leanCurvature',
      type: 'Float',
      default: 0.8,
      description:
        'degrees of additional bend per trunk segment — positive continues the lean direction',
    },
    {
      name: 'leanAzimuth',
      type: 'Float',
      default: 0,
      description: 'direction in the XZ plane the trunk leans toward (degrees, 0 = +X)',
    },
    { name: 'seed', type: 'Float', default: 0.41 },
  ],
  outputs: [{ name: 'branches', type: 'BranchGraph' }],
  evaluate(_ctx, inputs): { branches: BranchGraphValue } {
    return {
      branches: generatePalmBranchGraph({
        height: inputs.height as number,
        trunkRadiusBase: inputs.trunkRadiusBase as number,
        trunkRadiusTip: inputs.trunkRadiusTip as number,
        trunkSegments: inputs.trunkSegments as number,
        leanAngleDeg: inputs.leanAngle as number,
        leanCurvatureDeg: inputs.leanCurvature as number,
        leanAzimuthDeg: inputs.leanAzimuth as number,
        seed: inputs.seed as number,
      }),
    };
  },
};
