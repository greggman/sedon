struct Params {
  // colour at noise = 0.
  color_a: vec4f,
  // colour at noise = 1.
  color_b: vec4f,
  // [0,1] integer-friendly hash seed.
  seed: f32,
  // 0 = colour noise per channel, 1 = greyscale (single value across rgb).
  monochrome: f32,
  // resolution as float so the hash uses pixel-space coordinates.
  resolution: f32,
  // pad to 16-byte alignment.
  _pad: f32,
};

@group(0) @binding(0) var<uniform> params: Params;

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

// A small, deterministic hash that's stable across drivers. Multiply
// by a large prime, fract the sin product — the classic "hashwithoutsine"
// fallback. Good enough for white noise; not for crypto.
fn hash(p: vec2f, salt: f32) -> f32 {
  let q = vec2f(p.x + salt * 311.7, p.y + salt * 743.1);
  return fract(sin(dot(q, vec2f(127.1, 311.7))) * 43758.5453123);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Hash in integer pixel coordinates so the result is independent of
  // resolution (zooming in shows blockier pixels, not different noise).
  let p = floor(in.uv * params.resolution);
  let mono = i32(params.monochrome + 0.5);

  var n: vec3f;
  if (mono == 1) {
    let v = hash(p, params.seed);
    n = vec3f(v, v, v);
  } else {
    n = vec3f(
      hash(p, params.seed + 0.0),
      hash(p, params.seed + 17.13),
      hash(p, params.seed + 51.91),
    );
  }

  let rgb = mix(params.color_a.rgb, params.color_b.rgb, n);
  // Alpha follows colour_a/b's alphas at the per-channel noise so a
  // monochrome=1 alpha noise still gives variable opacity.
  let alpha = mix(params.color_a.a, params.color_b.a, hash(p, params.seed + 99.31));
  return vec4f(rgb, alpha);
}
