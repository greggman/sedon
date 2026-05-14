import type { NodeDef } from '../core/node-def.js';
import {
  generateWhorledPineBranchGraph,
  type BranchGraphValue,
} from '../render/branch-graph.js';

// Monopodial pine/spruce/fir: single dominant trunk with lateral branches
// arranged in WHORLS (rings) at regular intervals. Branch length tapers
// toward the top giving the characteristic conical envelope. Branches
// themselves don't sag in the generator — pipe `branch/tropism` downstream
// with a positive gravity term to get the pine droop.
export const branchWhorledPineNode: NodeDef = {
  id: 'branch/whorled-pine',
  category: 'Branches/Generators',
  inputs: [
    { name: 'trunkHeight', type: 'Float', default: 12 },
    { name: 'trunkRadiusBase', type: 'Float', default: 0.32 },
    { name: 'trunkRadiusTip', type: 'Float', default: 0.04 },
    { name: 'trunkSegments', type: 'Int', default: 16 },
    {
      name: 'trunkLean',
      type: 'Float',
      default: 0,
      description: 'overall trunk tilt from vertical (degrees)',
    },
    { name: 'whorlCount', type: 'Int', default: 8 },
    {
      name: 'whorlStart',
      type: 'Float',
      default: 0.25,
      description: 'fraction of trunk height where the lowest whorl sits (0..1)',
    },
    {
      name: 'whorlEnd',
      type: 'Float',
      default: 0.95,
      description: 'fraction of trunk height where the topmost whorl sits (0..1)',
    },
    { name: 'branchesPerWhorl', type: 'Int', default: 6 },
    {
      name: 'whorlPhaseOffset',
      type: 'Float',
      default: 35,
      description: 'rotation (degrees) of each whorl relative to the previous one',
    },
    {
      name: 'branchLengthAtBase',
      type: 'Float',
      default: 3.5,
      description: 'whorl-branch length at the lowest whorl',
    },
    {
      name: 'branchLengthAtTop',
      type: 'Float',
      default: 0.6,
      description: 'whorl-branch length at the topmost whorl (shorter → cone shape)',
    },
    {
      name: 'branchAngle',
      type: 'Float',
      default: 80,
      description: 'tilt from trunk tangent (degrees); 90 = horizontal, <90 = upswept',
    },
    { name: 'branchSegments', type: 'Int', default: 6 },
    {
      name: 'branchRadiusFraction',
      type: 'Float',
      default: 0.25,
      description: 'whorl-branch root radius ÷ trunk radius at the attach point',
    },
    {
      name: 'branchTipRadiusFraction',
      type: 'Float',
      default: 0.15,
      description: 'tip radius ÷ root radius (per branch)',
    },
    {
      name: 'subBranchCount',
      type: 'Int',
      default: 0,
      description: 'sub-branches per whorl branch (0 = none, typical for young firs)',
    },
    { name: 'subBranchLengthRatio', type: 'Float', default: 0.45 },
    { name: 'subBranchAngle', type: 'Float', default: 55 },
    { name: 'seed', type: 'Float', default: 0.58 },
  ],
  outputs: [{ name: 'branches', type: 'BranchGraph' }],
  evaluate(_ctx, inputs): { branches: BranchGraphValue } {
    return {
      branches: generateWhorledPineBranchGraph({
        trunkHeight: inputs.trunkHeight as number,
        trunkRadiusBase: inputs.trunkRadiusBase as number,
        trunkRadiusTip: inputs.trunkRadiusTip as number,
        trunkSegments: inputs.trunkSegments as number,
        trunkLeanDeg: inputs.trunkLean as number,
        whorlCount: inputs.whorlCount as number,
        whorlStart: inputs.whorlStart as number,
        whorlEnd: inputs.whorlEnd as number,
        branchesPerWhorl: inputs.branchesPerWhorl as number,
        whorlPhaseOffsetDeg: inputs.whorlPhaseOffset as number,
        branchLengthAtBase: inputs.branchLengthAtBase as number,
        branchLengthAtTop: inputs.branchLengthAtTop as number,
        branchAngleDeg: inputs.branchAngle as number,
        branchSegments: inputs.branchSegments as number,
        branchRadiusFraction: inputs.branchRadiusFraction as number,
        branchTipRadiusFraction: inputs.branchTipRadiusFraction as number,
        subBranchCount: inputs.subBranchCount as number,
        subBranchLengthRatio: inputs.subBranchLengthRatio as number,
        subBranchAngleDeg: inputs.subBranchAngle as number,
        seed: inputs.seed as number,
      }),
    };
  },
};
