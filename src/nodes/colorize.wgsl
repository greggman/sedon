struct Params {
  low: vec4f,
  high: vec4f,
  // Position of the 50/50 mix point along the input's [0,1] range.
  // 0.5 = symmetric (linear ramp, equivalent to the old behavior).
  // <0.5 = pinch toward `high` (more of the output reads as high-ish).
  // >0.5 = pinch toward `low`. Implemented as a piecewise-linear remap
  // of the input into [0,1] before the standard mix.
  midpoint: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
  let x = f32(i & 1u) * 4.0 - 1.0;
  let y = f32(i >> 1u) * 4.0 - 1.0;
  var out: VsOut;
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}

// Piecewise-linear remap of [0,1] so that `midpoint` maps to 0.5,
// 0 stays 0, and 1 stays 1.
fn remap_with_midpoint(t: f32, m: f32) -> f32 {
  let mid = clamp(m, 0.0001, 0.9999);
  if (t <= mid) {
    return 0.5 * t / mid;
  }
  return 0.5 + 0.5 * (t - mid) / (1.0 - mid);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let raw = textureSample(src, samp, in.uv).r;
  let t = remap_with_midpoint(clamp(raw, 0.0, 1.0), params.midpoint);
  return mix(params.low, params.high, t);
}
