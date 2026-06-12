struct Params {
  vein_color: vec4f,
  base_color: vec4f,
  // periods per UV unit along the vein direction.
  frequency: f32,
  // how much the noise warps the straight stripes. 0 = parallel
  // stripes; 1 = barely-recognisable swirls.
  turbulence: f32,
  // scale of the warping noise lattice.
  noise_scale: f32,
  // fbm octaves on the warping noise.
  octaves: f32,
  // smoothstep half-band around the sin = 0 crossing. Smaller =
  // sharper, knife-edge veins; larger = soft watercolour banding.
  sharpness: f32,
  // direction of the base stripes, in radians.
  angle: f32,
  // random offset of the noise.
  seed: f32,
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

fn fbm(p_in: vec2f, octaves: i32, gain: f32, lac: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var p = p_in;
  let n = clamp(octaves, 1, 8);
  for (var k = 0; k < n; k = k + 1) {
    sum = sum + amp * perlin(p);
    p = p * lac;
    amp = amp * gain;
  }
  return sum;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Project uv onto vein direction (perpendicular to vein lines).
  let dir = vec2f(cos(params.angle), sin(params.angle));
  let projected = dot(in.uv - 0.5, dir);

  // FBM warps the otherwise-straight stripes into marble veins.
  let noise_p = in.uv * params.noise_scale + vec2f(params.seed * 17.13, params.seed * 31.97);
  let warp = fbm(noise_p, i32(params.octaves), 0.5, 2.0);

  let phase = projected * params.frequency + warp * params.turbulence;
  // sin gives oscillation around 0; abs flips it to [0,1] with sharp
  // zero-crossings = vein centres. smoothstep tapers each side.
  let s = abs(sin(phase * TAU));
  let half_band = max(params.sharpness, 0.001);
  let vein = 1.0 - smoothstep(0.0, half_band, s);

  return mix(params.base_color, params.vein_color, vein);
}
