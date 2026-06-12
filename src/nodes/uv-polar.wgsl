struct Params {
  // centre of the polar transform, uv units.
  centre: vec2f,
  // 0 = cartesian → polar (output u = angle, output v = radius);
  // 1 = polar → cartesian (inverse: useful for "unwarping" a polar
  // image back to a square).
  direction: f32,
  // angular repetition. 1 = a single sweep; 4 = a 4-fold kaleidoscope;
  // fractional values produce gaps.
  repeats: f32,
  // angle offset in turns (where the "0 angle" sits — 0 = +X axis).
  angle_offset: f32,
  _pad: f32,
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

const TAU = 6.28318530717958647692;

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let mode = i32(params.direction + 0.5);
  var sample_uv: vec2f;

  if (mode == 0) {
    // Cartesian → polar: the output (u, v) is interpreted as
    // (angle, radius). u sweeps from 0 to 1 around the circle, v
    // from 0 (centre) to 1 (edge). We sample the source at the
    // cartesian point that the (angle, radius) describes.
    let angle = (in.uv.x * params.repeats + params.angle_offset) * TAU;
    let radius = in.uv.y;
    sample_uv = params.centre + vec2f(cos(angle), sin(angle)) * radius;
  } else {
    // Polar → cartesian: input is a cartesian image; we sample the
    // source as if it were a polar image. Computes (r, θ) of the
    // current pixel relative to centre, then samples src at
    // (θ-normalised, r).
    let p = in.uv - params.centre;
    let r = length(p);
    var theta = atan2(p.y, p.x) / TAU - params.angle_offset;
    // Wrap into [0,1) so repeats > 1 sees a tiled angular axis.
    theta = fract(theta * params.repeats);
    sample_uv = vec2f(theta, r);
  }

  return textureSample(src, samp, sample_uv);
}
