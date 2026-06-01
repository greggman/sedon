// Depth-only shadow pass with alpha-cutout discard. Renders every scene
// entity from the directional light's POV into a depth texture. The
// color pass later samples this texture per fragment to decide if a
// surface point is in shadow.
//
// Shares the same vertex layout as the color materials (position +
// normal + uv + instance transform + instance tint) so a single shadow
// pipeline works for every material kind in the registry — kinds don't
// need to supply their own depth-pass shader.
//
// `lightViewProj` is the combined world→light-clip transform. It's
// recomputed each frame in scene.ts from the camera target + light
// direction so the shadow region tracks the user as they navigate.
//
// Alpha-cutout: PBR materials with alphaCutoff > 0 (foliage cards,
// chain-link fences, etc.) need the texture-driven silhouette to
// drive the shadow too — without it, every leaf-card casts the full
// quad's shadow rather than the leaf's. Per-batch cutout bind group
// supplies basecolor + cutoff; the fragment samples basecolor.a and
// discards below cutoff. Materials with cutoff == 0 (opaque PBR,
// every non-PBR kind) skip the sample via the branch — uniform
// control flow, no derivatives hazard.

struct ShadowUniforms {
  lightViewProj: mat4x4f,
};

@group(0) @binding(0) var<uniform> uniforms: ShadowUniforms;

// Per-batch cutout group. Bound for every draw on every kind; non-
// cutout materials supply a 1×1 placeholder texture + cutoff = 0.
struct CutoutU {
  alphaCutoff: f32,
};
@group(1) @binding(0) var basecolor_tex: texture_2d<f32>;
@group(1) @binding(1) var basecolor_samp: sampler;
@group(1) @binding(2) var<uniform> cutout: CutoutU;

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
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
  let inst_mat = mat4x4f(in.inst_col0, in.inst_col1, in.inst_col2, in.inst_col3);
  let world_pos = inst_mat * vec4f(in.position, 1.0);
  var out: VsOut;
  out.position = uniforms.lightViewProj * world_pos;
  out.uv = in.uv;
  return out;
}

@fragment
fn fs_main(in: VsOut) {
  if (cutout.alphaCutoff > 0.0) {
    let a = textureSample(basecolor_tex, basecolor_samp, in.uv).a;
    if (a < cutout.alphaCutoff) { discard; }
  }
}
