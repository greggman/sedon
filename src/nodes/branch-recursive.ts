import type { NodeDef } from '../core/node-def.js';
import { generateRecursiveBranchGraph, type BranchGraphValue } from '../render/branch-graph.js';

// Recursive parametric branching: trunk + N children per segment, each
// generated with rotation/length/radius ratios off the parent. Good for
// stylized oak, birch, generic deciduous, generic bush. Other families
// (whorled-pine, palm, space-colonization) will be separate generator
// nodes that all output the same `BranchGraph` type.
export const branchRecursiveNode: NodeDef = {
  id: 'branch/recursive',
  category: 'Branches/Generators',
  inputs: [
    { name: 'trunkHeight', type: 'Float', default: 6 },
    { name: 'trunkRadius', type: 'Float', default: 0.25 },
    { name: 'trunkSegments', type: 'Int', default: 10 },
    {
      name: 'maxDepth',
      type: 'Int',
      default: 3,
      description: 'recursion depth — 0 = trunk only, 3–5 typical',
    },
    {
      name: 'branchesPerSegment',
      type: 'Int',
      default: 1,
      description: 'children spawned at each parent segment in the branching zone',
    },
    {
      name: 'branchStart',
      type: 'Float',
      default: 0.4,
      description: 'fraction of parent length below which no children spawn (0..1)',
    },
    {
      name: 'branchAngle',
      type: 'Float',
      default: 50,
      description: 'tilt away from parent tangent, in degrees',
    },
    { name: 'branchAngleJitter', type: 'Float', default: 12 },
    {
      name: 'lengthRatio',
      type: 'Float',
      default: 0.65,
      description: 'child length ÷ parent length',
    },
    {
      name: 'radiusRatio',
      type: 'Float',
      default: 0.55,
      description: 'child root radius ÷ parent root radius',
    },
    {
      name: 'branchCurvature',
      type: 'Float',
      default: 4,
      description: 'degrees per segment of in-plane bend along each branch',
    },
    {
      name: 'phyllotaxisAngle',
      type: 'Float',
      default: 137.5,
      description: 'rotation around parent tangent between consecutive children (137.5° = golden)',
    },
    {
      name: 'segmentRatio',
      type: 'Float',
      default: 0.75,
      description: 'child segments ÷ parent segments',
    },
    { name: 'minSegmentsPerBranch', type: 'Int', default: 3 },
    {
      name: 'tipRadiusFraction',
      type: 'Float',
      default: 0.2,
      description: 'tip radius ÷ root radius (per branch, linear taper)',
    },
    { name: 'seed', type: 'Float', default: 0.31 },
  ],
  outputs: [{ name: 'branches', type: 'BranchGraph' }],
  evaluate(_ctx, inputs): { branches: BranchGraphValue } {
    return {
      branches: generateRecursiveBranchGraph({
        trunkHeight: inputs.trunkHeight as number,
        trunkRadius: inputs.trunkRadius as number,
        trunkSegments: inputs.trunkSegments as number,
        maxDepth: inputs.maxDepth as number,
        branchesPerSegment: inputs.branchesPerSegment as number,
        branchStart: inputs.branchStart as number,
        branchAngleDeg: inputs.branchAngle as number,
        branchAngleJitterDeg: inputs.branchAngleJitter as number,
        lengthRatio: inputs.lengthRatio as number,
        radiusRatio: inputs.radiusRatio as number,
        branchCurvatureDeg: inputs.branchCurvature as number,
        phyllotaxisDeg: inputs.phyllotaxisAngle as number,
        segmentRatio: inputs.segmentRatio as number,
        minSegmentsPerBranch: inputs.minSegmentsPerBranch as number,
        tipRadiusFraction: inputs.tipRadiusFraction as number,
        seed: inputs.seed as number,
      }),
    };
  },
};
