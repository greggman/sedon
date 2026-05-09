import type { CpuMesh } from './mesh.js';

// 6 faces × 4 verts/face = 24 verts (so per-face UVs and flat normals are clean).
// Winding is CCW when viewed from outside, matching the sphere convention so
// default back-face culling drops the inside.
export function generateCube(size: number): CpuMesh {
  const h = size / 2;

  // Each face: [origin, edgeU, edgeV, normal]. Vertices are origin + (i,j) * edges
  // where (i,j) takes the values (0,0), (1,0), (1,1), (0,1) — quad CCW.
  const faces: Array<{
    origin: [number, number, number];
    eu: [number, number, number];
    ev: [number, number, number];
    n: [number, number, number];
  }> = [
    // +X
    { origin: [+h, -h, +h], eu: [0, 0, -size], ev: [0, +size, 0], n: [+1, 0, 0] },
    // -X
    { origin: [-h, -h, -h], eu: [0, 0, +size], ev: [0, +size, 0], n: [-1, 0, 0] },
    // +Y
    { origin: [-h, +h, +h], eu: [+size, 0, 0], ev: [0, 0, -size], n: [0, +1, 0] },
    // -Y
    { origin: [-h, -h, -h], eu: [+size, 0, 0], ev: [0, 0, +size], n: [0, -1, 0] },
    // +Z
    { origin: [-h, -h, +h], eu: [+size, 0, 0], ev: [0, +size, 0], n: [0, 0, +1] },
    // -Z
    { origin: [+h, -h, -h], eu: [-size, 0, 0], ev: [0, +size, 0], n: [0, 0, -1] },
  ];

  const positions = new Float32Array(24 * 3);
  const normals = new Float32Array(24 * 3);
  const uvs = new Float32Array(24 * 2);
  const indices = new Uint32Array(36);

  const corners: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];

  let p = 0;
  let u = 0;
  let i = 0;
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f]!;
    const base = f * 4;
    for (const [ci, cj] of corners) {
      positions[p] = face.origin[0] + face.eu[0] * ci + face.ev[0] * cj;
      positions[p + 1] = face.origin[1] + face.eu[1] * ci + face.ev[1] * cj;
      positions[p + 2] = face.origin[2] + face.eu[2] * ci + face.ev[2] * cj;
      normals[p] = face.n[0];
      normals[p + 1] = face.n[1];
      normals[p + 2] = face.n[2];
      uvs[u] = ci;
      uvs[u + 1] = 1 - cj;
      p += 3;
      u += 2;
    }
    indices[i++] = base;
    indices[i++] = base + 1;
    indices[i++] = base + 2;
    indices[i++] = base;
    indices[i++] = base + 2;
    indices[i++] = base + 3;
  }

  return { positions, normals, uvs, indices };
}
