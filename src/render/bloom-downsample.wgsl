// Bloom pyramid: one step of the downsample chain. Reads the previous
// (larger) mip level and writes the next (half-size) one. Renderer chains
// these to build a pyramid of progressively-smaller blurred copies of the
// bright-pass output; the upsample chain then walks back up and combines
// scales for a wide soft halo + tight core look.
//
// Sampling is four bilinear taps at the four corner-half-offsets of each
// destination texel. Because the source uses a linear sampler, each tap
// actually averages a 2×2 source block — so this 4-tap kernel sums an
// effective 4×4 box filter. Cheap and gives clean downsamples for
// pyramid bloom (Karis's 13-tap is the higher-quality alternative; this
// is enough for v1).

struct Params {
  /** (1 / src_width, 1 / src_height): half-texel offset in source UV space. */
  src_texel: vec2f,
};

@group(0) @binding(0) var src_tex: texture_2d<f32>;
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
  // Offset by half a source texel so each bilinear tap straddles a 2×2
  // source block. params.src_texel is already 1/src_dim, which lines up
  // with a one-texel offset; halve it for the half-texel corner offsets.
  let t = params.src_texel * 0.5;
  let c00 = textureSample(src_tex, samp, in.uv + vec2f(-t.x, -t.y)).rgb;
  let c10 = textureSample(src_tex, samp, in.uv + vec2f( t.x, -t.y)).rgb;
  let c01 = textureSample(src_tex, samp, in.uv + vec2f(-t.x,  t.y)).rgb;
  let c11 = textureSample(src_tex, samp, in.uv + vec2f( t.x,  t.y)).rgb;
  return vec4f((c00 + c10 + c01 + c11) * 0.25, 1.0);
}
