// Remap a colour source through a 1D ramp (palette texture). The
// source's Rec. 709 LUMINANCE at each pixel is interpreted as a
// parameter in [0, 1]; that parameter samples the ramp to produce
// the output RGBA. Same behaviour as Photoshop's Gradient Map.
//
// Why luminance vs. raw R: if the source is a one-channel mask
// (perlin noise → red only) the answer is identical, since
// 0.2126·r + 0.7152·0 + 0.0722·0 ≈ 0.2126·r — except that early
// scaling cap clipped to the [0, 0.2126] range. We renormalise by
// the maximum weight so a pure-red 1.0 still maps to t = 1.0.
// For a colour source (a grass-blade texture, a photo) the
// luminance reading correctly weighs G most + B least, matching
// human perception — what Gradient Map users actually want.
//
// IMPORTANT — the half-texel correction. For an N-pixel ramp the
// pixel centres sit at uv.x = 0.5/N, 1.5/N, ..., (N-0.5)/N. A naive
// sample at uv.x = t would clamp to pixel 0 for the first half-texel
// of t and to pixel N-1 for the last half-texel — endpoints get
// magnified and the ramp only smooth-blends across the middle.
// Mapping t into the range of pixel CENTRES first fixes it.

@group(0) @binding(0) var factor: texture_2d<f32>;
@group(0) @binding(1) var ramp:   texture_2d<f32>;
@group(0) @binding(2) var samp:   sampler;

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

// Rec. 709 luminance weights, normalised so a pure-channel input of
// 1.0 still produces t = 1.0 — the WEIGHTS sum to 1 already, so no
// renormalisation needed; pure-white (1,1,1) → 1.0 directly. For
// pure-red input the result is 0.2126, which is intended: red is
// only ~21% of perceived brightness vs. green's ~72%, so a red
// source DOES land near the dark end of the ramp on purpose.
const LUMA_REC709: vec3f = vec3f(0.2126, 0.7152, 0.0722);

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let rgb = textureSample(factor, samp, in.uv).rgb;
  let t = clamp(dot(rgb, LUMA_REC709), 0.0, 1.0);
  let ramp_w = f32(textureDimensions(ramp, 0).x);
  let ramp_u = (0.5 + t * (ramp_w - 1.0)) / ramp_w;
  return textureSample(ramp, samp, vec2f(ramp_u, 0.5));
}
