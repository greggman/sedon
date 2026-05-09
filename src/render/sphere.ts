export interface SphereMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

export function generateSphere(radius: number, segments: number, rings: number): SphereMesh {
  const vertCount = (rings + 1) * (segments + 1);
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);

  let p = 0;
  let u = 0;
  for (let r = 0; r <= rings; r++) {
    const phi = (Math.PI * r) / rings;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    for (let s = 0; s <= segments; s++) {
      const theta = (2 * Math.PI * s) / segments;
      const x = sinPhi * Math.cos(theta);
      const y = cosPhi;
      const z = sinPhi * Math.sin(theta);
      positions[p] = x * radius;
      positions[p + 1] = y * radius;
      positions[p + 2] = z * radius;
      normals[p] = x;
      normals[p + 1] = y;
      normals[p + 2] = z;
      uvs[u] = s / segments;
      uvs[u + 1] = r / rings;
      p += 3;
      u += 2;
    }
  }

  // Indices are wound CCW when viewed from outside the sphere, so default
  // back-face culling drops the inside surface, not the outside.
  const indices = new Uint32Array(rings * segments * 6);
  let i = 0;
  const stride = segments + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * stride + s;
      const b = a + stride;
      indices[i++] = a;
      indices[i++] = a + 1;
      indices[i++] = b;
      indices[i++] = a + 1;
      indices[i++] = b + 1;
      indices[i++] = b;
    }
  }

  return { positions, normals, uvs, indices };
}
