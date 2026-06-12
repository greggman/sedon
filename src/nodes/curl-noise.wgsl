struct Params {
  scale: vec2f,
  octaves: f32,
  lacunarity: f32,
  gain: f32,
  seed: f32,
  // size of the finite-difference step. Smaller = more accurate
  // derivative but more aliasing on coarse noise; larger = smoother.
  step_size: f32,
  // 0 = packed vector field (R = curl.x, G = curl.y, both biased to
  // [0,1]); 1 = magnitude greyscale; 2 = angle (atan2(y,x)) as hue.
  mode: f32,
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

fn hash2(p: vec2f) -> vec2f {
  let h = vec2f(
    dot(p, vec2f(127.1, 311.7)),
    dot(p, vec2f(269.5, 183.3)),
  );
  return -1.0 + 2.0 * fract(sin(h) * 43758.5453123);
}

fn snoise(v: vec2f) -> f32 {
  let F2 = 0.36602540378443864;
  let G2 = 0.21132486540518713;

  let s = (v.x + v.y) * F2;
  let i = floor(v + s);
  let t = (i.x + i.y) * G2;
  let x0 = v - i + t;

  let i1 = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), x0.x > x0.y);
  let x1 = x0 - i1 + G2;
  let x2 = x0 - 1.0 + 2.0 * G2;

  let g0 = hash2(i);
  let g1 = hash2(i + i1);
  let g2 = hash2(i + vec2f(1.0, 1.0));

  let t0 = max(0.5 - dot(x0, x0), 0.0);
  let t1 = max(0.5 - dot(x1, x1), 0.0);
  let t2 = max(0.5 - dot(x2, x2), 0.0);

  let n0 = pow(t0, 4.0) * dot(g0, x0);
  let n1 = pow(t1, 4.0) * dot(g1, x1);
  let n2 = pow(t2, 4.0) * dot(g2, x2);

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

// HSV → RGB for the angle visualisation mode.
fn hsv_to_rgb(c: vec3f) -> vec3f {
  let K = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let p = abs(fract(vec3f(c.x) + K.xyz) * 6.0 - vec3f(K.w));
  return c.z * mix(vec3f(K.x), clamp(p - vec3f(K.x), vec3f(0.0), vec3f(1.0)), c.y);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let seed_off = vec2f(params.seed * 17.13, params.seed * 31.97);
  let p = in.uv * params.scale + seed_off;
  let h = max(params.step_size, 1e-4);

  // 2D curl of a scalar field f is (∂f/∂y, -∂f/∂x). The result is
  // a divergence-free vector field — flows curl but never accumulate
  // / dissipate, which makes it ideal for "wind-like" motion.
  let oct = i32(params.octaves);
  let dfdx = (fbm(p + vec2f(h, 0.0), oct, params.lacunarity, params.gain)
            - fbm(p - vec2f(h, 0.0), oct, params.lacunarity, params.gain)) / (2.0 * h);
  let dfdy = (fbm(p + vec2f(0.0, h), oct, params.lacunarity, params.gain)
            - fbm(p - vec2f(0.0, h), oct, params.lacunarity, params.gain)) / (2.0 * h);
  let curl = vec2f(dfdy, -dfdx);

  let mode = i32(params.mode + 0.5);
  if (mode == 1) {
    // Magnitude as greyscale.
    let m = clamp(length(curl), 0.0, 1.0);
    return vec4f(m, m, m, 1.0);
  } else if (mode == 2) {
    // Direction as hue, magnitude as value.
    let angle = atan2(curl.y, curl.x);
    let hue = fract(angle / 6.28318530717958647692 + 0.5);
    let mag = clamp(length(curl), 0.0, 1.0);
    let rgb = hsv_to_rgb(vec3f(hue, 0.85, mag));
    return vec4f(rgb, 1.0);
  }
  // Default mode 0: packed vector field, biased to [0,1] for rgba8.
  let packed = curl * 0.5 + 0.5;
  return vec4f(packed, 0.5, 1.0);
}
