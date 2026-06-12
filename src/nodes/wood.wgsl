struct Params {
  light_color: vec4f,
  dark_color: vec4f,
  // tree centre in uv units. Rings are circles around this point.
  centre: vec2f,
  // number of rings packed across the texture diagonal.
  ring_count: f32,
  // how much low-freq noise distorts the ring shape. 0 = perfect
  // circles; 1 = elliptical wobble; 4 = irregular tree rings.
  ring_distortion: f32,
  // fraction of each ring period the dark band occupies.
  ring_width: f32,
  // amplitude of the high-frequency grain streaks.
  grain_strength: f32,
  // scale of the grain noise.
  grain_scale: f32,
  // scale of the low-freq distortion noise.
  distortion_scale: f32,
  // smoothstep band on the ring edges.
  sharpness: f32,
  // random seed.
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
  let p_dist = in.uv * params.distortion_scale + seed_off;
  let p_grain = in.uv * params.grain_scale + seed_off;

  // Distance from the tree centre — these are the unperturbed
  // ring radii.
  let to_centre = in.uv - params.centre;
  let r = length(to_centre);

  // Low-freq noise distorts the rings into irregular shapes; high-freq
  // perpendicular streaks become the grain.
  let distortion = fbm(p_dist, 3);
  // Project grain along the radial direction so the streaks run
  // along the rings (not across them).
  let radial_dir = vec2f(-to_centre.y, to_centre.x) / max(r, 1e-5);
  let grain_p = in.uv * params.grain_scale + radial_dir * 8.0 + seed_off;
  let grain = perlin(grain_p);

  // Ring value: distance scaled to ring_count periods, plus distortion.
  let ring_phase = r * params.ring_count + distortion * params.ring_distortion;
  let local = fract(ring_phase);
  // Ring band centred at 0; smoothstep edges in.
  let half_band = max(params.sharpness, 0.001);
  let band_lo = smoothstep(0.0, half_band, local);
  let band_hi = 1.0 - smoothstep(params.ring_width - half_band, params.ring_width + half_band, local);
  let ring = band_lo * band_hi;

  // Mix ring darkness in, then perturb the result by grain.
  let base = mix(params.light_color, params.dark_color, ring);
  let grain_amount = grain * params.grain_strength;
  return clamp(base + vec4f(grain_amount, grain_amount, grain_amount, 0.0), vec4f(0.0), vec4f(1.0));
}
