import type { CpuMesh } from './mesh.js';

// XZ plane centered at origin, normal +Y. Winding is CCW from above so default
// back-face culling drops the underside.
//
// UV convention: U follows +X, V follows +Z (no flip). Combined with WebGPU's
// V=0-at-top-of-image sampling rule and the default preview camera (which
// looks down at the plane from +Z), this puts v=0 at the far edge → top of
// screen, matching how the node-thumbnail blit displays a texture. The
// earlier `1 - zi/divZ` mapping rendered textures upside-down relative to
// their authored orientation everywhere they landed on a plane.
export function generatePlane(
  width: number,
  depth: number,
  divX: number,
  divZ: number,
): CpuMesh {
  const numVertsX = divX + 1;
  const numVertsZ = divZ + 1;
  const numVerts = numVertsX * numVertsZ;

  const positions = new Float32Array(numVerts * 3);
  const normals = new Float32Array(numVerts * 3);
  const uvs = new Float32Array(numVerts * 2);

  let p = 0;
  let u = 0;
  for (let zi = 0; zi <= divZ; zi++) {
    for (let xi = 0; xi <= divX; xi++) {
      positions[p] = (xi / divX - 0.5) * width;
      positions[p + 1] = 0;
      positions[p + 2] = (zi / divZ - 0.5) * depth;
      normals[p] = 0;
      normals[p + 1] = 1;
      normals[p + 2] = 0;
      uvs[u] = xi / divX;
      uvs[u + 1] = zi / divZ;
      p += 3;
      u += 2;
    }
  }

  const indices = new Uint32Array(divX * divZ * 6);
  let i = 0;
  for (let zi = 0; zi < divZ; zi++) {
    for (let xi = 0; xi < divX; xi++) {
      const a = zi * numVertsX + xi;
      const b = a + numVertsX;
      indices[i++] = a;
      indices[i++] = b;
      indices[i++] = a + 1;
      indices[i++] = b;
      indices[i++] = b + 1;
      indices[i++] = a + 1;
    }
  }

  return { positions, normals, uvs, indices };
}
