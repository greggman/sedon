// Chunked-LOD terrain renderer.
//
// Architecture (matches terrain-render.ts):
//   • At field setup the renderer builds one shared "unit grid" mesh
//     per LOD level. Each mesh is a flat XZ plane in [-0.5, 0.5]²
//     with vertex count baseDivisions / 2^lod per edge.
//   • Each frame:
//       1. `lod_select` compute pass — one thread per chunk. Reads the
//          chunk's world center, computes camera distance, picks an
//          LOD, atomic-appends the chunk index into the per-LOD
//          instance buffer + bumps that LOD's drawIndirect arg's
//          instanceCount.
//       2. Render pass — one drawIndexedIndirect per LOD level. The
//          vertex shader instances the LOD's unit-grid mesh by the
//          chunk's world position, then samples the heightfield to
//          compute Y and the surface normal.
//   • Bind groups:
//       @group(0) — scene uniforms (shared with everything else)
//       @group(1) — terrain-multi-layer material bind group (verbatim
//                   the same layout as terrain-multi-layer-kind.ts
//                   produces — getBindGroupLayout caches by structural
//                   key so both pipelines share the same handle)
//       @group(2) — terrain-field data (terrain uniforms + height
//                   texture + chunk-instance buffer)
//
// The fragment shader is the same height-weighted multi-layer blend
// as terrain-multi-layer.wgsl. Duplicated rather than concat-included
// because terrain-multi-layer also declares vs_main / VsOut and
// concat-include would multiply-define them.

