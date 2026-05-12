// Terrain splat material kind. Two PBR layers (basecolor + roughness each)
// blended per-pixel by a single-channel mask. Mask black = layer A, white =
// layer B. Layer-specific roughness lets dirt vs rock have visibly different
// micro-surface response without needing two separate scene-graph entities.
//
// Same scene/material bind-group split as PBR:
//   @group(0) — scene uniforms + sampler (shared across all kinds)
//   @group(1) — terrain-specific bindings:
//     binding 0: layerA basecolor
//     binding 1: layerB basecolor
//     binding 2: mask (R channel = layerB weight)
//     binding 3: per-material params (roughnessA, roughnessB)

struct Uniforms {
  modelView: mat4x4f,
  projection: mat4x4f,
  lightViewProj: mat4x4f,
  lightDirWorld: vec3f,
  lightColor: vec3f,
  ambient: vec3f,
  fog: vec4f,
};

struct TerrainParams {
  roughnessA: f32,
  roughnessB: f32,
  // UV tile rate for the two basecolor layers. Mask samples at base UVs
  // so the splat pattern follows terrain shape; only the textures tile.
  tile_scale: vec2f,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var shadow_map: texture_depth_2d;
@group(0) @binding(3) var shadow_samp: sampler_comparison;

@group(1) @binding(0) var layerA: texture_2d<f32>;
@group(1) @binding(1) var layerB: texture_2d<f32>;
@group(1) @binding(2) var mask: texture_2d<f32>;
@group(1) @binding(3) var<uniform> params: TerrainParams;
@group(1) @binding(4) var normalA: texture_2d<f32>;
@group(1) @binding(5) var normalB: texture_2d<f32>;

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

// Same shadow lookup as pbr.wgsl. See notes there. Inlined rather than
// shared because WGSL doesn't have an `#include` and we'd need a build
// step to share a function across shaders.
fn sample_shadow(world_pos: vec3f) -> f32 {
  let light_clip = uniforms.lightViewProj * vec4f(world_pos, 1.0);
  let shadow_uv = vec2f(light_clip.x * 0.5 + 0.5, 0.5 - light_clip.y * 0.5);
  let depth_ref = light_clip.z + 0.003;
  let in_bounds =
    all(shadow_uv >= vec2f(0.0)) && all(shadow_uv <= vec2f(1.0))
    && light_clip.z >= 0.0 && light_clip.z <= 1.0;
  let raw = textureSampleCompare(shadow_map, shadow_samp, shadow_uv, depth_ref);
  return select(1.0, raw, in_bounds);
}

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

// Per-pixel PBR shading at a known albedo/roughness/metallic. The terrain
// shader re-samples lighting per-layer and weights the result by the mask
// — that's important: blending after lighting (rather than blending albedos
// then lighting once) makes the per-layer roughness contribute to the
// specular response rather than averaging out.
// Takes already-linearized albedo. light_color / ambient are sRGB on
// the uniform side, linearized here so lighting math is in linear-light.
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
  let light_color = srgb_to_linear(uniforms.lightColor);
  let ambient = srgb_to_linear(uniforms.ambient);

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

  let direct = (k_d * albedo / PI + specular) * light_color * n_dot_l * shadow;
  let ambient_term = albedo * ambient;
  return direct + ambient_term;
}

fn apply_fog(lit: vec3f, view_pos_z: f32) -> vec3f {
  let visibility = exp(-uniforms.fog.w * abs(view_pos_z));
  return mix(srgb_to_linear(uniforms.fog.xyz), lit, visibility);
}

// Same sRGB ↔ linear + ACES trio as pbr.wgsl. Inlined rather than shared
// because WGSL has no import mechanism — keep the copies in sync when
// either is touched. See pbr.wgsl for the full reasoning.
fn srgb_to_linear(color: vec3f) -> vec3f {
  return pow(color, vec3f(2.2));
}

fn linear_to_srgb(color: vec3f) -> vec3f {
  return pow(color, vec3f(1.0 / 2.2));
}

fn khronos_neutral_tonemap(color_in: vec3f) -> vec3f {
  let startCompression = 0.8 - 0.04;
  let desaturation = 0.15;
  var color = color_in;
  let x = min(color.r, min(color.g, color.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  color = color - vec3f(offset);
  let peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) {
    return color;
  }
  let d = 1.0 - startCompression;
  let newPeak = 1.0 - d * d / (peak + d - startCompression);
  color = color * (newPeak / peak);
  let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3f(newPeak), g);
}

// Same cotangent-frame trick as the PBR shader. Reconstructs the
// tangent/bitangent on the fly from UV gradients so vertex tangents
// aren't required — works for procedurally-generated meshes that don't
// carry them.
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
  // Layer basecolors + tint are sRGB-authored colors; mask is data (0..1)
  // and stays linear.
  let aa = srgb_to_linear(textureSample(layerA, samp, tiled_uv).rgb * in.tint.rgb);
  let bb = srgb_to_linear(textureSample(layerB, samp, tiled_uv).rgb * in.tint.rgb);
  let t = clamp(textureSample(mask, samp, in.uv).r, 0.0, 1.0);

  // Sample per-layer tangent-space normals, mix by mask, perturb the
  // geometric normal. Missing normal maps are passed in as flat
  // (0.5, 0.5, 1.0) so this naturally degrades to "no perturbation."
  //
  // Critically, cotangent_frame is built in the SAME UV space the normal
  // maps are sampled in (tiled_uv, not in.uv). The mesh's base UVs span
  // 0..1 across the entire 100m terrain — dpdx/dpdy of that is tiny per
  // fragment, so the tangent basis computed from it would be near-zero
  // and the perturbation would vanish into floating-point noise.
  let n_a = textureSample(normalA, samp, tiled_uv).rgb * 2.0 - vec3f(1.0);
  let n_b = textureSample(normalB, samp, tiled_uv).rgb * 2.0 - vec3f(1.0);
  let n_tangent = normalize(mix(n_a, n_b, t));
  let n_geom = normalize(in.view_normal);
  let tbn = cotangent_frame(n_geom, in.view_pos, tiled_uv);
  let n = normalize(tbn * n_tangent);

  // Per-layer shading at the perturbed normal. Blend lit results (not
  // albedos) so per-layer roughness produces different specular response.
  // Terrain is non-metallic by design. Shadow sampled once and shared
  // between layers — they're at the same world position.
  let shadow = sample_shadow(in.world_pos);
  let lit_a = shade(aa, in.view_pos, n, params.roughnessA, 0.0, shadow);
  let lit_b = shade(bb, in.view_pos, n, params.roughnessB, 0.0, shadow);
  let lit = mix(lit_a, lit_b, t);
  let final_color = apply_fog(lit, in.view_pos.z);
  let display = linear_to_srgb(khronos_neutral_tonemap(final_color));

  return vec4f(display, 1.0);
}
