import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue } from '../core/resources.js';
import {
  sampleBranchGraphPoints,
  type BranchGraphValue,
} from '../render/branch-graph.js';

// Sample points along a BranchGraph's curves. Each output point's position
// sits on the branch *surface* (offset by radius from the centerline); its
// normal points outward radially — so an instanced leaf card attached at
// this point with `align: true` will face away from the branch.
//
// Typical authored tree wires this node twice off the same BranchGraph:
//
//   - LEAF placement: depthMin >= 1 (skip the trunk), radius bounded to
//     thin twigs, high density, leaf-card instance.
//   - FLOWER placement: onlyTips = true, lower density, own seed, flower
//     instance — different filters, same node.
export const branchSamplePointsNode: NodeDef = {
  id: 'branch/sample-points',
  category: 'Branches/Realize',
  inputs: [
    { name: 'branches', type: 'BranchGraph' },
    {
      name: 'depthMin',
      type: 'Int',
      default: 1,
      description: 'minimum branch depth (0=trunk, 1=primary, 2=secondary…); inclusive',
    },
    {
      name: 'depthMax',
      type: 'Int',
      default: 99,
      description: 'maximum branch depth; inclusive',
    },
    {
      name: 'radiusMin',
      type: 'Float',
      default: 0,
      description: 'minimum local branch radius for a segment to be sampled',
    },
    {
      name: 'radiusMax',
      type: 'Float',
      default: 99,
      description: 'maximum local branch radius — set tight to filter to thin twigs',
    },
    {
      name: 'onlyTips',
      type: 'Bool',
      default: false,
      description: 'sample one point per branch at its tip (good for flowers/fruit)',
    },
    {
      name: 'density',
      type: 'Float',
      default: 30,
      description: 'points per unit arc length (ignored when onlyTips is true)',
    },
    {
      name: 'tipCount',
      type: 'Int',
      default: 1,
      description:
        'points emitted per tip when onlyTips is true. 1 = oriented along tangent (flowers); N>1 = fanned radially around the tangent (palm fronds, needle clusters)',
    },
    { name: 'seed', type: 'Float', default: 0.5 },
  ],
  outputs: [{ name: 'points', type: 'PointCloud' }],
  evaluate(_ctx, inputs): { points: PointCloudValue } {
    const branches = inputs.branches as BranchGraphValue;
    return {
      points: sampleBranchGraphPoints(branches, {
        depthMin: inputs.depthMin as number,
        depthMax: inputs.depthMax as number,
        radiusMin: inputs.radiusMin as number,
        radiusMax: inputs.radiusMax as number,
        onlyTips: inputs.onlyTips as boolean,
        density: inputs.density as number,
        tipCount: inputs.tipCount as number,
        seed: inputs.seed as number,
      }),
    };
  },
};