struct Uniforms {
  modelView: mat4x4f,
  projection: mat4x4f,
  lightViewProj: mat4x4f,
  lightDirWorld: vec3f,
  lightColor: vec3f,
  skyColor: vec3f,
  ambientIntensity: f32,
  groundColor: vec3f,
  fog: vec4f,
  time: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var shadow_map: texture_depth_2d;
@group(0) @binding(3) var shadow_samp: sampler_comparison;

// Multi-layer material bindings — identical layout to
// terrain-multi-layer-kind.ts's materialBindGroupLayout.
struct TerrainParams {
  tile_scale: vec2f,
  metallic: f32,
  height_blend_sharpness: f32,
};
@group(1) @binding(0) var albedos: texture_2d_array<f32>;
@group(1) @binding(1) var normals: texture_2d_array<f32>;
@group(1) @binding(2) var heights: texture_2d_array<f32>;
@group(1) @binding(3) var roughs:  texture_2d_array<f32>;
@group(1) @binding(4) var splat:   texture_2d<f32>;
@group(1) @binding(5) var<uniform> mat_params: TerrainParams;

// Per-field bindings.
struct TerrainU {
  // Layout chosen to avoid vec3 alignment surprises — every member
  // either packs cleanly into the prior slot or is a vec4. JS writer
  // in terrain-render.ts mirrors these offsets exactly.
  worldOrigin: vec2f,     // 0
  chunkSize: vec2f,       // 8
  chunkCount: vec2u,      // 16
  // _unused0/_unused1: heightRange is gone; the height texture's R
  // channel holds world Y in metres directly.
  _unused0: f32,          // 24
  _unused1: f32,          // 28
  lodLevels: u32,         // 32
  lodDistance: f32,       // 36
  baseDivisions: u32,     // 40
  // 0 = normal render. 1 = debug LOD visualisation (per-LOD colour
  // tint + derivative-based flat-shaded normals).
  debugMode: u32,         // 44
  cameraPos: vec4f,       // 48  (.w unused)
};
@group(2) @binding(0) var<uniform> tu: TerrainU;
@group(2) @binding(1) var heightTex: texture_2d<f32>;
@group(2) @binding(2) var heightSamp: sampler;
// chunk_instances[lod * maxChunks + i] = chunk index (cz * chunkCountX + cx).
// maxChunks = chunkCountX * chunkCountZ (one buffer slot per chunk per LOD).
@group(2) @binding(3) var<storage, read_write> chunk_instances: array<u32>;
// drawArgs[lod] = { indexCount, instanceCount(atomic), firstIndex, baseVertex, firstInstance }.
// indexCount / firstIndex / baseVertex / firstInstance are written from JS
// once per field (they depend on the LOD's mesh, not per-frame state).
struct DrawArgs {
  indexCount: u32,
  instanceCount: atomic<u32>,
  firstIndex: u32,
  baseVertex: u32,
  firstInstance: u32,
};
@group(2) @binding(4) var<storage, read_write> drawArgs: array<DrawArgs>;

// ---- LOD-selection compute ---------------------------------------
// One thread per chunk. Picks an LOD from camera distance and emits
// the chunk index into the LOD's slot in chunk_instances.
// (Render-pass reads chunk_instances + drawArgs as inputs.)
@compute @workgroup_size(64)
fn lod_select(@builtin(global_invocation_id) gid: vec3<u32>) {
  let totalChunks = tu.chunkCount.x * tu.chunkCount.y;
  if (gid.x >= totalChunks) { return; }
  let cx = gid.x % tu.chunkCount.x;
  let cz = gid.x / tu.chunkCount.x;
  // Chunk center in world XZ.
  let chunkCenterXZ = tu.worldOrigin
    + (vec2f(f32(cx), f32(cz)) + vec2f(0.5)) * tu.chunkSize;
  // Approximate Y at chunk center for a better 3D distance.
  let chunkCountF = vec2f(f32(tu.chunkCount.x), f32(tu.chunkCount.y));
  let uv = (vec2f(f32(cx), f32(cz)) + vec2f(0.5)) / chunkCountF;
  // R = world Y in metres directly — no remap.
  let chunkY = textureSampleLevel(heightTex, heightSamp, uv, 0.0).r;
  let chunkCenter = vec3f(chunkCenterXZ.x, chunkY, chunkCenterXZ.y);
  let dist = length(chunkCenter - tu.cameraPos.xyz);
  // LOD: floor(dist / lodDistance), clamped to [0, lodLevels-1].
  // LOD is chosen per-chunk from CHUNK-CENTER distance (so the whole
  // chunk renders with one mesh). The geomorph factor t, however,
  // is computed PER-VERTEX in vs_main from each vertex's own
  // distance to camera — that's what guarantees crack-free seams,
  // because two adjacent chunks share a vertex at the same world
  // position and so compute identical morph there.
  let distNorm = dist / max(tu.lodDistance, 0.0001);
  var lod = u32(max(0.0, floor(distNorm)));
  if (lod >= tu.lodLevels) { lod = tu.lodLevels - 1u; }
  let bucketBase = lod * totalChunks;
  let slot = atomicAdd(&drawArgs[lod].instanceCount, 1u);
  // 32-bit pack: 4 bits LOD (≤16 levels) | 28 bits chunkIdx
  // (≤256M chunks). The vertex shader reads this off a per-
  // instance attribute and unpacks.
  chunk_instances[bucketBase + slot] = (lod << 28u) | (gid.x & 0x0FFFFFFFu);
}

// ---- Render pipeline (vertex + fragment) -------------------------

struct VsIn {
  // Unit-grid mesh: per-vertex position in [-0.5, 0.5] X-Z. Y always 0.
  @location(0) gridPos: vec3f,
  // Per-instance packed value: 4 bits LOD | 8 bits morph quant |
  // 20 bits chunkIdx. Written by the lod_select compute kernel.
  @location(1) chunkPacked: u32,
};

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) view_pos: vec3f,
  @location(1) view_normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) tint: vec4f,
  @location(4) world_pos: vec3f,
  // Flat-interpolated LOD index — every fragment of a chunk sees the
  // same value. Used by the debug fragment path.
  @location(5) @interpolate(flat) lod: u32,
};

// Sample world Y (metres) at a heightfield UV. R = metres directly.
fn worldY(uv: vec2f) -> f32 {
  return textureSampleLevel(heightTex, heightSamp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).r;
}

