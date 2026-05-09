struct Uniforms {
  modelView: mat4x4f,
  projection: mat4x4f,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
};

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = uniforms.projection * uniforms.modelView * vec4f(in.position, 1.0);
  out.normal = in.normal;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  // Object-space normal as color. Not lighting, just a debug viz so the sphere is visible.
  let color = normalize(in.normal) * 0.5 + vec3f(0.5);
  return vec4f(color, 1.0);
}
