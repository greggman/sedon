// GPU picking — writes a u32 id per fragment into an R32Uint target.
// One pipeline serves every material kind because the only inputs we
// need are position + the per-instance matrix; we ignore normals, uvs,
// tints, lighting, shadows, fog, and post-fx.
//
// The vertex shader composes `baseId + instance_index` so a single batch
// of N instanced draws emits N distinct ids — the CPU-side pickTable
// resolves any id back to its SceneEntityProvenance + world transform.
//
// The fragment shader emits the id straight through. Integer outputs
// must be `@interpolate(flat)` (no perspective interp for u32).

struct PickU {
  modelView: mat4x4f,
  pickProjection: mat4x4f,
};
@group(0) @binding(0) var<uniform> pick: PickU;

struct BatchU {
  baseId: u32,
};
@group(1) @binding(0) var<uniform> batch: BatchU;

struct VsIn {
  @location(0) position: vec3f,
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
};

@vertex
fn vs_main(in: VsIn, @builtin(instance_index) iid: u32) -> VsOut {
  let inst = mat4x4f(in.inst_col0, in.inst_col1, in.inst_col2, in.inst_col3);
  let world = inst * vec4f(in.position, 1.0);
  let view = pick.modelView * world;
  var out: VsOut;
  out.position = pick.pickProjection * vec4f(view.xyz, 1.0);
  out.pick_id = batch.baseId + iid;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) u32 {
  return in.pick_id;
}
