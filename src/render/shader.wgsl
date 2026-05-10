struct Uniforms {
  modelView: mat4x4f,
  projection: mat4x4f,
};

struct Material {
  roughness: f32,
  metallic: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var basecolor: texture_2d<f32>;
@group(0) @binding(2) var basecolor_sampler: sampler;
@group(0) @binding(3) var<uniform> material: Material;
@group(0) @binding(4) var normal_map: texture_2d<f32>;

struct VsIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
};

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) view_pos: vec3f,
  @location(1) view_normal: vec3f,
  @location(2) uv: vec2f,
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
  let view_pos4 = uniforms.modelView * vec4f(in.position, 1.0);
  var out: VsOut;
  out.position = uniforms.projection * view_pos4;
  out.view_pos = view_pos4.xyz;
  let normal_mat = mat3x3f(
    uniforms.modelView[0].xyz,
    uniforms.modelView[1].xyz,
    uniforms.modelView[2].xyz,
  );
  out.view_normal = normal_mat * in.normal;
  out.uv = in.uv;
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

// Build a tangent-space basis at the fragment from screen-space derivatives of
// position and UV, so we don't need per-vertex tangents on the mesh. Christian
// Schüler's formulation; quality drops where UVs stretch (poles of a sphere)
// but works without changing the geometry pipeline.
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
  let sample = textureSample(normal_map, basecolor_sampler, uv).rgb;
  let map = sample * 2.0 - vec3f(1.0);
  let tbn = cotangent_frame(n, p, uv);
  return normalize(tbn * map);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let albedo_sample = textureSample(basecolor, basecolor_sampler, in.uv);
  let albedo = albedo_sample.rgb;
  let n_geom = normalize(in.view_normal);
  let n = perturb_normal(n_geom, in.view_pos, in.uv);
  let v = normalize(-in.view_pos);

  // World-space light, transformed into view space via the modelView's
  // rotation block. Keeps the "sun direction" pinned to the world rather
  // than the camera, so orbiting reveals different lit faces of objects
  // (buildings on a planet feel fixed relative to the planet).
  let l_world = normalize(vec3f(0.4, 0.8, 0.6));
  let view_rot = mat3x3f(
    uniforms.modelView[0].xyz,
    uniforms.modelView[1].xyz,
    uniforms.modelView[2].xyz,
  );
  let l = normalize(view_rot * l_world);
  let h = normalize(v + l);
  let light_color = vec3f(3.0);

  let n_dot_v = max(dot(n, v), 0.0);
  let n_dot_l = max(dot(n, l), 0.0);
  let n_dot_h = max(dot(n, h), 0.0);
  let h_dot_v = max(dot(h, v), 0.0);

  let f0 = mix(vec3f(0.04), albedo, material.metallic);

  let d = distribution_ggx(n_dot_h, material.roughness);
  let g = geometry_smith(n_dot_v, n_dot_l, material.roughness);
  let f = fresnel_schlick(h_dot_v, f0);

  let specular = (d * g * f) / max(4.0 * n_dot_v * n_dot_l, 0.0001);

  let k_s = f;
  let k_d = (vec3f(1.0) - k_s) * (1.0 - material.metallic);

  let direct = (k_d * albedo / PI + specular) * light_color * n_dot_l;
  let ambient = albedo * 0.15;

  return vec4f(direct + ambient, albedo_sample.a);
}
