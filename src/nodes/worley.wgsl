struct Params {
  scale: f32,
  octaves: f32,
  lacunarity: f32,
  gain: f32,
  seed: f32,
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

// 2D hash returning a feature point in the cell, in [0, 1]^2.
fn hash22(p: vec2f) -> vec2f {
  let h = vec2f(
    dot(p, vec2f(127.1, 311.7)),
    dot(p, vec2f(269.5, 183.3)),
  );
  return fract(sin(h) * 43758.5453123);
}

// Modular lattice wrap — keeps cell indices repeating with period `tile`
// so the output tiles seamlessly. Feature points across the wrap line
// resolve to identical positions on both sides, eliminating cell seams.
fn wrap(i: vec2f, tile: f32) -> vec2f {
  return i - tile * floor(i / tile);
}

// F1 cellular noise: distance to the nearest feature point. Walks the 9
// cells around the sample to find the true minimum across cell boundaries.
// Returns roughly [0, 1] (clamped at the upper end). Tile-aware: when
// looking at neighbors that cross the tile boundary, we wrap the lattice
// index so the feature point matches what would be there on the other side.
fn worley(p: vec2f, tile: f32) -> f32 {
  let i = floor(p);
  let f = p - i;

  var min_d = 1.5;
  for (var dx = -1; dx <= 1; dx = dx + 1) {
    for (var dy = -1; dy <= 1; dy = dy + 1) {
      let neighbor = vec2f(f32(dx), f32(dy));
      // Look up the feature point using the WRAPPED neighbor cell. The
      // local-coordinate `diff` still uses the un-wrapped neighbor so
      // distances measure correctly across the wrap line.
      let cell = wrap(i + neighbor, tile);
      let point = hash22(cell);
      let diff = neighbor + point - f;
      let d = length(diff);
      min_d = min(min_d, d);
    }
  }
  return min(min_d, 1.0);
}

fn fbm(p: vec2f, tile: f32, octaves: i32, lacunarity: f32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var freq = 1.0;
  var max_amp = 0.0;
  let n = clamp(octaves, 1, 16);
  for (var k = 0; k < n; k = k + 1) {
    sum = sum + amp * worley(p * freq, tile * freq);
    max_amp = max_amp + amp;
    amp = amp * gain;
    freq = freq * lacunarity;
  }
  return sum / max(max_amp, 1e-5);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Integer tile period so the lattice wraps cleanly. Non-integer scales
  // get rounded; tiny precision drift would otherwise break seams.
  let tile = max(round(params.scale), 1.0);
  let p = in.uv * tile + vec2f(params.seed * 17.13, params.seed * 31.97);
  let v = fbm(p, tile, i32(params.octaves), params.lacunarity, params.gain);
  return vec4f(v, v, v, 1.0);
}
