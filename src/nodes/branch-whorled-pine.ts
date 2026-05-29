import { addEdge, addNode, createGraph } from '../core/graph.js';
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
  outputs: [
    {
      name: 'branches',
      type: 'BranchGraph',
      description: 'pine-shaped BranchGraph (trunk + whorled laterals). Realize via [branch/tube](../../branch/tube); for the characteristic pine droop add [branch/tropism](../../branch/tropism) with positive gravity in between',
    },
  ],
  doc: {
    summary: 'Monopodial conifer — single trunk with lateral branches in whorls. Pine/spruce/fir.',
    description: `
A single dominant trunk with lateral branches arranged in WHORLS (rings)
at regular height intervals. \`whorlCount\` rings between \`whorlStart\`
and \`whorlEnd\` (as fractions of trunk height); each ring carries
\`branchesPerWhorl\` evenly-spaced branches, rotated by
\`whorlPhaseOffset\` from the previous ring so they don't stack
directly above each other.

Branch length tapers from \`branchLengthAtBase\` at the lowest whorl
to \`branchLengthAtTop\` at the topmost whorl — that's what gives the
characteristic conical envelope: long bottom branches, short top.

Branches in this generator don't sag — they leave the trunk at
\`branchAngle\` and stay straight. Pipe through
[branch/tropism](../../branch/tropism) with a positive \`gravity\` to get
the natural pine droop where lower whorls hang lower.

For young firs with single straight whorl branches use
\`subBranchCount: 0\`; for older specimens with feathered branchlets,
bump it up. Pair with [branch/tube](../../branch/tube) for the mesh.
`,
    sampleGraph: () => {
      const g = createGraph();
      const pine = addNode(g, 'branch/whorled-pine', {
        id: 'pine',
        position: { x: 0, y: 0 },
        inputValues: {
          trunkHeight: 12, trunkRadiusBase: 0.32, trunkRadiusTip: 0.04,
          trunkSegments: 16, trunkLean: 0,
          whorlCount: 8, whorlStart: 0.25, whorlEnd: 0.95,
          branchesPerWhorl: 6, whorlPhaseOffset: 35,
          branchLengthAtBase: 3.5, branchLengthAtTop: 0.6,
          branchAngle: 80, branchSegments: 6,
          branchRadiusFraction: 0.25, branchTipRadiusFraction: 0.15,
          subBranchCount: 0, subBranchLengthRatio: 0.45, subBranchAngle: 55,
          seed: 0.58,
        },
      });
      const droop = addNode(g, 'branch/tropism', {
        id: 'droop',
        position: { x: 280, y: 0 },
        inputValues: { gravity: 0.18, phototropism: [0, 0, 0], wobble: 0.02, wobbleSeed: 0.7 },
      });
      const tube = addNode(g, 'branch/tube', {
        id: 'tube',
        position: { x: 560, y: 0 },
        inputValues: { sides: 8, uvTilingV: 0.5 },
      });
      addEdge(g, { node: pine.id, socket: 'branches' }, { node: droop.id, socket: 'branches' });
      addEdge(g, { node: droop.id, socket: 'branches' }, { node: tube.id, socket: 'branches' });
      return { graph: g, rootNodeId: 'tube' };
    },
  },
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
