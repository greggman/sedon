import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import {
  applyTropismToBranchGraph,
  type BranchGraphValue,
} from '../render/branch-graph.js';

// Bend the curves in a BranchGraph under gravity / sun / random wobble.
// Out-of-place: returns a new BranchGraph; the trunk (depth 0) is never
// bent, and children's bases follow their bent parents so the topology
// stays glued (their offset is inherited from the parent's vertex
// offset at the attach point).
//
// Cheap, stackable, large naturalism payoff. Place between the generator
// and `branch/tube` / `branch/sample-points`.
export const branchTropismNode: NodeDef = {
  id: 'branch/tropism',
  category: 'Branches/Modifiers',
  inputs: [
    { name: 'branches', type: 'BranchGraph' },
    {
      name: 'gravity',
      type: 'Float',
      default: 0.12,
      description: 'sag strength per unit branch length (per depth tier); 0 = no sag',
    },
    {
      name: 'phototropism',
      type: 'Vec3',
      default: [0, 0, 0],
      description: 'world-space direction × strength branches bend toward (e.g. toward the sun)',
    },
    {
      name: 'wobble',
      type: 'Float',
      default: 0.02,
      description: 'per-vertex random jitter magnitude (scales with depth)',
    },
    { name: 'wobbleSeed', type: 'Float', default: 0.7 },
  ],
  outputs: [
    {
      name: 'branches',
      type: 'BranchGraph',
      description: 'a new BranchGraph with vertices bent under gravity / phototropism / random wobble. Topology is preserved — children stay glued to their bent parents',
    },
  ],
  doc: {
    summary: 'Bend BranchGraph curves under gravity, sun, and random wobble.',
    description: `
A pure modifier — takes a BranchGraph in, returns a new one with the
curves bent. The trunk (depth 0) is never bent, and each child's base
follows its parent's bent vertex at the attach point, so the topology
stays glued together.

Three forces compose:
- **gravity** — sag strength per unit branch length. Scales WITH depth
  so primary branches sag less than tertiary twigs. The big naturalism
  payoff for [branch/whorled-pine](../../branch/whorled-pine) (pine
  droop) and any deciduous tree with weight-loaded branches.
- **phototropism** — Vec3 direction × strength branches bend toward.
  Wire \`[0.3, 0.2, 0]\` for a tree leaning toward sunlight from the
  east. Magnitude is the bend strength.
- **wobble** — per-vertex random jitter. Breaks the mathematical
  regularity of the parametric generators. Small values (0.01–0.05)
  give natural irregularity; larger reads as windswept chaos.

Cheap, stackable, large naturalism payoff. Place between the
generator and [branch/tube](../../branch/tube) /
[branch/sample-points](../../branch/sample-points).
`,
    sampleGraph: () => {
      const g = createGraph();
      // Take the recursive tree and add a hefty gravity sag so the
      // tropism's effect is visually obvious.
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
      const tropism = addNode(g, 'branch/tropism', {
        id: 'tropism',
        position: { x: 280, y: 0 },
        inputValues: { gravity: 0.25, phototropism: [0, 0, 0], wobble: 0.03, wobbleSeed: 0.7 },
      });
      const tube = addNode(g, 'branch/tube', {
        id: 'tube',
        position: { x: 560, y: 0 },
        inputValues: { sides: 8, uvTilingV: 0.5 },
      });
      addEdge(g, { node: branches.id, socket: 'branches' }, { node: tropism.id, socket: 'branches' });
      addEdge(g, { node: tropism.id, socket: 'branches' }, { node: tube.id, socket: 'branches' });
      return { graph: g, rootNodeId: 'tube' };
    },
  },
  evaluate(_ctx, inputs): { branches: BranchGraphValue } {
    const branches = inputs.branches as BranchGraphValue;
    return {
      branches: applyTropismToBranchGraph(branches, {
        gravity: inputs.gravity as number,
        phototropism: inputs.phototropism as [number, number, number],
        wobble: inputs.wobble as number,
        wobbleSeed: inputs.wobbleSeed as number,
      }),
    };
  },
};
