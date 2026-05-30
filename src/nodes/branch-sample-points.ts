import { addEdge, addNode, createGraph } from '../core/graph.js';
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
      min: 0,
      description: 'minimum branch depth (0=trunk, 1=primary, 2=secondary…); inclusive',
    },
    {
      name: 'depthMax',
      type: 'Int',
      default: 99,
      min: 0,
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
      min: 1,
      description:
        'points emitted per tip when onlyTips is true. 1 = oriented along tangent (flowers); N>1 = fanned radially around the tangent (palm fronds, needle clusters)',
    },
    { name: 'seed', type: 'Float', default: 0.5 },
  ],
  outputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: 'points on the branch SURFACE (offset by local radius from the centerline). Normals point outward radially so leaf/flower cards attached via [core/instance-geometry-on-points](../../core/instance-geometry-on-points) with `align: true` face away from the branch',
    },
  ],
  doc: {
    summary: 'Sample points on a BranchGraph\'s surface — leaf and flower placement.',
    description: `
Walks each branch's centerline and emits points on the SURFACE
(offset outward by the local radius), with normals pointing outward
radially. A downstream
[core/instance-geometry-on-points](../../core/instance-geometry-on-points)
with \`align: true\` attaches leaf cards / flowers / fruit flush to
the branch surface, facing away from it.

Filtering knobs let one tree wire this node multiple times for
different attachments:

- **LEAVES**: \`depthMin = 1\` (skip the trunk), \`radiusMax\` set
  tight to filter to thin twigs only, high \`density\` (30+),
  leaf-card instance. Tens of thousands of points for a hero tree.
- **FLOWERS / FRUIT**: \`onlyTips = true\`, lower density, own
  \`seed\`, fruit instance. Tip-only emission is what real plants do.
- **PALM FRONDS**: \`onlyTips = true\`, \`tipCount = 8–14\`, fan
  fronds radially around the trunk tangent.

Same source BranchGraph, different filters per consumer → leaves AND
flowers on the same tree without re-running the generator.
`,
    sampleGraph: () => {
      const g = createGraph();
      const branches = addNode(g, 'branch/recursive', {
        id: 'branches',
        position: { x: 0, y: 0 },
        inputValues: {
          trunkHeight: 4, trunkRadius: 0.2, trunkSegments: 8,
          maxDepth: 3, branchesPerSegment: 1, branchStart: 0.4,
          branchAngle: 50, branchAngleJitter: 12,
          lengthRatio: 0.65, radiusRatio: 0.55,
          branchCurvature: 4, phyllotaxisAngle: 137.5,
          segmentRatio: 0.75, minSegmentsPerBranch: 3,
          tipRadiusFraction: 0.2, seed: 0.31,
        },
      });
      const samples = addNode(g, 'branch/sample-points', {
        id: 'samples',
        position: { x: 280, y: 0 },
        inputValues: {
          depthMin: 1, depthMax: 99, radiusMin: 0, radiusMax: 0.1,
          onlyTips: false, density: 12, tipCount: 1, seed: 0.5,
        },
      });
      // Instance small cubes at the sample points so the wireframe
      // preview shows where leaves would attach.
      const cube = addNode(g, 'core/cube', {
        id: 'cube',
        position: { x: 0, y: 200 },
        inputValues: { size: 1 },
      });
      const inst = addNode(g, 'core/instance-geometry-on-points', {
        id: 'inst',
        position: { x: 560, y: 100 },
        inputValues: { scale: 0.08, align: true },
      });
      addEdge(g, { node: branches.id, socket: 'branches' }, { node: samples.id, socket: 'branches' });
      addEdge(g, { node: samples.id, socket: 'points' }, { node: inst.id, socket: 'points' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: inst.id, socket: 'instance' });
      return { graph: g, rootNodeId: 'inst' };
    },
  },
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