@vertex
fn vs_main(in: VsIn) -> VsOut {
  let chunkIdx = in.chunkPacked & 0x0FFFFFFFu;
  let lod = (in.chunkPacked >> 28u) & 0xFu;
  let cx = chunkIdx % tu.chunkCount.x;
  let cz = chunkIdx / tu.chunkCount.x;
  // World XZ for this vertex of this chunk. gridPos is in [-0.5, 0.5];
  // chunkSize maps that to the chunk's world span; worldOrigin shifts
  // to the chunk's grid position.
  let chunkOrigin = tu.worldOrigin
    + (vec2f(f32(cx), f32(cz)) + vec2f(0.5)) * tu.chunkSize;
  let totalSize = vec2f(tu.chunkCount) * tu.chunkSize;

  // PER-VERTEX geomorph factor. The vertex's OWN distance to the
  // camera (not the chunk-center distance) drives the morph. This
  // is the crack-free property: two adjacent chunks at different
  // LODs share an edge vertex at the same world position, so they
  // compute the same distance, the same morphT, and arrive at the
  // same final position. T-junctions vanish.
  //
  // For the distance estimate we use the FINE vertex's height — an
  // approximation, but adjacent chunks see the same fine position
  // and the same heightfield sample at that UV, so they agree.
  let worldXZ_fine = chunkOrigin + in.gridPos.xz * tu.chunkSize;
  let uv_fine = (worldXZ_fine - tu.worldOrigin) / totalSize;
  let h_fine = worldY(uv_fine);
  let dist = length(vec3f(worldXZ_fine.x, h_fine, worldXZ_fine.y) - tu.cameraPos.xyz);
  let distNorm = dist / max(tu.lodDistance, 0.0001);
  let lodFrac = distNorm - f32(lod);
  let MORPH_START = 0.5;
  let morphT = clamp((lodFrac - MORPH_START) / (1.0 - MORPH_START), 0.0, 1.0);

  // Snap gridPos to the next-coarser LOD's vertex grid, then mix
  // between fine and snapped by morphT. At t=0 we render the fine
  // mesh as-is; at t=1 every fine vertex has collapsed onto a host
  // LOD+1 vertex (its degenerate triangles are invisible). Aligned
  // per-LOD grids (vertsPerEdge = (baseDivisions>>lod)+1, set in
  // terrain-render.ts) guarantee the snapped position IS a valid
  // LOD+1 vertex.
  //
  // Step size in [-0.5, 0.5] grid space at LOD+1 = 2 / divisions.
  let divisions = max(1u, tu.baseDivisions >> lod);
  let coarseStep = 2.0 / f32(divisions);
  let gridNorm = in.gridPos.xz + vec2f(0.5);              // [0, 1]
  let snappedNorm = round(gridNorm / coarseStep) * coarseStep;
  let gridCoarse = snappedNorm - vec2f(0.5);
  let gridMorphed = mix(in.gridPos.xz, gridCoarse, morphT);
  let worldXZ = chunkOrigin + gridMorphed * tu.chunkSize;
  // UV into the heightfield for sampling height + normal (totalSize
  // declared above for the morph-distance calc).
  let uv = (worldXZ - tu.worldOrigin) / totalSize;
  let h = worldY(uv);
  let worldPos = vec3f(worldXZ.x, h, worldXZ.y);

  // Normal via central differences in heightfield UV space. Step by
  // the heightfield's per-texel size — independent of chunk LOD, so
  // adjacent chunks at different LODs still agree on lit shading
  // direction.
  let texelStep = vec2f(1.0) / vec2f(textureDimensions(heightTex, 0));
  let hL = worldY(uv + vec2f(-texelStep.x, 0.0));
  let hR = worldY(uv + vec2f( texelStep.x, 0.0));
  let hD = worldY(uv + vec2f(0.0, -texelStep.y));
  let hU = worldY(uv + vec2f(0.0,  texelStep.y));
  let tX = 2.0 * texelStep.x * totalSize.x;
  let tZ = 2.0 * texelStep.y * totalSize.y;
  let nx = -(hR - hL) * tZ;
  let ny =  tX * tZ;
  let nz = -(hU - hD) * tX;
  let worldN = normalize(vec3f(nx, ny, nz));

  let view_pos4 = uniforms.modelView * vec4f(worldPos, 1.0);
  var out: VsOut;
  out.position = uniforms.projection * view_pos4;
  out.view_pos = view_pos4.xyz;
  out.world_pos = worldPos;
  let normal_mat = mat3x3f(
    uniforms.modelView[0].xyz,
    uniforms.modelView[1].xyz,
    uniforms.modelView[2].xyz,
  );
  out.view_normal = normal_mat * worldN;
  out.uv = uv;
  out.tint = vec4f(1.0);
  out.lod = lod;
  return out;
}

// ---- Multi-layer fragment shading (duplicated from terrain-multi-layer.wgsl
//      for the reasons in the top comment). Keep these in sync if the
//      material's lighting model changes.

const PI: f32 = 3.14159265359;

