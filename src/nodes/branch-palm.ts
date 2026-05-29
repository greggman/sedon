import { addEdge, addNode, createGraph } from '../core/graph.js';
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
  outputs: [
    {
      name: 'branches',
      type: 'BranchGraph',
      description: 'a single-curve BranchGraph (no children). Realize via [branch/tube](../../branch/tube); place fronds at the tip with [branch/sample-points](../../branch/sample-points) using `onlyTips=true` + `tipCount=N`',
    },
  ],
  doc: {
    summary: 'Single unbranched curving trunk — palm, banana, tree fern, agave.',
    description: `
A trunk that curves gracefully under its own lean. \`leanAngle\` sets
the tilt at the base; \`leanCurvature\` keeps adding degrees of bend per
segment as you go up, producing the characteristic palm-fronds-over-
the-beach silhouette. \`leanAzimuth\` rotates which compass direction
the tree leans toward.

No children — palms don't branch. Crown fronds are placed downstream
with [branch/sample-points](../../branch/sample-points) using
\`onlyTips=true\` and \`tipCount=N\` (typically 8–14 fronds), each
sample point feeding a leaf-card instance through
[core/instance-geometry-on-points](../../core/instance-geometry-on-points)
with \`align: true\`.
`,
    sampleGraph: () => {
      const g = createGraph();
      const palm = addNode(g, 'branch/palm', {
        id: 'palm',
        position: { x: 0, y: 0 },
        inputValues: {
          height: 8, trunkRadiusBase: 0.18, trunkRadiusTip: 0.12,
          trunkSegments: 14, leanAngle: 8, leanCurvature: 0.8,
          leanAzimuth: 0, seed: 0.41,
        },
      });
      const tube = addNode(g, 'branch/tube', {
        id: 'tube',
        position: { x: 280, y: 0 },
        inputValues: { sides: 8, uvTilingV: 0.5 },
      });
      addEdge(g, { node: palm.id, socket: 'branches' }, { node: tube.id, socket: 'branches' });
      return { graph: g, rootNodeId: 'tube' };
    },
  },
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
