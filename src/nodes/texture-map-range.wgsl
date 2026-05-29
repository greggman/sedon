// Per-pixel linear remap. Reads R, G, B channels, computes
//   t = (rgb − in_min) / (in_max − in_min)
//   out = out_min + t · (out_max − out_min)
// optionally clamping t to [0, 1] before the second multiply so values
// outside the input range pin to the output bounds. Pathological
// in_min == in_max passes through to t = 0 (avoids divide-by-zero).
//
// Alpha is passed through unchanged — we want the remap to act on
// "the value" the texture holds, not on opacity.

struct Uniforms {
  in_min: f32,
  in_max: f32,
  out_min: f32,
  out_max: f32,
  clamp_to_range: f32, // 1.0 = clamp, 0.0 = extrapolate
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
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

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let pixel = textureSample(src, samp, in.uv);
  let range = u.in_max - u.in_min;
  // Divide-by-zero guard: when in_min == in_max, treat the whole
  // input as collapsed onto in_min — t = 0 everywhere.
  let denom = select(range, 1.0, abs(range) < 1e-12);
  var t = (pixel.rgb - vec3f(u.in_min)) / vec3f(denom);
  if (u.clamp_to_range > 0.5) {
    t = clamp(t, vec3f(0.0), vec3f(1.0));
  }
  let mapped = vec3f(u.out_min) + t * vec3f(u.out_max - u.out_min);
  return vec4f(mapped, pixel.a);
}
