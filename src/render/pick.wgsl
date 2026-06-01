// GPU picking — writes a u32 id per fragment into an R32Uint target.
// One pipeline serves every material kind because the only inputs we
// need are position + the per-instance matrix + a basecolor sample
// for alpha-cutout discard; we ignore normals, tints, lighting,
// shadows, fog, and post-fx.
//
// The vertex shader composes `baseId + instance_index` so a single
// batch of N instanced draws emits N distinct ids — the CPU-side
// pickTable resolves any id back to its SceneEntityProvenance +
// world transform.
//
// The fragment shader emits the id straight through (with optional
// alpha-cutout discard). Integer outputs must be `@interpolate(flat)`
// (no perspective interp for u32). UV uses default smooth interp so
// the basecolor sample is correct in screen space.
//
// Alpha-cutout: same per-batch group the shadow + outline-mask
// pipelines use — see shadow.wgsl for the full rationale. Without
// this, picking a leaf-cutout card hit the whole quad's silhouette
// instead of just the opaque parts.

struct PickU {
  modelView: mat4x4f,
  pickProjection: mat4x4f,
};
@group(0) @binding(0) var<uniform> pick: PickU;

struct BatchU {
  baseId: u32,
};
@group(1) @binding(0) var<uniform> batch: BatchU;

struct CutoutU {
  alphaCutoff: f32,
};
@group(2) @binding(0) var basecolor_tex: texture_2d<f32>;
@group(2) @binding(1) var basecolor_samp: sampler;
@group(2) @binding(2) var<uniform> cutout: CutoutU;

struct VsIn {
  @location(0) position: vec3f,
  // UV at location 2 — matches the shared instance-vertex-buffer
  // layout the color / shadow / outline-mask pipelines all use.
  @location(2) uv: vec2f,
  // Instance matrix lives in vertex buffer slot 3 (same stride as the
  // colour pipeline — 80B for matrix(64) + tint(16); we read only the
  // first 64B). Reuses the existing per-batch instance buffer.
  @location(3) inst_col0: vec4f,
  @location(4) inst_col1: vec4f,
  @location(5) inst_col2: vec4f,
  @location(6) inst_col3: vec4f,
};

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) pick_id: u32,
  @location(1) uv: vec2f,
};

@vertex
fn vs_main(in: VsIn, @builtin(instance_index) iid: u32) -> VsOut {
  let inst = mat4x4f(in.inst_col0, in.inst_col1, in.inst_col2, in.inst_col3);
  let world = inst * vec4f(in.position, 1.0);
  let view = pick.modelView * world;
  var out: VsOut;
  out.position = pick.pickProjection * vec4f(view.xyz, 1.0);
  out.pick_id = batch.baseId + iid;
  out.uv = in.uv;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) u32 {
  if (cutout.alphaCutoff > 0.0) {
    let a = textureSample(basecolor_tex, basecolor_samp, in.uv).a;
    if (a < cutout.alphaCutoff) { discard; }
  }
  return in.pick_id;
}
