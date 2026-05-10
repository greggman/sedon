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
  lightDirWorld: vec3f,
  lightColor: vec3f,
  ambient: vec3f,
  fog: vec4f,
};

struct TerrainParams {
  roughnessA: f32,
  roughnessB: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var samp: sampler;

@group(1) @binding(0) var layerA: texture_2d<f32>;
@group(1) @binding(1) var layerB: texture_2d<f32>;
@group(1) @binding(2) var mask: texture_2d<f32>;
@group(1) @binding(3) var<uniform> params: TerrainParams;

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
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
  let inst_mat = mat4x4f(in.inst_col0, in.inst_col1, in.inst_col2, in.inst_col3);
  let world_pos4 = inst_mat * vec4f(in.position, 1.0);
  let view_pos4 = uniforms.modelView * world_pos4;
  var out: VsOut;
  out.position = uniforms.projection * view_pos4;
  out.view_pos = view_pos4.xyz;

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
fn shade(albedo: vec3f, view_pos: vec3f, n: vec3f, roughness: f32, metallic: f32) -> vec3f {
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

  let direct = (k_d * albedo / PI + specular) * uniforms.lightColor * n_dot_l;
  let ambient_term = albedo * uniforms.ambient;
  return direct + ambient_term;
}

fn apply_fog(lit: vec3f, view_pos_z: f32) -> vec3f {
  let visibility = exp(-uniforms.fog.w * abs(view_pos_z));
  return mix(uniforms.fog.xyz, lit, visibility);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let aa = textureSample(layerA, samp, in.uv).rgb * in.tint.rgb;
  let bb = textureSample(layerB, samp, in.uv).rgb * in.tint.rgb;
  let t = clamp(textureSample(mask, samp, in.uv).r, 0.0, 1.0);

  let n_geom = normalize(in.view_normal);
  // Terrain is non-metallic by design — the metallic concept is per-material
  // anyway. Could add per-layer metallic later if needed.
  let lit_a = shade(aa, in.view_pos, n_geom, params.roughnessA, 0.0);
  let lit_b = shade(bb, in.view_pos, n_geom, params.roughnessB, 0.0);
  let lit = mix(lit_a, lit_b, t);
  let final_color = apply_fog(lit, in.view_pos.z);

  return vec4f(final_color, 1.0);
}
