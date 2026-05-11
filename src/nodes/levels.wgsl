// Brightness / contrast / gamma adjustment for an input texture.
//
// Pipeline (applied to each RGB channel; alpha pass-through):
//   1. Brightness: out = in + brightness         (additive shift)
//   2. Contrast:   out = (in - 0.5) * contrast + 0.5    (around 0.5 gray)
//   3. Gamma:      out = pow(out, 1.0 / gamma)
//   4. Clamp to [0, 1]
//
// Defaults are no-op (brightness 0, contrast 1, gamma 1). Useful for tuning
// procedural noise dynamic range or remapping colorize outputs.

struct Params {
  brightness: f32,
  contrast: f32,
  gamma: f32,
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

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let s = textureSample(src, samp, in.uv);
  var c = s.rgb + vec3f(params.brightness);
  c = (c - vec3f(0.5)) * params.contrast + vec3f(0.5);
  c = pow(max(c, vec3f(0.0)), vec3f(1.0 / max(params.gamma, 0.001)));
  c = clamp(c, vec3f(0.0), vec3f(1.0));
  return vec4f(c, s.a);
}
