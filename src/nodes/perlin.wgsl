struct Params {
  scale: vec2f,    // per-axis tiling (x = horizontal frequency, y = vertical)
  octaves: f32,    // stored as f32 so the uniform stays float-only on the JS side
  lacunarity: f32,
  gain: f32,
  seed: f32,
  // pad to 32 bytes (16-byte multiple)
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

// 2D hash returning a pseudo-random unit-ish gradient in [-1, 1]^2.
fn hash2(p: vec2f) -> vec2f {
  let h = vec2f(
    dot(p, vec2f(127.1, 311.7)),
    dot(p, vec2f(269.5, 183.3)),
  );
  return -1.0 + 2.0 * fract(sin(h) * 43758.5453123);
}

// Classic Perlin gradient noise in 2D. Returns approximately in [-1, 1].
fn perlin(p: vec2f) -> f32 {
  let i = floor(p);
  let f = p - i;
  // Quintic interpolation for C2 continuity.
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  let g00 = hash2(i + vec2f(0.0, 0.0));
  let g10 = hash2(i + vec2f(1.0, 0.0));
  let g01 = hash2(i + vec2f(0.0, 1.0));
  let g11 = hash2(i + vec2f(1.0, 1.0));

  let n00 = dot(g00, f - vec2f(0.0, 0.0));
  let n10 = dot(g10, f - vec2f(1.0, 0.0));
  let n01 = dot(g01, f - vec2f(0.0, 1.0));
  let n11 = dot(g11, f - vec2f(1.0, 1.0));

  return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
}

fn fbm(p: vec2f, octaves: i32, lacunarity: f32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var freq = 1.0;
  var max_amp = 0.0;
  // Hard cap so a runaway uniform can't lock the GPU.
  let n = clamp(octaves, 1, 16);
  for (var k = 0; k < n; k++) {
    sum = sum + amp * perlin(p * freq);
    max_amp = max_amp + amp;
    amp = amp * gain;
    freq = freq * lacunarity;
  }
  return sum / max(max_amp, 1e-5);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = in.uv * params.scale + vec2f(params.seed * 17.13, params.seed * 31.97);
  let n = fbm(p, i32(params.octaves), params.lacunarity, params.gain);
  // Remap [-1, 1] -> [0, 1] for an unsigned grayscale output.
  let v = n * 0.5 + 0.5;
  return vec4f(v, v, v, 1.0);
}

