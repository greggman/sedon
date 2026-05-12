struct Params {
  scale: vec2f,    // per-axis tiling
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

// Same hash + wrap helpers as perlin.wgsl. Duplicated rather than
// shared because WGSL has no #include and string-concat for a single
// noise primitive isn't worth the indirection (the shadow PCF case has
// two host shaders sharing one function — this one has none).
fn hash2(p: vec2f) -> vec2f {
  let h = vec2f(
    dot(p, vec2f(127.1, 311.7)),
    dot(p, vec2f(269.5, 183.3)),
  );
  return -1.0 + 2.0 * fract(sin(h) * 43758.5453123);
}

fn wrap(i: vec2f, tile: vec2f) -> vec2f {
  return i - tile * floor(i / tile);
}

// Tileable Perlin. Returns signed noise in roughly [-1, 1].
fn perlin(p: vec2f, tile: vec2f) -> f32 {
  let i = floor(p);
  let f = p - i;
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

// Ridged fBm. The "ridges" come from `1 - abs(perlin)`: where the
// signed perlin crosses zero, abs is near zero and the result peaks at
// 1, producing sharp creases. Squaring sharpens further. The standard
// trick of weighting each octave by the previous one (Musgrave's
// "ridged multifractal") amplifies detail where ridges align across
// scales — gives mountain-spine networks and rock-fracture patterns
// instead of the soft hills perlin alone produces.
//
// Output is normalized to [0, 1] by tracking the running max amplitude
// envelope, same approach as the perlin/worley fbm helpers — so users
// switching primitives don't have to retune downstream levels/colorize
// nodes to compensate for a different output range.
fn ridged_fbm(p: vec2f, tile: vec2f, octaves: i32, lacunarity: f32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var freq = 1.0;
  var max_amp = 0.0;
  var prev = 1.0;
  let n = clamp(octaves, 1, 16);
  for (var k = 0; k < n; k = k + 1) {
    var r = 1.0 - abs(perlin(p * freq, tile * freq));
    r = r * r;            // sharpen the ridge
    sum = sum + r * amp * prev;
    max_amp = max_amp + amp * prev;
    prev = r;             // current octave gates the next octave's contribution
    amp = amp * gain;
    freq = freq * lacunarity;
  }
  return sum / max(max_amp, 1e-5);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Integer tile period so the lattice wraps cleanly. See perlin.wgsl
  // for the full reasoning — fractional periods can't wrap exactly.
  let tile = max(round(params.scale), vec2f(1.0));
  let p = in.uv * tile + vec2f(params.seed * 17.13, params.seed * 31.97);
  let v = ridged_fbm(p, tile, i32(params.octaves), params.lacunarity, params.gain);
  return vec4f(v, v, v, 1.0);
}
