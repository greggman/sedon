// PBR (Cook-Torrance GGX) material kind. The first kind to use the split
// bind-group convention:
//
//   @group(0) — scene-level bindings shared across all material kinds:
//     binding 0: scene uniforms (modelView, projection, lighting, fog)
//     binding 1: shared sampler
//
//   @group(1) — kind-specific bindings:
//     binding 0: basecolor texture
//     binding 1: per-material params (roughness, metallic)
//     binding 2: normal map (flat 1×1 placeholder when material has none)
//
// Adding a new kind means declaring its own @group(1) layout — @group(0)
// stays exactly as below.

struct Uniforms {
  modelView: mat4x4f,
  projection: mat4x4f,
  lightDirWorld: vec3f,
  lightColor: vec3f,
  ambient: vec3f,
  fog: vec4f,
};

struct Material {
  roughness: f32,
  metallic: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var samp: sampler;

@group(1) @binding(0) var basecolor: texture_2d<f32>;
@group(1) @binding(1) var<uniform> material: Material;
@group(1) @binding(2) var normal_map: texture_2d<f32>;

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

fn perturb_normal(n: vec3f, p: vec3f, uv: vec2f) -> vec3f {
  let smp = textureSample(normal_map, samp, uv).rgb;
  let map = smp * 2.0 - vec3f(1.0);
  let tbn = cotangent_frame(n, p, uv);
  return normalize(tbn * map);
}

fn apply_lighting(albedo: vec3f, view_pos: vec3f, n: vec3f, roughness: f32, metallic: f32) -> vec3f {
  let v = normalize(-view_pos);
  let l_world = normalize(uniforms.lightDirWorld);
  let view_rot = mat3x3f(
    uniforms.modelView[0].xyz,
    uniforms.modelView[1].xyz,
    uniforms.modelView[2].xyz,
  );
  let l = normalize(view_rot * l_world);
  let h = normalize(v + l);
  let light_color = uniforms.lightColor;

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

  let direct = (k_d * albedo / PI + specular) * light_color * n_dot_l;
  let ambient_term = albedo * uniforms.ambient;
  return direct + ambient_term;
}

fn apply_fog(lit: vec3f, view_pos_z: f32) -> vec3f {
  let visibility = exp(-uniforms.fog.w * abs(view_pos_z));
  return mix(uniforms.fog.xyz, lit, visibility);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let albedo_sample = textureSample(basecolor, samp, in.uv);
  let albedo = albedo_sample.rgb * in.tint.rgb;
  let n_geom = normalize(in.view_normal);
  let n = perturb_normal(n_geom, in.view_pos, in.uv);

  let lit = apply_lighting(albedo, in.view_pos, n, material.roughness, material.metallic);
  let final_color = apply_fog(lit, in.view_pos.z);

  return vec4f(final_color, albedo_sample.a);
}
