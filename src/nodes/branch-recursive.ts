import { addEdge, addNode, createGraph } from '../core/graph.js';
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
    { name: 'trunkSegments', type: 'Int', default: 10, min: 1 },
    {
      name: 'maxDepth',
      type: 'Int',
      default: 3,
      min: 0,
      description: 'recursion depth — 0 = trunk only, 3–5 typical',
    },
    {
      name: 'branchesPerSegment',
      type: 'Int',
      default: 1,
      min: 0,
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
    { name: 'minSegmentsPerBranch', type: 'Int', default: 3, min: 1 },
    {
      name: 'tipRadiusFraction',
      type: 'Float',
      default: 0.2,
      description: 'tip radius ÷ root radius (per branch, linear taper)',
    },
    { name: 'seed', type: 'Float', default: 0.31 },
  ],
  outputs: [
    {
      name: 'branches',
      type: 'BranchGraph',
      description: 'branch skeleton (centerlines + per-segment radii). Realize as a mesh via [branch/tube](../../branch/tube), or sample leaf/flower positions via [branch/sample-points](../../branch/sample-points)',
    },
  ],
  doc: {
    summary: 'Recursive parametric branching — trunk + children-per-segment ratios. Oak/birch/bush.',
    description: `
The canonical parametric branch generator. A trunk of \`trunkSegments\`
segments; at each segment in the branching zone (above
\`branchStart\` fraction of length), \`branchesPerSegment\` children
spawn at \`branchAngle\` from the parent tangent, rotated around the
trunk by \`phyllotaxisAngle\` between consecutive children. Each child
recursively spawns its own children down to \`maxDepth\`.

Per-child geometry comes from RATIOS off the parent:
- \`lengthRatio\` — child length ÷ parent length (0.65 = 35% shorter)
- \`radiusRatio\` — child root radius ÷ parent root radius
- \`segmentRatio\` — child segment count ÷ parent segment count
- \`tipRadiusFraction\` — each branch tapers linearly from root to tip

Use for stylized oak, birch, generic deciduous, bushes. Pair with
[branch/tropism](../../branch/tropism) downstream for natural droop,
then [branch/tube](../../branch/tube) for the renderable mesh and
[branch/sample-points](../../branch/sample-points) for leaf placements.

The other generator families have specialised topologies that this
generic node can't fake cleanly:
[branch/palm](../../branch/palm) for unbranched curving trunks,
[branch/whorled-pine](../../branch/whorled-pine) for monopodial conifers,
[branch/space-colonization](../../branch/space-colonization) for
canopy-driven naturalism.
`,
    sampleGraph: () => {
      const g = createGraph();
      const branches = addNode(g, 'branch/recursive', {
        id: 'branches',
        position: { x: 0, y: 0 },
        inputValues: {
          trunkHeight: 6, trunkRadius: 0.25, trunkSegments: 10,
          maxDepth: 3, branchesPerSegment: 1, branchStart: 0.4,
          branchAngle: 50, branchAngleJitter: 12,
          lengthRatio: 0.65, radiusRatio: 0.55,
          branchCurvature: 4, phyllotaxisAngle: 137.5,
          segmentRatio: 0.75, minSegmentsPerBranch: 3,
          tipRadiusFraction: 0.2, seed: 0.31,
        },
      });
      const tube = addNode(g, 'branch/tube', {
        id: 'tube',
        position: { x: 280, y: 0 },
        inputValues: { sides: 8, uvTilingV: 0.5 },
      });
      addEdge(g, { node: branches.id, socket: 'branches' }, { node: tube.id, socket: 'branches' });
      return { graph: g, rootNodeId: 'tube' };
    },
  },
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
