import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { uploadMeshToGpu, type CpuMesh } from '../render/mesh.js';

// Transform UVs of an input geometry — multiplies by `scale`. Useful for
// tiling a texture more (or less) densely across a mesh than its source UVs
// dictate. A heightfield-to-mesh outputs UVs in [0,1] across the whole
// terrain, so a single grass-texture image stretches across all of it; pass
// the mesh through uv-transform with scale=[16, 16] and the texture tiles
// 16× in each direction, reading as proper close-range grass density.
//
// scale > 1 → texture appears smaller / repeats more
// scale < 1 → texture stretches / repeats less
//
// Repetition is handled by the sampler's `repeat` address mode (already on
// in createSharedSampler), so non-integer scales work fine.
export const uvTransformNode: NodeDef = {
  id: 'core/uv-transform',
  category: 'Geometry/Modifiers',
  inputs: [
    { name: 'geometry', type: 'Geometry' },
    {
      name: 'scale',
      type: 'Vec2',
      default: [1, 1],
      description: 'multiplier on UVs per axis; >1 tiles textures more densely',
    },
  ],
  outputs: [{ name: 'geometry', type: 'Geometry' }],
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const input = inputs.geometry as GeometryValue;
    if (!input.mesh) {
      throw new Error(
        'core/uv-transform requires a CPU-side mesh on the input geometry; ' +
          'this source produced GPU-only data.',
      );
    }
    const scale = inputs.scale as [number, number];
    const sx = scale[0];
    const sy = scale[1];

    const srcUv = input.mesh.uvs;
    const uvs = new Float32Array(srcUv.length);
    for (let i = 0; i < srcUv.length; i += 2) {
      uvs[i]     = srcUv[i]!     * sx;
      uvs[i + 1] = srcUv[i + 1]! * sy;
    }

    const out: CpuMesh = {
      positions: input.mesh.positions,
      normals: input.mesh.normals,
      uvs,
      indices: input.mesh.indices,
    };
    return { geometry: uploadMeshToGpu(device, out) };
  },
};
