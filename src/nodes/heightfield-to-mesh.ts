import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue, HeightfieldValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { heightfieldToMesh, readHeightTexture } from '../render/heightfield.js';
import { uploadMeshToGpu } from '../render/mesh.js';

// Async: reads the heightfield's GPU texture back to CPU, builds a displaced
// XZ-plane mesh, uploads to GPU. Async eval lets us keep the heightfield as a
// pure Texture2D + metadata (composable with the entire texture toolkit)
// without a separate CPU heights path.
export const heightfieldToMeshNode: NodeDef = {
  id: 'core/heightfield-to-mesh',
  category: 'Heightfield/Convert',
  inputs: [
    { name: 'heightfield', type: 'Heightfield' },
    { name: 'divisions', type: 'Vec2i', default: [64, 64] },
  ],
  outputs: [{ name: 'geometry', type: 'Geometry' }],
  async evaluate(ctx, inputs): Promise<{ geometry: GeometryValue }> {
    const device = requireDevice(ctx);
    const field = inputs.heightfield as HeightfieldValue;
    const divisions = inputs.divisions as [number, number];

    const { heights, width, height } = await readHeightTexture(device, field.texture);
    const mesh = heightfieldToMesh({
      heights,
      width,
      height,
      worldSize: field.worldSize,
      heightRange: field.heightRange,
      divX: Math.max(1, Math.round(divisions[0])),
      divZ: Math.max(1, Math.round(divisions[1])),
    });
    return {
      geometry: uploadMeshToGpu(device, mesh, ctx.previousOutput?.geometry as GeometryValue | undefined),
    };
  },
};
