// Bloom pyramid: one step of the upsample chain. Reads a smaller mip and
// writes to the next-larger mip ADDITIVELY (the pipeline target uses
// blend = src+dst), so contributions from every pyramid level accumulate
// into mip0 by the end — that's what produces the wide-soft-halo +
// tight-core shape of a proper bloom.
//
// 9-tap 1-2-1 tent filter:
//   1 2 1
//   2 4 2  / 16
//   1 2 1
//
// Tent is the standard upsample filter for this style of bloom
// (Karis/COD AW); it's smooth and cheap. Each tap is a bilinear sample
// from the smaller source — combined with the bilinear stretch, the
// effective blur is wider than the kernel suggests.

struct Params {
  /** (1 / src_width, 1 / src_height): one source-texel step in UV space. */
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
  let t = params.src_texel;
  let s00 = textureSample(src_tex, samp, in.uv + vec2f(-t.x, -t.y)).rgb;
  let s10 = textureSample(src_tex, samp, in.uv + vec2f( 0.0, -t.y)).rgb;
  let s20 = textureSample(src_tex, samp, in.uv + vec2f( t.x, -t.y)).rgb;
  let s01 = textureSample(src_tex, samp, in.uv + vec2f(-t.x,  0.0)).rgb;
  let s11 = textureSample(src_tex, samp, in.uv                    ).rgb;
  let s21 = textureSample(src_tex, samp, in.uv + vec2f( t.x,  0.0)).rgb;
  let s02 = textureSample(src_tex, samp, in.uv + vec2f(-t.x,  t.y)).rgb;
  let s12 = textureSample(src_tex, samp, in.uv + vec2f( 0.0,  t.y)).rgb;
  let s22 = textureSample(src_tex, samp, in.uv + vec2f( t.x,  t.y)).rgb;
  let sum =
    (s00 + s20 + s02 + s22) +
    (s10 + s01 + s21 + s12) * 2.0 +
    s11 * 4.0;
  return vec4f(sum / 16.0, 1.0);
}
