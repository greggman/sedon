import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import {
  sweepBranchGraphToMesh,
  type BranchGraphValue,
} from '../render/branch-graph.js';
import { uploadMeshToGpu } from '../render/mesh.js';

// Sweep a tapered tube around every branch in the input BranchGraph.
// Phase 1: branch-to-parent joins are plain intersection (no Y-joint
// blending). The emitted mesh has cylindrical bark UVs (U around the
// trunk, V along arc length × uvTilingV) so any tiling bark material
// from the texture pipeline applies cleanly.
//
// Future: emit per-vertex `branchDepth`, `branchId`, and
// `arcLengthAlongBranch` attributes for wind sway / depth-blended
// materials (see tree-bush-plan.md §6). Holding off until GeometryValue
// gains an extra-attributes slot — packing them into UVs would be a
// retrofitting headache.
export const branchTubeNode: NodeDef = {
  id: 'branch/tube',
  category: 'Branches/Realize',
  inputs: [
    {
      name: 'branches',
      type: 'BranchGraph',
      description: 'input branch skeleton (from any [branch/recursive](../../branch/recursive), [branch/palm](../../branch/palm), [branch/whorled-pine](../../branch/whorled-pine), [branch/space-colonization](../../branch/space-colonization), or [branch/merge](../../branch/merge) chain — optionally bent through [branch/tropism](../../branch/tropism))',
    },
    {
      name: 'sides',
      type: 'Int',
      default: 8,
      min: 3,
      description: 'cross-section segment count. 6–8 for distant trees; 16+ for hero close-ups',
    },
    {
      name: 'uvTilingV',
      type: 'Float',
      default: 0.5,
      description: 'V tiling rate per unit arc length — controls vertical bark tile density. 0.5 = one bark tile per 2m of trunk',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'one merged tube mesh covering every branch in the input graph. UVs run U around each tube and V along arc length × `uvTilingV`, so any tiling bark texture applies cleanly',
    },
  ],
  doc: {
    summary: 'Sweep a tapered tube around every branch in a BranchGraph → renderable Geometry.',
    description: `
The terminal realize node for branches. Sweeps a circular cross-section
(\`sides\` segments) along every branch's centerline, tapering the
radius from root to tip according to the per-segment radii authored
by the generator. The output is one merged mesh — every branch and
every twig in the same Geometry — ready to wire into
[scene/entity](../../scene/entity) with a bark material.

UV layout: U runs once around each tube cross-section, V runs along
the arc length multiplied by \`uvTilingV\`. That makes tiling bark
textures Just Work — set the bark material's \`detail_scale\` for
close-up texture density, this node's \`uvTilingV\` for repeat rate
along trunk length.

Branch-to-parent joins are plain intersection (no Y-joint blending) in
v1. Acceptable at distance; for hero close-ups, model the visible
joints by hand. For leaf placement, sample the SAME upstream graph
through [branch/sample-points](../../branch/sample-points) instead of
this node.
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
        inputValues: { sides: 12, uvTilingV: 0.5 },
      });
      addEdge(g, { node: branches.id, socket: 'branches' }, { node: tube.id, socket: 'branches' });
      return { graph: g, rootNodeId: 'tube' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const branches = inputs.branches as BranchGraphValue;
    const mesh = sweepBranchGraphToMesh(branches, {
      sides: inputs.sides as number,
      uvTilingV: inputs.uvTilingV as number,
    });
    return {
      geometry: uploadMeshToGpu(
        device,
        mesh,
        ctx.previousOutput?.geometry as GeometryValue | undefined,
      ),
    };
  },
};
