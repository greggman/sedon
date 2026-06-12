struct Params {
  // periods across the texture (separate per axis).
  scale: vec2f,
  // fbm parameters.
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

fn hash2(p: vec2f) -> vec2f {
  let h = vec2f(
    dot(p, vec2f(127.1, 311.7)),
    dot(p, vec2f(269.5, 183.3)),
  );
  return -1.0 + 2.0 * fract(sin(h) * 43758.5453123);
}

// 2D simplex noise. Skew the input onto a triangular lattice, find the
// containing simplex (one of two right triangles in the skewed cell),
// sum gradient contributions from its 3 corners weighted by a radial
// falloff. Reference: Perlin's "Simplex noise demystified" via the
// Stefan Gustavson formulation, simplified.
fn snoise(v: vec2f) -> f32 {
  let F2 = 0.36602540378443864;  // (sqrt(3) - 1) / 2
  let G2 = 0.21132486540518713;  // (3 - sqrt(3)) / 6

  // Skew the input into triangular lattice coordinates.
  let s = (v.x + v.y) * F2;
  let i = floor(v + s);
  let t = (i.x + i.y) * G2;
  let x0 = v - i + t;

  // Determine which of the two triangles inside the parallelogram we're in.
  let i1 = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), x0.x > x0.y);
  let x1 = x0 - i1 + G2;
  let x2 = x0 - 1.0 + 2.0 * G2;

  // Gradients at the 3 triangle corners.
  let g0 = hash2(i);
  let g1 = hash2(i + i1);
  let g2 = hash2(i + vec2f(1.0, 1.0));

  // Radial falloff from each corner; zero past r = sqrt(0.5).
  let t0 = max(0.5 - dot(x0, x0), 0.0);
  let t1 = max(0.5 - dot(x1, x1), 0.0);
  let t2 = max(0.5 - dot(x2, x2), 0.0);

  let n0 = pow(t0, 4.0) * dot(g0, x0);
  let n1 = pow(t1, 4.0) * dot(g1, x1);
  let n2 = pow(t2, 4.0) * dot(g2, x2);

  // 70 normalises the result to roughly [-1, 1] given the gradient
  // distribution and falloff weights above.
  return 70.0 * (n0 + n1 + n2);
}

fn fbm(p_in: vec2f, octaves: i32, lac: f32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var max_amp = 0.0;
  var p = p_in;
  let n = clamp(octaves, 1, 8);
  for (var k = 0; k < n; k = k + 1) {
    sum = sum + amp * snoise(p);
    max_amp = max_amp + amp;
    amp = amp * gain;
    p = p * lac;
  }
  return sum / max(max_amp, 1e-5);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = in.uv * params.scale + vec2f(params.seed * 17.13, params.seed * 31.97);
  let n = fbm(p, i32(params.octaves), params.lacunarity, params.gain);
  // Remap [-1, 1] -> [0, 1] for greyscale output.
  let v = clamp(n * 0.5 + 0.5, 0.0, 1.0);
  return vec4f(v, v, v, 1.0);
}
