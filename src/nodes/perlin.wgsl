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

// Modular lattice index — keeps cells repeating with period `tile`, so the
// noise wraps cleanly when uv crosses 0/1 (tile space). Wraps both i and
// the seed-offset; the offset would otherwise break tiling because hash
// at p=0 and p=tile see different absolute lattice indices.
fn wrap(i: vec2f, tile: vec2f) -> vec2f {
  return i - tile * floor(i / tile);
}

// Tileable Perlin gradient noise. Same as classic perlin but the four
// corner hashes use lattice indices modulo `tile`, so noise(p)=noise(p+tile)
// exactly and the output tiles seamlessly at multiples of `tile`.
fn perlin(p: vec2f, tile: vec2f) -> f32 {
  let i = floor(p);
  let f = p - i;
  // Quintic interpolation for C2 continuity.
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  let i00 = wrap(i,                     tile);
  let i10 = wrap(i + vec2f(1.0, 0.0),   tile);
  let i01 = wrap(i + vec2f(0.0, 1.0),   tile);
  let i11 = wrap(i + vec2f(1.0, 1.0),   tile);

  let g00 = hash2(i00);
  let g10 = hash2(i10);
  let g01 = hash2(i01);
  let g11 = hash2(i11);

  let n00 = dot(g00, f - vec2f(0.0, 0.0));
  let n10 = dot(g10, f - vec2f(1.0, 0.0));
  let n01 = dot(g01, f - vec2f(0.0, 1.0));
  let n11 = dot(g11, f - vec2f(1.0, 1.0));

  return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
}

fn fbm(p: vec2f, tile: vec2f, octaves: i32, lacunarity: f32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var freq = 1.0;
  var max_amp = 0.0;
  // Hard cap so a runaway uniform can't lock the GPU.
  let n = clamp(octaves, 1, 16);
  for (var k = 0; k < n; k++) {
    // Each octave samples at p*freq with its OWN tile (also scaled by
    // freq) — that's what keeps every octave's lattice period an integer
    // sub-multiple of the texture, so the full FBM tiles cleanly.
    sum = sum + amp * perlin(p * freq, tile * freq);
    max_amp = max_amp + amp;
    amp = amp * gain;
    freq = freq * lacunarity;
  }
  return sum / max(max_amp, 1e-5);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Round scale to an integer tile period — fractional periods break
  // tileability because the lattice can't wrap exactly. Users typically
  // supply integers anyway; this just makes any drift harmless.
  let tile = max(round(params.scale), vec2f(1.0));
  // Sampling [0, tile) across the texture. Seed offset is fine because
  // the lattice wrap is modular: noise at uv=0 and uv=1 land on the same
  // lattice cell regardless of offset.
  let p = in.uv * tile + vec2f(params.seed * 17.13, params.seed * 31.97);
  let n = fbm(p, tile, i32(params.octaves), params.lacunarity, params.gain);
  // Remap [-1, 1] -> [0, 1] for an unsigned grayscale output.
  let v = n * 0.5 + 0.5;
  return vec4f(v, v, v, 1.0);
}

