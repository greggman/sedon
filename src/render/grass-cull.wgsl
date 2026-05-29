// Grass placement compute pass. One thread per candidate grid cell in
// a camera-centered grid. Each surviving blade is atomic-appended into
// `instances`, and the indirect-draw `instanceCount` is the same atomic
// counter — so the subsequent drawIndexedIndirect renders exactly the
// survivors with no CPU readback.
//
// World↔UV mapping matches texture-to-heightfield-mesh
// (src/render/heightfield.ts):
//   u = worldX / worldSizeX + 0.5,  v = worldZ / worldSizeZ + 0.5
//   worldY = heightTex.r(u,v)            // R = world Y in metres directly
// so blades sit exactly on the terrain surface.

struct GrassU {
  viewProj: mat4x4f,
  cameraPos: vec4f,   // xyz camera world pos, w = time (seconds)
  grid: vec4f,        // originCellX, originCellZ (integer cell indices), spacing, gridDim(f32)
  worldMap: vec4f,    // worldSizeX, worldSizeZ, _unused0, _unused1
  params0: vec4f,     // maxDistance, densityScale, maxSlope(0..1), numTypes
  blade: vec4f,       // bladeW, bladeH, windStrength, windSpeed
  baseColor: vec4f,   // rgb, colorVariation
  tipColor: vec4f,    // rgb, seed
  counts: vec4u,      // candidateCount, gridDim, maxInstances, hasTypeMap(0/1)
};

struct GrassInstance {
  posScale: vec4f,    // xyz world pos, w = scale multiplier
  data: vec4f,        // yaw, typeIndex, fade, colorRand
};

struct IndirectArgs {
  indexCount: u32,
  instanceCount: atomic<u32>,
  firstIndex: u32,
  baseVertex: u32,
  firstInstance: u32,
};

@group(0) @binding(0) var<uniform> u: GrassU;
@group(0) @binding(1) var<storage, read_write> instances: array<GrassInstance>;
@group(0) @binding(2) var<storage, read_write> args: IndirectArgs;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var densityTex: texture_2d<f32>;
@group(0) @binding(5) var typeTex: texture_2d<f32>;
@group(0) @binding(6) var heightTex: texture_2d<f32>;

// Cheap hash noise (Dave Hoskins style) for stochastic keep, jitter,
// yaw, scale, colour. Deterministic per (cell, seed).
fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
fn hash22(p: vec2f) -> vec2f {
  var p3 = fract(vec3f(p.x, p.y, p.x) * vec3f(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
fn sampleH(uv: vec2f) -> f32 {
  return textureSampleLevel(heightTex, samp, uv, 0.0).r;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= u.counts.x) { return; }

  let seed = u.tipColor.w;
  let gridDim = u.counts.y;
  let localX = idx % gridDim;
  let localZ = idx / gridDim;
  let spacing = u.grid.z;

  // GLOBAL world-cell index. The grid window is camera-centered, so the
  // local cell index (0..gridDim) shifts as the camera moves — but the
  // *global* cell index (origin cell + local) is fixed to a world
  // location. Keying every per-blade value (jitter, yaw, scale, keep,
  // type) to the GLOBAL cell is what stops the field from "swimming":
  // a blade at a given world spot keeps the same hash regardless of
  // where the camera is. (u.grid.xy carry the origin cell index, not a
  // world coordinate.)
  let gcx = i32(u.grid.x) + i32(localX);
  let gcz = i32(u.grid.y) + i32(localZ);
  let cellX = f32(gcx);
  let cellZ = f32(gcz);

  // In-cell jitter so the grid never reads as rows. Position is derived
  // straight from the global cell, so it's also camera-stable.
  let j = hash22(vec2f(cellX + seed, cellZ - seed));
  let worldX = (cellX + j.x) * spacing;
  let worldZ = (cellZ + j.y) * spacing;

  // Distance cull (XZ ring around camera).
  let dx = worldX - u.cameraPos.x;
  let dz = worldZ - u.cameraPos.z;
  let distXZ = sqrt(dx * dx + dz * dz);
  let maxDist = u.params0.x;
  if (distXZ > maxDist) { return; }

  // World XZ → terrain UV. Outside the terrain extent ⇒ no grass.
  let uv = vec2f(worldX / u.worldMap.x + 0.5, worldZ / u.worldMap.y + 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return; }

  // Stochastic keep against the density map × global scale.
  let density = textureSampleLevel(densityTex, samp, uv, 0.0).r * u.params0.y;
  let keepRand = hash21(vec2f(cellX - 7.0, cellZ + 13.0) + seed);
  if (keepRand > density) { return; }

  // Terrain height + slope (finite-difference normal). R = world Y in
  // metres directly — no remap.
  let worldY = sampleH(uv);
  let eps = 2.0 / 512.0;
  let hL = sampleH(uv - vec2f(eps, 0.0));
  let hR = sampleH(uv + vec2f(eps, 0.0));
  let hD = sampleH(uv - vec2f(0.0, eps));
  let hU = sampleH(uv + vec2f(0.0, eps));
  let gx = (hR - hL) / (2.0 * eps * u.worldMap.x);
  let gz = (hU - hD) / (2.0 * eps * u.worldMap.y);
  let n = normalize(vec3f(-gx, 1.0, -gz));
  // params0.z = maxSlope (0 = flat only, 1 = any). Keep where the
  // surface is flatter than that → normal.y ≥ (1 - maxSlope).
  if (n.y < 1.0 - u.params0.z) { return; }

  // Frustum cull: project the blade base. Behind camera or well
  // outside the FOV (with margin for wind/scale overhang) ⇒ skip.
  let clip = u.viewProj * vec4f(worldX, worldY, worldZ, 1.0);
  if (clip.w <= 0.0) { return; }
  let m = clip.w * 1.25;
  if (clip.x < -m || clip.x > m || clip.y < -m || clip.y > m) { return; }

  // Type from the type map (R → [0, numTypes)). No map ⇒ type 0.
  var typeIndex = 0.0;
  if (u.counts.w == 1u) {
    let t = textureSampleLevel(typeTex, samp, uv, 0.0).r;
    typeIndex = floor(min(t * u.params0.w, u.params0.w - 1.0));
  }

  let yaw = hash21(vec2f(cellX + 1.0, cellZ + 2.0) + seed) * 6.2831853;
  let scaleRand = 0.7 + 0.6 * hash21(vec2f(cellX + 5.0, cellZ + 9.0) + seed);
  let colorRand = hash21(vec2f(cellX - 3.0, cellZ + 4.0) + seed);
  // Fade in over the last 20% of the draw distance.
  let fade = clamp((maxDist - distXZ) / (maxDist * 0.2), 0.0, 1.0);

  let slot = atomicAdd(&args.instanceCount, 1u);
  if (slot >= u.counts.z) { return; } // clamp to instance-buffer capacity
  instances[slot].posScale = vec4f(worldX, worldY, worldZ, scaleRand);
  instances[slot].data = vec4f(yaw, typeIndex, fade, colorRand);
}
