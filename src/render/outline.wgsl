// Selection outline. Two pipelines share this module:
//
//   1. `mask_vs / mask_fs` — re-renders selected instances with the same
//      modelView × projection the colour pass uses, writing 1.0 into an
//      R8Unorm mask wherever a selected fragment lands. Depth is loaded
//      from the scene depth buffer with `depth-compare: greater-equal`
//      (reverse-Z), so only the visible front-most slice is masked —
//      the outline tracks the visible silhouette, no x-ray through hills.
//
//   2. `composite_vs / composite_fs` — fullscreen overlay on top of
//      the swapchain. For each pixel it reads the mask centre + four
//      cardinal neighbours; if the centre is OUTSIDE the mask but a
//      neighbour is INSIDE, write the outline colour with src-over
//      blend. Two-pixel offset (samples mask × 2 texels away) so the
//      outline reads cleanly at high-DPI.

// ---------- Mask pass ----------

struct Scene {
  modelView: mat4x4f,
  projection: mat4x4f,
};
@group(0) @binding(0) var<uniform> scene: Scene;

struct VsIn {
  @location(0) position: vec3f,
  // Same instance-buffer layout the colour / pick pipelines use; only
  // the 4 matrix columns are read (tint at @location(7) is ignored).
  @location(3) inst0: vec4f,
  @location(4) inst1: vec4f,
  @location(5) inst2: vec4f,
  @location(6) inst3: vec4f,
};

@vertex
fn mask_vs(in: VsIn) -> @builtin(position) vec4f {
  // Match pbr.wgsl's vs_main computation byte-for-byte: the rasterised
  // depths must equal what the colour pass wrote, otherwise the mask's
  // `depthCompare: greater-equal` test rejects every fragment. Don't
  // .xyz-and-reconstruct — keep the full vec4 through projection.
  let inst = mat4x4f(in.inst0, in.inst1, in.inst2, in.inst3);
  let world_pos4 = inst * vec4f(in.position, 1.0);
  let view_pos4 = scene.modelView * world_pos4;
  return scene.projection * view_pos4;
}

@fragment
fn mask_fs() -> @location(0) vec4f {
  // R8Unorm — only the red channel reaches the storage texture; the
  // others get clamped/discarded. 1.0 = "this pixel is on the selection".
  return vec4f(1.0, 0.0, 0.0, 1.0);
}

// ---------- Outline composite ----------

@group(0) @binding(0) var mask_tex: texture_2d<f32>;
@group(0) @binding(1) var mask_samp: sampler;

struct OutlineU {
  // (1/width, 1/height) — texel size in UV space. The fragment shader
  // multiplies fragment-space coords by this to land on the mask.
  texelSize: vec2f,
  _pad: vec2f,
  color: vec4f,
};
@group(0) @binding(2) var<uniform> u: OutlineU;

struct CompositeVsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn composite_vs(@builtin(vertex_index) i: u32) -> CompositeVsOut {
  // Fullscreen triangle. Same trick the bloom / composite passes use.
  let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(i & 2u) * 2.0 - 1.0;
  var out: CompositeVsOut;
  out.pos = vec4f(x, y, 0.0, 1.0);
  // WebGPU UV origin is at the top-left, NDC origin is bottom-left:
  // flip Y so the sample lines up with the rendered mask.
  out.uv = vec2f((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}

@fragment
fn composite_fs(in: CompositeVsOut) -> @location(0) vec4f {
  // Two-texel offset: at 2× DPR a one-texel outline reads as a hairline;
  // two texels gives a clean 1-CSS-pixel-wide ring without spreading
  // too far when the cursor's stationary.
  let off = u.texelSize * 2.0;
  // WGSL rule: `textureSample` must run in uniform control flow (it
  // uses implicit derivatives for mipmap level selection). Sample EVERY
  // tap first, then branch on the results — `discard` makes subsequent
  // control flow non-uniform within the quad, which is fine ONLY after
  // all samples are done.
  let c  = textureSample(mask_tex, mask_samp, in.uv).r;
  let n0 = textureSample(mask_tex, mask_samp, in.uv + vec2f(off.x, 0.0)).r;
  let n1 = textureSample(mask_tex, mask_samp, in.uv - vec2f(off.x, 0.0)).r;
  let n2 = textureSample(mask_tex, mask_samp, in.uv + vec2f(0.0, off.y)).r;
  let n3 = textureSample(mask_tex, mask_samp, in.uv - vec2f(0.0, off.y)).r;
  // Discard everywhere we're NOT on the outline ring. The swapchain
  // pixel at a discarded fragment is preserved exactly — no write, no
  // blend math needed. This is more robust than the equivalent "write
  // RGBA=0 with src-over blend": some platforms / drivers don't
  // round-trip the alpha=0 case cleanly and the underlying PBR render
  // gets clobbered with black instead of left alone.
  if (c > 0.5) { discard; }                                 // inside the selection
  let m = max(max(n0, n1), max(n2, n3));
  if (m <= 0.5) { discard; }                                // not on the boundary
  return u.color;
}
