import type { CpuMesh } from './mesh.js';
import { mergeMeshes } from './mesh.js';

// Reflect a mesh across a plane and (optionally) merge with the
// original, doubling symmetric shapes. The classic use is "model one
// half of a chair, mirror to get the other" — saves modelling time
// AND keeps the two sides forced-identical so subsequent edits stay
// symmetric.
//
// Plane: axis-aligned, offset from origin. `axis` picks which world
// axis the plane is perpendicular to; `offset` is the plane's
// distance from origin along that axis (signed). For axis = 'X' and
// offset = 0, the plane is YZ — every point gets its x flipped.
//
// Reflection flips an odd number of axes → flips face winding. We
// reverse triangle vertex order in the indices to keep CCW-from-
// outside, so back-face culling stays correct on the mirrored half.

export type MirrorAxis = 'X' | 'Y' | 'Z';

export interface MirrorOptions {
  axis: MirrorAxis;
  offset: number;
  /**
   * When true (default), the output is the input + its mirror joined
   * into one mesh. When false, ONLY the mirrored copy is returned —
   * useful when the caller has already arranged the original
   * elsewhere and just needs the reflected half.
   */
  weld?: boolean;
}

function reflectComponent(axis: MirrorAxis): 0 | 1 | 2 {
  return axis === 'X' ? 0 : axis === 'Y' ? 1 : 2;
}

export function mirrorMesh(mesh: CpuMesh, opts: MirrorOptions): CpuMesh {
  const componentIdx = reflectComponent(opts.axis);
  const offset = opts.offset;
  const weld = opts.weld ?? true;

  const vCount = mesh.positions.length / 3;
  const positions = new Float32Array(mesh.positions.length);
  const normals = new Float32Array(mesh.normals.length);
  const uvs = new Float32Array(mesh.uvs);
  // 2 * offset - p   reflects p across plane `axis = offset`.
  for (let i = 0; i < vCount; i++) {
    positions[i * 3]     = mesh.positions[i * 3]!;
    positions[i * 3 + 1] = mesh.positions[i * 3 + 1]!;
    positions[i * 3 + 2] = mesh.positions[i * 3 + 2]!;
    normals[i * 3]     = mesh.normals[i * 3]!;
    normals[i * 3 + 1] = mesh.normals[i * 3 + 1]!;
    normals[i * 3 + 2] = mesh.normals[i * 3 + 2]!;
    positions[i * 3 + componentIdx] = 2 * offset - mesh.positions[i * 3 + componentIdx]!;
    // Flip the normal component along the reflected axis so lighting
    // matches the new surface orientation.
    normals[i * 3 + componentIdx] = -mesh.normals[i * 3 + componentIdx]!;
  }

  // Reverse triangle winding: reflecting flips an odd number of axes,
  // so what was CCW becomes CW. Swap any two vertices of each triangle.
  const indices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i += 3) {
    indices[i]     = mesh.indices[i]!;
    indices[i + 1] = mesh.indices[i + 2]!;
    indices[i + 2] = mesh.indices[i + 1]!;
  }

  const mirrored: CpuMesh = { positions, normals, uvs, indices };
  return weld ? mergeMeshes(mesh, mirrored) : mirrored;
}
