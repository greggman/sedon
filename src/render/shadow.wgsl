// Depth-only shadow pass. Renders every scene entity from the directional
// light's POV into a depth texture. The color pass later samples this
// texture per fragment to decide if a surface point is in shadow.
//
// Shares the same vertex layout as the color materials (position + normal +
// uv + instance transform + instance tint) so a single shadow pipeline
// works for every material kind in the registry — kinds don't need to
// supply their own depth-pass shader.
//
// `lightViewProj` is the combined world→light-clip transform. It's recomputed
// each frame in scene.ts from the camera target + light direction so the
// shadow region tracks the user as they navigate.

struct ShadowUniforms {
  lightViewProj: mat4x4f,
};

@group(0) @binding(0) var<uniform> uniforms: ShadowUniforms;

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

@vertex
fn vs_main(in: VsIn) -> @builtin(position) vec4f {
  let inst_mat = mat4x4f(in.inst_col0, in.inst_col1, in.inst_col2, in.inst_col3);
  let world_pos = inst_mat * vec4f(in.position, 1.0);
  return uniforms.lightViewProj * world_pos;
}
