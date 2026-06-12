struct Params {
  // cell density across the texture.
  scale: f32,
  // irregularity. 0 = regular grid (cell values still vary, just at
  // fixed lattice positions); 1 = full voronoi-style scatter; > 1
  // overshoots into "scattered cluster" chaos.
  u: f32,
  // 0..1 hardness. 0 = smooth blend across cells (value-noise look);
  // 1 = hard voronoi edges. Continuous between. Capped at 1: the
  // pow(v, 4) weight formula gives k → 64 at v=1 (sharp) and k = 1 at
  // v=0 (smooth); values past 1 just clip back to v=1.
  v: f32,
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

// 3-component hash: two random offsets (xy ∈ [0,1]²) and a random
// scalar (z ∈ [0,1]).
fn hash3(p: vec2f) -> vec3f {
  let q = vec3f(
    dot(p, vec2f(127.1, 311.7)),
    dot(p, vec2f(269.5, 183.3)),
    dot(p, vec2f(419.2, 371.9)),
  );
  return fract(sin(q) * 43758.5453123);
}

// Inigo Quilez's voronoise: a continuous (u, v)-parameterised noise
// that interpolates between regular grid, value noise, and Voronoi
// cells. See https://iquilezles.org/articles/voronoise/
//
// `u` controls feature-point IRREGULARITY (0 = perfect grid, 1 =
// fully random; > 1 = increasingly chaotic). `v` controls CELL
// HARDNESS via the weighting power (0 = smooth blend across cells,
// 1 = sharp voronoi-like cells).
fn voronoise(p: vec2f, u: f32, v: f32) -> f32 {
  let k = 1.0 + 63.0 * pow(clamp(v, 0.0, 1.0), 4.0);
  let i = floor(p);
  let f = p - i;

  var sum = vec2f(0.0, 0.0);
  for (var y = -2; y <= 2; y = y + 1) {
    for (var x = -2; x <= 2; x = x + 1) {
      let g = vec2f(f32(x), f32(y));
      let o = hash3(i + g) * vec3f(u, u, 1.0);
      let d = g - f + o.xy;
      // Inverse-radial weight raised to power k. Larger k → sharper
      // cell boundaries (only the nearest few neighbours contribute).
      let w = pow(1.0 - smoothstep(0.0, 1.414, length(d)), k);
      sum = sum + vec2f(o.z * w, w);
    }
  }
  return sum.x / max(sum.y, 1e-5);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let seed_off = vec2f(params.seed * 17.13, params.seed * 31.97);
  let p = in.uv * params.scale + seed_off;
  let n = voronoise(p, clamp(params.u, 0.0, 1.0), clamp(params.v, 0.0, 1.0));
  return vec4f(n, n, n, 1.0);
}