fn distribution_ggx(n_dot_h: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let n_dot_h2 = n_dot_h * n_dot_h;
  let denom = n_dot_h2 * (a2 - 1.0) + 1.0;
  return a2 / max(PI * denom * denom, 0.0001);
}
fn geometry_schlick_ggx(n_dot_v: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return n_dot_v / (n_dot_v * (1.0 - k) + k);
}
fn geometry_smith(n_dot_v: f32, n_dot_l: f32, roughness: f32) -> f32 {
  return geometry_schlick_ggx(n_dot_v, roughness) * geometry_schlick_ggx(n_dot_l, roughness);
}
fn fresnel_schlick(cos_theta: f32, f0: vec3f) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(clamp(1.0 - cos_theta, 0.0, 1.0), 5.0);
}
fn srgb_to_linear(color: vec3f) -> vec3f {
  return pow(color, vec3f(2.2));
}
fn apply_fog(lit: vec3f, view_pos_z: f32) -> vec3f {
  let visibility = exp(-uniforms.fog.w * abs(view_pos_z));
  return mix(srgb_to_linear(uniforms.fog.xyz), lit, visibility);
}
fn cotangent_frame(n: vec3f, p: vec3f, uv: vec2f) -> mat3x3f {
  let dp1 = dpdx(p);
  let dp2 = dpdy(p);
  let duv1 = dpdx(uv);
  let duv2 = dpdy(uv);
  let dp2perp = cross(dp2, n);
  let dp1perp = cross(n, dp1);
  let t = dp2perp * duv1.x + dp1perp * duv2.x;
  let b = dp2perp * duv1.y + dp1perp * duv2.y;
  let invmax = inverseSqrt(max(dot(t, t), dot(b, b)));
  return mat3x3f(t * invmax, b * invmax, n);
}
fn shade(albedo: vec3f, view_pos: vec3f, n: vec3f, roughness: f32, metallic: f32, shadow: f32) -> vec3f {
  let v = normalize(-view_pos);
  let l_world = normalize(uniforms.lightDirWorld);
  let view_rot = mat3x3f(
    uniforms.modelView[0].xyz,
    uniforms.modelView[1].xyz,
    uniforms.modelView[2].xyz,
  );
  let l = normalize(view_rot * l_world);
  let h = normalize(v + l);
  let n_dot_v = max(dot(n, v), 0.0);
  let n_dot_l = max(dot(n, l), 0.0);
  let n_dot_h = max(dot(n, h), 0.0);
  let h_dot_v = max(dot(h, v), 0.0);
  let f0 = mix(vec3f(0.04), albedo, metallic);
  let d = distribution_ggx(n_dot_h, roughness);
  let g = geometry_smith(n_dot_v, n_dot_l, roughness);
  let f = fresnel_schlick(h_dot_v, f0);
  let specular = (d * g * f) / max(4.0 * n_dot_v * n_dot_l, 0.0001);
  let k_s = f;
  let k_d = (vec3f(1.0) - k_s) * (1.0 - metallic);
  let n_world = transpose(view_rot) * n;
  let hemi_t = n_world.y * 0.5 + 0.5;
  let ambient_color = mix(uniforms.groundColor, uniforms.skyColor, hemi_t) * uniforms.ambientIntensity;
  let direct = (k_d * albedo / PI + specular) * uniforms.lightColor * n_dot_l * shadow;
  let ambient_term = albedo * ambient_color;
  return direct + ambient_term;
}

