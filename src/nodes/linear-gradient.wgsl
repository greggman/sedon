struct Params {
  color_a: vec4f,
  color_b: vec4f,
  // angle in radians (0 = horizontal sweep left→right, π/2 = vertical
  // bottom→top).
  angle: f32,
  // smoothstep exponent — 1 = linear lerp, 2 = ease-in-out smoothstep.
  // Authored as Float to avoid an enum, since values 0..3 cover all
  // common cases (linear, smooth, smoother, smoothest).
  smoothness: f32,
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

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Centred uv in [-0.5, 0.5]; project onto the user's direction
  // vector. Result is in [-cos+sin ... +cos+sin]/2 ish; we rescale to
  // [0, 1] using the maximum possible projection (sqrt(2)/2 at 45°,
  // 0.5 axis-aligned) — pick the conservative axis-aligned half.
  let centred = in.uv - 0.5;
  let dir = vec2f(cos(params.angle), sin(params.angle));
  let t01 = clamp(dot(centred, dir) + 0.5, 0.0, 1.0);
  // smoothness: 0 → linear; 1 → smoothstep; 2 → smoother (cubic squared).
  let s = clamp(params.smoothness, 0.0, 3.0);
  var t = t01;
  if (s >= 0.5) {
    t = smoothstep(0.0, 1.0, t01);
    if (s >= 1.5) {
      t = smoothstep(0.0, 1.0, t);
    }
    if (s >= 2.5) {
      t = smoothstep(0.0, 1.0, t);
    }
  }
  return mix(params.color_a, params.color_b, t);
}
