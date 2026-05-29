// GPU texture-to-heightfield-mesh. Generates a tessellated XZ-plane
// mesh directly into GPU vertex / index buffers by sampling a height
// texture (R channel = world Y in metres). No CPU readback — the
// geometry is renderable the same encoder tick it's produced.
//
// Two entry points:
//   write_vertices — one thread per vertex; samples height + computes
//     normal via central differences and writes pos/normal/uv to the
//     three vertex buffers.
//   write_indices  — one thread per quad; writes the 6 indices for
//     this quad's two triangles.

struct Params {
  // resolution of the output vertex grid.
  numX: u32,           // divX + 1 (vertices along X)
  numZ: u32,           // divZ + 1 (vertices along Z)
  worldW: f32,
  worldD: f32,
  invDivX: f32,        // 1.0 / divX
  invDivZ: f32,        // 1.0 / divZ
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> positions: array<f32>;
@group(0) @binding(2) var<storage, read_write> normals: array<f32>;
@group(0) @binding(3) var<storage, read_write> uvs: array<f32>;
@group(0) @binding(4) var<storage, read_write> indices: array<u32>;
@group(0) @binding(5) var heightTex: texture_2d<f32>;
@group(0) @binding(6) var samp: sampler;

fn worldHeight(u: f32, v: f32) -> f32 {
  // R channel IS world Y in metres — no remap.
  let uv = vec2f(clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0));
  return textureSampleLevel(heightTex, samp, uv, 0.0).r;
}

@compute @workgroup_size(8, 8, 1)
fn write_vertices(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.numX || gid.y >= params.numZ) {
    return;
  }
  let xi = gid.x;
  let zi = gid.y;
  let u01 = f32(xi) * params.invDivX;
  let v   = f32(zi) * params.invDivZ;
  let x = (u01 - 0.5) * params.worldW;
  let z = (v   - 0.5) * params.worldD;
  let h = worldHeight(u01, v);

  // Central-difference normal: sample neighbouring vertices one
  // tessellation cell over in U and V, build (∂x/∂u, ∂y/∂u, ∂z/∂u)
  // and the V counterpart, cross-product → normal. Edge cells use
  // one-sided differences via clamp inside worldHeight.
  let uL = max(0.0, u01 - params.invDivX);
  let uR = min(1.0, u01 + params.invDivX);
  let vD = max(0.0, v   - params.invDivZ);
  let vU = min(1.0, v   + params.invDivZ);
  let hL = worldHeight(uL, v);
  let hR = worldHeight(uR, v);
  let hDz = worldHeight(u01, vD);
  let hUz = worldHeight(u01, vU);
  let tX = (uR - uL) * params.worldW;
  let tZ = (vU - vD) * params.worldD;
  let nx = -(hR - hL) * tZ;
  let ny =  tX * tZ;
  let nz = -(hUz - hDz) * tX;
  let nlen = max(sqrt(nx * nx + ny * ny + nz * nz), 0.000001);

  let vi = zi * params.numX + xi;
  let p3 = vi * 3u;
  positions[p3] = x;
  positions[p3 + 1u] = h;
  positions[p3 + 2u] = z;
  normals[p3] = nx / nlen;
  normals[p3 + 1u] = ny / nlen;
  normals[p3 + 2u] = nz / nlen;
  let u2 = vi * 2u;
  uvs[u2] = u01;
  // V flip so the heightfield's +V (bottom of texture in screen space)
  // maps to +Z (back of terrain).
  uvs[u2 + 1u] = 1.0 - v;
}

@compute @workgroup_size(8, 8, 1)
fn write_indices(@builtin(global_invocation_id) gid: vec3<u32>) {
  let divX = params.numX - 1u;
  let divZ = params.numZ - 1u;
  if (gid.x >= divX || gid.y >= divZ) {
    return;
  }
  let xi = gid.x;
  let zi = gid.y;
  let a = zi * params.numX + xi;
  let b = a + params.numX;
  let quadIdx = zi * divX + xi;
  let base = quadIdx * 6u;
  indices[base]      = a;
  indices[base + 1u] = b;
  indices[base + 2u] = a + 1u;
  indices[base + 3u] = b;
  indices[base + 4u] = b + 1u;
  indices[base + 5u] = a + 1u;
}