// Per-LOD debug colours, sRGB-authored. Each chunk's whole footprint
// gets one of these tints (flat-interpolated `lod` is constant across
// the chunk's fragments).
const DEBUG_LOD_COLORS = array<vec3f, 8>(
  vec3f(0.25, 0.85, 0.35), // LOD 0 — green (finest)
  vec3f(1.00, 0.85, 0.20), // LOD 1 — yellow
  vec3f(1.00, 0.55, 0.10), // LOD 2 — orange
  vec3f(0.95, 0.25, 0.20), // LOD 3 — red (coarsest)
  vec3f(0.65, 0.30, 0.85), // LOD 4 — purple
  vec3f(0.20, 0.55, 0.95), // LOD 5 — blue
  vec3f(0.95, 0.20, 0.85), // LOD 6 — magenta
  vec3f(0.95, 0.95, 0.95), // LOD 7 — white
);

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Debug LOD visualisation: flat-shaded, per-LOD tint, no material
  // sampling. Derivative-based normals from world-pos partials so
  // individual triangles read as distinct facets — adjacent triangles
  // on the same LOD share a flat shade, and LOD-vs-LOD changes show
  // as colour shifts at chunk borders.
  if (tu.debugMode == 1u) {
    let dx = dpdx(in.world_pos);
    let dy = dpdy(in.world_pos);
    let n_world = normalize(cross(dy, dx));
    let lod_idx = min(in.lod, 7u);
    let tint = DEBUG_LOD_COLORS[lod_idx];
    let view_rot = mat3x3f(
      uniforms.modelView[0].xyz,
      uniforms.modelView[1].xyz,
      uniforms.modelView[2].xyz,
    );
    let n_view = normalize(view_rot * n_world);
    // Simple lambert + ambient using the existing sun + sky.
    let l_world = normalize(uniforms.lightDirWorld);
    let l_view = normalize(view_rot * l_world);
    let n_dot_l = max(dot(n_view, l_view), 0.0);
    let hemi_t = n_world.y * 0.5 + 0.5;
    let ambient_color = mix(uniforms.groundColor, uniforms.skyColor, hemi_t) * uniforms.ambientIntensity;
    let lit_albedo = srgb_to_linear(tint);
    let lit = lit_albedo * (uniforms.lightColor * n_dot_l * 0.6 + ambient_color + vec3f(0.15));
    return vec4f(apply_fog(lit, in.view_pos.z), 1.0);
  }

  let tiled_uv = in.uv * mat_params.tile_scale;
  let splat_sample = textureSample(splat, samp, in.uv);

  let albedo0 = srgb_to_linear(textureSample(albedos, samp, tiled_uv, 0).rgb * in.tint.rgb);
  let albedo1 = srgb_to_linear(textureSample(albedos, samp, tiled_uv, 1).rgb * in.tint.rgb);
  let albedo2 = srgb_to_linear(textureSample(albedos, samp, tiled_uv, 2).rgb * in.tint.rgb);
  let albedo3 = srgb_to_linear(textureSample(albedos, samp, tiled_uv, 3).rgb * in.tint.rgb);

  let n0_raw = textureSample(normals, samp, tiled_uv, 0).rgb * 2.0 - vec3f(1.0);
  let n1_raw = textureSample(normals, samp, tiled_uv, 1).rgb * 2.0 - vec3f(1.0);
  let n2_raw = textureSample(normals, samp, tiled_uv, 2).rgb * 2.0 - vec3f(1.0);
  let n3_raw = textureSample(normals, samp, tiled_uv, 3).rgb * 2.0 - vec3f(1.0);

  let h0 = textureSample(heights, samp, tiled_uv, 0).r;
  let h1 = textureSample(heights, samp, tiled_uv, 1).r;
  let h2 = textureSample(heights, samp, tiled_uv, 2).r;
  let h3 = textureSample(heights, samp, tiled_uv, 3).r;

  let r0 = textureSample(roughs, samp, tiled_uv, 0).r;
  let r1 = textureSample(roughs, samp, tiled_uv, 1).r;
  let r2 = textureSample(roughs, samp, tiled_uv, 2).r;
  let r3 = textureSample(roughs, samp, tiled_uv, 3).r;

  let splat_w = vec4f(splat_sample.r, splat_sample.g, splat_sample.b, splat_sample.a);
  let h_bias = exp(vec4f(h0, h1, h2, h3) * mat_params.height_blend_sharpness);
  var w = splat_w * h_bias;
  let total = w.x + w.y + w.z + w.w;
  if (total < 0.0001) {
    w = vec4f(1.0, 0.0, 0.0, 0.0);
  } else {
    w = w / total;
  }
  let n_tangent = normalize(w.x * n0_raw + w.y * n1_raw + w.z * n2_raw + w.w * n3_raw);
  let n_geom = normalize(in.view_normal);
  let tbn = cotangent_frame(n_geom, in.view_pos, tiled_uv);
  let n = normalize(tbn * n_tangent);

  let shadow = sample_shadow(in.world_pos);
  let lit0 = shade(albedo0, in.view_pos, n, r0, mat_params.metallic, shadow);
  let lit1 = shade(albedo1, in.view_pos, n, r1, mat_params.metallic, shadow);
  let lit2 = shade(albedo2, in.view_pos, n, r2, mat_params.metallic, shadow);
  let lit3 = shade(albedo3, in.view_pos, n, r3, mat_params.metallic, shadow);
  let lit = w.x * lit0 + w.y * lit1 + w.z * lit2 + w.w * lit3;
  let final_color = apply_fog(lit, in.view_pos.z);
  return vec4f(final_color, 1.0);
}
