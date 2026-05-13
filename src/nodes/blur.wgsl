// Separable Gaussian blur. The same shader is run twice: first
// horizontal (direction = (1, 0)) writing to an intermediate texture,
// then vertical (direction = (0, 1)) reading the intermediate and
// writing the final output. Separation lets a 1D kernel of (2*radius+1)
// taps achieve a 2D blur at 2 × (2*radius+1) sample cost — vs
// (2*radius+1)² for a single-pass 2D kernel.
//
// The kernel evaluates the Gaussian e^(-x² / (2σ²)) for x = -radius..
// +radius, with σ = radius / 3 so ~99% of the Gaussian's weight falls
// inside the kernel range. Weights are computed in-shader rather than
// uploaded so radius can vary per-eval without a uniform refill.

struct Params {
  texel_size: vec2f,   // 1 / texture dimensions
  direction: vec2f,    // (1, 0) for horizontal pass, (0, 1) for vertical
  radius: f32,         // half-kernel size in pixels
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
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

// Cap the kernel half-width at compile time. 32 taps per side (65 total)
// is plenty for blur radii up to ~30 px on a typical 256/512 texture —
// beyond that the user is probably trying to flood the whole image.
const MAX_TAPS: i32 = 32;

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let r = max(params.radius, 0.0);
  // σ = r/3 puts ~99% of Gaussian weight inside [-r, +r]. Floor at a
  // tiny value so r=0 degenerates to "return the centre sample" rather
  // than blowing up the exp.
  let sigma = max(r / 3.0, 0.0001);
  let two_sigma_sq = 2.0 * sigma * sigma;
  let step = params.direction * params.texel_size;

  // Centre tap.
  let centre_w = 1.0;
  var sum = textureSample(src, samp, in.uv) * centre_w;
  var weight_total = centre_w;

  let n = min(i32(ceil(r)), MAX_TAPS);
  for (var i = 1; i <= n; i = i + 1) {
    let x = f32(i);
    let w = exp(-(x * x) / two_sigma_sq);
    let off = step * x;
    sum = sum + textureSample(src, samp, in.uv + off) * w;
    sum = sum + textureSample(src, samp, in.uv - off) * w;
    weight_total = weight_total + 2.0 * w;
  }

  return sum / weight_total;
}
