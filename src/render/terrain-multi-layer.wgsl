// Multi-layer terrain material. Up to 4 layers, weighted per pixel by an
// RGBA splat texture (R = layer 0 weight, …, A = layer 3). Each layer
// contributes its own albedo, tangent-space normal, height-for-blending,
// and roughness — packed into 4 texture-2d-arrays so the shader can
// sample layer i with `textureSample(..., array_index = i)` without
// growing the bind-group entry count with N.
//
// Two refinements over a naive splat blend:
//   1. Height-weighted blending. Each layer's height channel biases the
//      blend toward that layer where its local height is high — sharp
//      transitions ("painted") instead of muddy cross-fades. Strength
//      controlled by `params.heightBlendSharpness` (0 = pure splat).
//   2. Blend AFTER lighting. We shade each layer with its own albedo +
//      normal + roughness, then blend the lit results — so per-layer
//      roughness produces different specular response. Same trick as
//      `terrain-splat.wgsl`, extended to 4 layers.
//
// Bind group layout matches terrain-multi-layer-kind.ts:
//   @group(0) — scene uniforms + shared sampler + shadow map (same as PBR)
//   @group(1) @binding(0) — albedos (texture_2d_array<f32>, depth 4)
//   @group(1) @binding(1) — normals (texture_2d_array<f32>, depth 4)
//   @group(1) @binding(2) — heights (texture_2d_array<f32>, depth 4)
//   @group(1) @binding(3) — roughness (texture_2d_array<f32>, depth 4)
//   @group(1) @binding(4) — splat (texture_2d<f32>)
//   @group(1) @binding(5) — params uniform

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
};

struct TerrainParams {
  tile_scale: vec2f,
  metallic: f32,
  height_blend_sharpness: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var shadow_map: texture_depth_2d;
@group(0) @binding(3) var shadow_samp: sampler_comparison;

@group(1) @binding(0) var albedos: texture_2d_array<f32>;
@group(1) @binding(1) var normals: texture_2d_array<f32>;
@group(1) @binding(2) var heights: texture_2d_array<f32>;
@group(1) @binding(3) var roughs:  texture_2d_array<f32>;
@group(1) @binding(4) var splat:   texture_2d<f32>;
@group(1) @binding(5) var<uniform> params: TerrainParams;

struct VsIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) inst_col0: vec4f,
  @location(4) inst_col1: vec4f,
  @location(5) inst_col2: vec4f,
  @location(6) inst_col3: vec4f,
  @location(7) inst_tint: vec4f,
};

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) view_pos: vec3f,
  @location(1) view_normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) tint: vec4f,
  @location(4) world_pos: vec3f,
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
  let inst_mat = mat4x4f(in.inst_col0, in.inst_col1, in.inst_col2, in.inst_col3);
  let world_pos4 = inst_mat * vec4f(in.position, 1.0);
  let view_pos4 = uniforms.modelView * world_pos4;
  var out: VsOut;
  out.position = uniforms.projection * view_pos4;
  out.view_pos = view_pos4.xyz;
  out.world_pos = world_pos4.xyz;

  let inst_3x3 = mat3x3f(in.inst_col0.xyz, in.inst_col1.xyz, in.inst_col2.xyz);
  let world_normal = inst_3x3 * in.normal;
  let normal_mat = mat3x3f(
    uniforms.modelView[0].xyz,
    uniforms.modelView[1].xyz,
    uniforms.modelView[2].xyz,
  );
  out.view_normal = normal_mat * world_normal;
  out.uv = in.uv;
  out.tint = in.inst_tint;
  return out;
}

// sample_shadow + POISSON_DISK_16 are concatenated in from shadow-pcf.wgsl
// at module-creation time (see terrain-multi-layer-kind.ts).

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

fn apply_fog(lit: vec3f, view_pos_z: f32) -> vec3f {
  let visibility = exp(-uniforms.fog.w * abs(view_pos_z));
  return mix(srgb_to_linear(uniforms.fog.xyz), lit, visibility);
}

fn srgb_to_linear(color: vec3f) -> vec3f {
  return pow(color, vec3f(2.2));
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

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let tiled_uv = in.uv * params.tile_scale;
  let splat_sample = textureSample(splat, samp, in.uv);

  // Per-layer samples. textureSample on a texture_2d_array takes the
  // array slice index as the trailing integer arg. Even slots whose
  // splat weight is zero get sampled (uniform control flow would be
  // violated otherwise, since textureSample uses implicit derivatives);
  // their contribution drops to zero in the weighted sum below.
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

  // Height-weighted blending. Each layer's effective weight is
  //   splat_weight × exp(height × sharpness)
  // Exponential keeps every weight positive even with negative splat
  // values, and naturally lets the locally-tallest layer dominate
  // smoothly. Normalised to unity.
  let splat_w = vec4f(splat_sample.r, splat_sample.g, splat_sample.b, splat_sample.a);
  let h_bias = exp(vec4f(h0, h1, h2, h3) * params.height_blend_sharpness);
  var w = splat_w * h_bias;
  let total = w.x + w.y + w.z + w.w;
  // If the splat is all-zero we fall back to layer 0 to avoid a NaN /
  // black pixel; rarely happens in practice but cheap to guard.
  if (total < 0.0001) {
    w = vec4f(1.0, 0.0, 0.0, 0.0);
  } else {
    w = w / total;
  }

  // Normal: blend tangent-space normals first, then perturb the geom
  // normal in the cotangent frame. Built in the SAME UV space we sample
  // (tiled_uv) — see terrain-splat.wgsl for why dpdx(in.uv) is too
  // small at terrain scale to recover the tangent basis.
  let n_tangent = normalize(
    w.x * n0_raw + w.y * n1_raw + w.z * n2_raw + w.w * n3_raw,
  );
  let n_geom = normalize(in.view_normal);
  let tbn = cotangent_frame(n_geom, in.view_pos, tiled_uv);
  let n = normalize(tbn * n_tangent);

  // Per-layer shading, weighted blend of lit results. shadow sampled
  // once and shared — every layer is at the same world position.
  let shadow = sample_shadow(in.world_pos);
  let lit0 = shade(albedo0, in.view_pos, n, r0, params.metallic, shadow);
  let lit1 = shade(albedo1, in.view_pos, n, r1, params.metallic, shadow);
  let lit2 = shade(albedo2, in.view_pos, n, r2, params.metallic, shadow);
  let lit3 = shade(albedo3, in.view_pos, n, r3, params.metallic, shadow);
  let lit = w.x * lit0 + w.y * lit1 + w.z * lit2 + w.w * lit3;

  let final_color = apply_fog(lit, in.view_pos.z);
  return vec4f(final_color, 1.0);
}
