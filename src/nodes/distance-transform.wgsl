// Distance transform via Jump Flood Algorithm (JFA).
//
// Three fragment entry points sharing one Params uniform and one
// source-texture binding:
//
//   fs_init    — Threshold the input. Pixels above `threshold` become
//                "seeds" and store their own UV; other pixels store the
//                sentinel UV (-1, -1) so jfa can recognize them as
//                un-assigned.
//   fs_jfa     — One JFA step. For each pixel, sample itself + 8 offset
//                positions at distance `step` texels. Keep the seed UV
//                with minimum distance to this pixel. Caller does this
//                pass log2(resolution) times with `step` halving each
//                time. Last pass should use step = 1.
//   fs_final   — Compute the Euclidean distance from each pixel to its
//                assigned seed UV, normalize by `max_distance`, write a
//                greyscale Texture2D: R=0 at seeds, R=1 at max_distance
//                or beyond.
//
// The intermediate texture stores seed UV in rg as 0..1 floats encoded
// into rgba8unorm — gives ~256 distinct positions per axis, plenty for
// the smooth gradients leaf colorization needs. A sentinel UV outside
// [0,1] tells us a pixel has no seed assignment yet.

struct Params {
  texel_size: vec2f,
  step: f32,
  threshold: f32,
  max_distance: f32,
  // 0 = output the canonical distance (0 at seed, 1 far away).
  // > 0.5 = output 1 - distance, i.e. proximity (1 at seed, 0 far).
  // Useful when the next node in the chain treats brighter pixels as
  // "more of something" — e.g. colorize that wants veins as the
  // highlight color.
  invert: f32,
  _pad0: f32,
  _pad1: f32,
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

// Init: seed pixels store their own UV in rg + alpha=1; non-seed pixels
// store alpha=0 (the "invalid" flag the jfa pass uses).
@fragment
fn fs_init(in: VsOut) -> @location(0) vec4f {
  let v = textureSample(src, samp, in.uv).r;
  if (v > params.threshold) {
    return vec4f(in.uv.x, in.uv.y, 0.0, 1.0);
  }
  return vec4f(0.0, 0.0, 0.0, 0.0);
}

// JFA pass: look at self + 8 neighbors at step distance, keep the
// seed-UV with minimum distance from `this` pixel.
@fragment
fn fs_jfa(in: VsOut) -> @location(0) vec4f {
  let step_uv = params.texel_size * params.step;
  var best_uv = vec2f(0.0);
  var best_dist = 1e9;
  var have_seed = false;

  for (var dy = -1; dy <= 1; dy = dy + 1) {
    for (var dx = -1; dx <= 1; dx = dx + 1) {
      let sample_uv = in.uv + vec2f(f32(dx), f32(dy)) * step_uv;
      let s = textureSample(src, samp, sample_uv);
      // alpha > 0.5 means "this neighbor carries a valid seed UV".
      if (s.a > 0.5) {
        let d = distance(in.uv, s.rg);
        if (d < best_dist) {
          best_dist = d;
          best_uv = s.rg;
          have_seed = true;
        }
      }
    }
  }

  if (have_seed) {
    return vec4f(best_uv.x, best_uv.y, 0.0, 1.0);
  }
  return vec4f(0.0, 0.0, 0.0, 0.0);
}

// Final: distance from this pixel to its assigned seed, normalized.
// Pixels that never got a seed return the "max distance" sentinel —
// 1 by default, or 0 when inverted, so a leaf authored without any
// veins-above-threshold still reads as cleanly dark.
@fragment
fn fs_final(in: VsOut) -> @location(0) vec4f {
  let invert = params.invert > 0.5;
  let s = textureSample(src, samp, in.uv);
  if (s.a < 0.5) {
    let v = select(1.0, 0.0, invert);
    return vec4f(v, v, v, 1.0);
  }
  let d = distance(in.uv, s.rg);
  let n = clamp(d / max(params.max_distance, 0.0001), 0.0, 1.0);
  let out = select(n, 1.0 - n, invert);
  return vec4f(out, out, out, 1.0);
}
