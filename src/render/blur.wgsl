// Separable Gaussian blur. Called twice — once with direction = (1/w, 0)
// for horizontal, once with (0, 1/h) for vertical — and ping-pongs between
// two half-resolution textures. 9-tap with σ≈2.0; combined with the half-
// resolution input gives an effective ~18px blur radius at full screen,
// which reads as a clear bloom glow without being a smear.

struct Params {
  direction: vec2f, // texel-space offset per step
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> params: Params;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
  let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(i & 2u) * 2.0 - 1.0;
  var out: VsOut;
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let d = params.direction;
  // 9-tap Gaussian weights (σ ≈ 2.0, normalized to sum to 1).
  let w0 = 0.0162;
  let w1 = 0.0540;
  let w2 = 0.1216;
  let w3 = 0.1946;
  let w4 = 0.2270;
  let c =
    textureSample(input_tex, samp, in.uv - d * 4.0).rgb * w0 +
    textureSample(input_tex, samp, in.uv - d * 3.0).rgb * w1 +
    textureSample(input_tex, samp, in.uv - d * 2.0).rgb * w2 +
    textureSample(input_tex, samp, in.uv - d * 1.0).rgb * w3 +
    textureSample(input_tex, samp, in.uv               ).rgb * w4 +
    textureSample(input_tex, samp, in.uv + d * 1.0).rgb * w3 +
    textureSample(input_tex, samp, in.uv + d * 2.0).rgb * w2 +
    textureSample(input_tex, samp, in.uv + d * 3.0).rgb * w1 +
    textureSample(input_tex, samp, in.uv + d * 4.0).rgb * w0;
  return vec4f(c, 1.0);
}
