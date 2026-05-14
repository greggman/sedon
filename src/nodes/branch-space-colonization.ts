import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue } from '../core/resources.js';
import {
  generateSpaceColonizationBranchGraph,
  type BranchGraphValue,
} from '../render/branch-graph.js';

// Runions-style space-colonization canopy grower. Takes a PointCloud of
// attractor positions (typically `core/sphere` → `core/distribute-on-faces`
// for a spherical canopy envelope; any mesh works), grows a tree from
// `trunkStart` toward those attractors, then assigns radii via Murray's
// law. Best naturalism for big-canopy deciduous trees — oak, maple, beech.
//
// Heavier compute than the recursive / whorled / palm generators: each
// iteration is O(attractors × nodes). Keep the attractor count in the
// hundreds for interactive editing; bump for hero shots.
export const branchSpaceColonizationNode: NodeDef = {
  id: 'branch/space-colonization',
  category: 'Branches/Generators',
  inputs: [
    {
      name: 'attractors',
      type: 'PointCloud',
      description: 'attractor points the tree grows toward (typically distribute-on-faces of a canopy mesh)',
    },
    { name: 'trunkStart', type: 'Vec3', default: [0, 0, 0] },
    {
      name: 'trunkInitialDirection',
      type: 'Vec3',
      default: [0, 1, 0],
      description: 'direction the first segment grows when no attractor is in range yet',
    },
    {
      name: 'attractorRadius',
      type: 'Float',
      default: 4,
      description:
        "influence radius — only attractors within this distance of their nearest node count. A few × segmentLength so the trunk can 'see' the canopy before reaching it.",
    },
    {
      name: 'killRadius',
      type: 'Float',
      default: 0.6,
      description: 'attractors within this distance of any node are consumed and removed (~ segmentLength)',
    },
    { name: 'segmentLength', type: 'Float', default: 0.4 },
    { name: 'maxIterations', type: 'Int', default: 200 },
    {
      name: 'upBias',
      type: 'Float',
      default: 0.15,
      description: 'small +Y pull on growth direction — prevents attractor balance from producing horizontal sprawl through the trunk',
    },
    { name: 'rootRadius', type: 'Float', default: 0.32 },
    { name: 'tipRadius', type: 'Float', default: 0.04 },
    {
      name: 'radiusExponent',
      type: 'Float',
      default: 2.5,
      description: "Murray's-law exponent. 2.0 = area-conserving, 2.5–3.0 typical for plants",
    },
  ],
  outputs: [{ name: 'branches', type: 'BranchGraph' }],
  evaluate(_ctx, inputs): { branches: BranchGraphValue } {
    const attractors = inputs.attractors as PointCloudValue;
    return {
      branches: generateSpaceColonizationBranchGraph({
        attractors: attractors.positions,
        attractorCount: attractors.count,
        trunkStart: inputs.trunkStart as [number, number, number],
        trunkInitialDirection: inputs.trunkInitialDirection as [number, number, number],
        attractorRadius: inputs.attractorRadius as number,
        killRadius: inputs.killRadius as number,
        segmentLength: inputs.segmentLength as number,
        maxIterations: inputs.maxIterations as number,
        upBias: inputs.upBias as number,
        rootRadius: inputs.rootRadius as number,
        tipRadius: inputs.tipRadius as number,
        radiusExponent: inputs.radiusExponent as number,
      }),
    };
  },
};
