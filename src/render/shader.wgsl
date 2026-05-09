struct Uniforms {
  modelView: mat4x4f,
  projection: mat4x4f,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var basecolor: texture_2d<f32>;
@group(0) @binding(2) var basecolor_sampler: sampler;

struct VsIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
};

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) world_normal: vec3f,
  @location(1) uv: vec2f,
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
  var out: VsOut;
  out.position = uniforms.projection * uniforms.modelView * vec4f(in.position, 1.0);
  // Object-space normal is fine for the throwaway light direction below — we're
  // not rotating the light with the camera. Replace with a proper normal matrix
  // when the renderer learns about real transforms.
  out.world_normal = in.normal;
  out.uv = in.uv;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let albedo = textureSample(basecolor, basecolor_sampler, in.uv);
  let light_dir = normalize(vec3f(0.4, 0.8, 0.6));
  let n = normalize(in.world_normal);
  let ndotl = max(dot(n, light_dir), 0.0);
  let lit = albedo.rgb * (0.2 + 0.8 * ndotl);
  return vec4f(lit, albedo.a);
}
