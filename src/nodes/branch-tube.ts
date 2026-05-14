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
    { name: 'branches', type: 'BranchGraph' },
    {
      name: 'sides',
      type: 'Int',
      default: 8,
      description: 'cross-section segment count (6–8 distant, 16+ hero)',
    },
    {
      name: 'uvTilingV',
      type: 'Float',
      default: 0.5,
      description: 'V tiling rate per unit arc length (controls vertical bark tile density)',
    },
  ],
  outputs: [{ name: 'geometry', type: 'Geometry' }],
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
