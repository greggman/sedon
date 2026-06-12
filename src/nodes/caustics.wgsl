struct Params {
  dark_color: vec4f,
  bright_color: vec4f,
  // noise field scale.
  scale: f32,
  // fbm octaves on the warp field.
  octaves: f32,
  // intensity = how many bright caustic peaks per noise period.
  intensity: f32,
  // power on the brightness. >1 gives sharp filaments; <1 smears them.
  sharpness: f32,
  // amount of "flow" — the offset between the two noise samples we
  // interfere. 0 makes the result just a noisy sin; > 0 gives the
  // characteristic interfering-net look.
  flow: f32,
  // random offset of the noise.
  seed: f32,
  _pad0: f32,
  _pad1: f32,
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

const TAU = 6.28318530717958647692;

fn hash2(p: vec2f) -> vec2f {
  let h = vec2f(
    dot(p, vec2f(127.1, 311.7)),
    dot(p, vec2f(269.5, 183.3)),
  );
  return -1.0 + 2.0 * fract(sin(h) * 43758.5453123);
}

fn perlin(p: vec2f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  let g00 = hash2(i);
  let g10 = hash2(i + vec2f(1.0, 0.0));
  let g01 = hash2(i + vec2f(0.0, 1.0));
  let g11 = hash2(i + vec2f(1.0, 1.0));

  let n00 = dot(g00, f);
  let n10 = dot(g10, f - vec2f(1.0, 0.0));
  let n01 = dot(g01, f - vec2f(0.0, 1.0));
  let n11 = dot(g11, f - vec2f(1.0, 1.0));

  return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
}

fn fbm(p_in: vec2f, octaves: i32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var p = p_in;
  let n = clamp(octaves, 1, 6);
  for (var k = 0; k < n; k = k + 1) {
    sum = sum + amp * perlin(p);
    p = p * 2.0;
    amp = amp * 0.5;
  }
  return sum;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let seed_off = vec2f(params.seed * 17.13, params.seed * 31.97);
  let p = in.uv * params.scale + seed_off;

  // Sample fbm at two offset positions; the interference between the
  // two scrolled noise fields gives the characteristic caustic-net
  // pattern. Without `flow`, a single sin'd noise reads as a smudgy
  // band — the offset second sample breaks it into filaments.
  let off = vec2f(params.flow, params.flow * 1.3);
  let n1 = fbm(p,                       i32(params.octaves));
  let n2 = fbm(p + off + vec2f(11.7, 5.3), i32(params.octaves));

  // Each noise term, sin'd at the intensity frequency, gives bright
  // bands at the noise zero-crossings. Multiplying them produces
  // peaks where BOTH are bright — the criss-crossing net.
  let a = abs(sin(n1 * params.intensity * TAU));
  let b = abs(sin(n2 * params.intensity * TAU));
  let v = pow(a * b, max(params.sharpness, 0.001));

  return mix(params.dark_color, params.bright_color, clamp(v, 0.0, 1.0));
}
