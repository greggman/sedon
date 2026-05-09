export interface SphereMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

export function generateSphere(radius: number, segments: number, rings: number): SphereMesh {
  const vertCount = (rings + 1) * (segments + 1);
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);

  let v = 0;
  for (let r = 0; r <= rings; r++) {
    const phi = (Math.PI * r) / rings;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    for (let s = 0; s <= segments; s++) {
      const theta = (2 * Math.PI * s) / segments;
      const x = sinPhi * Math.cos(theta);
      const y = cosPhi;
      const z = sinPhi * Math.sin(theta);
      positions[v] = x * radius;
      positions[v + 1] = y * radius;
      positions[v + 2] = z * radius;
      normals[v] = x;
      normals[v + 1] = y;
      normals[v + 2] = z;
      v += 3;
    }
  }

  const indices = new Uint32Array(rings * segments * 6);
  let i = 0;
  const stride = segments + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * stride + s;
      const b = a + stride;
      indices[i++] = a;
      indices[i++] = b;
      indices[i++] = a + 1;
      indices[i++] = b;
      indices[i++] = b + 1;
      indices[i++] = a + 1;
    }
  }

  return { positions, normals, indices };
}
