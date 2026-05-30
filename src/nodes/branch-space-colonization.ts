import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue } from '../core/resources.js';
import {
  generateSpaceColonizationBranchGraph,
  type BranchGraphValue,
} from '../render/branch-graph.js';

// Runions-style space-colonization canopy grower. Takes a PointCloud of
// attractor positions (typically `core/sphere` → `core/distribute-in-volume`
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
      description: 'attractor points the tree grows toward (typically distribute-in-volume of a canopy mesh)',
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
    { name: 'maxIterations', type: 'Int', default: 200, min: 1 },
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
  outputs: [
    {
      name: 'branches',
      type: 'BranchGraph',
      description: 'a BranchGraph grown toward the attractor cloud, with radii assigned via Murray\'s law. Realize via [branch/tube](../../branch/tube)',
    },
  ],
  doc: {
    summary: 'Space-colonization tree grower — grows toward a PointCloud of attractors.',
    description: `
The Runions-style canopy grower, the best naturalism algorithm for
big-canopy deciduous trees (oak, maple, beech). Takes a PointCloud of
attractor positions defining the rough canopy shape and grows a tree
from \`trunkStart\` toward them.

The algorithm: each iteration, every attractor influences its nearest
node within \`attractorRadius\`; each node advances by
\`segmentLength\` in the average direction of its influencers (with a
small \`upBias\` to avoid horizontal sprawl); attractors within
\`killRadius\` of any node get consumed. Repeat until no attractors
remain or \`maxIterations\` is reached. After growth, radii are
assigned via Murray's law (\`radiusExponent\` 2.5–3.0 is
naturalistic).

For the attractor cloud, the canonical pattern is
[core/sphere](../../core/sphere) →
[core/distribute-in-volume](../../core/distribute-in-volume) for a
spherical envelope. Any mesh works — distribute on an ellipsoid for a
flame-shaped tree, on a stretched cube for hedgerow.

Heavier compute than the recursive / whorled / palm generators: each
iteration is O(attractors × nodes). Keep the attractor count in the
hundreds for interactive editing; bump for hero shots.
`,
    sampleGraph: () => {
      const g = createGraph();
      // Sphere → distribute-in-volume → canopy attractors for the
      // space-colonization grower → tube. The sphere is offset upward
      // to act as the crown above the trunk-start.
      const sphere = addNode(g, 'core/sphere', {
        id: 'sphere',
        position: { x: 0, y: 0 },
        inputValues: { radius: 3, segments: 16, rings: 12 },
      });
      const shift = addNode(g, 'core/transform', {
        id: 'shift',
        position: { x: 280, y: 0 },
        inputValues: { translate: [0, 5, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
      });
      const attractors = addNode(g, 'core/distribute-in-volume', {
        id: 'attractors',
        position: { x: 560, y: 0 },
        inputValues: { density: 8, seed: 0.5 },
      });
      const branches = addNode(g, 'branch/space-colonization', {
        id: 'branches',
        position: { x: 840, y: 0 },
        inputValues: {
          trunkStart: [0, 0, 0], trunkInitialDirection: [0, 1, 0],
          attractorRadius: 4, killRadius: 0.6, segmentLength: 0.4,
          maxIterations: 200, upBias: 0.15,
          rootRadius: 0.32, tipRadius: 0.04, radiusExponent: 2.5,
        },
      });
      const tube = addNode(g, 'branch/tube', {
        id: 'tube',
        position: { x: 1120, y: 0 },
        inputValues: { sides: 8, uvTilingV: 0.5 },
      });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: shift.id, socket: 'geometry' });
      addEdge(g, { node: shift.id, socket: 'geometry' }, { node: attractors.id, socket: 'geometry' });
      addEdge(g, { node: attractors.id, socket: 'points' }, { node: branches.id, socket: 'attractors' });
      addEdge(g, { node: branches.id, socket: 'branches' }, { node: tube.id, socket: 'branches' });
      return { graph: g, rootNodeId: 'tube' };
    },
  },
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
