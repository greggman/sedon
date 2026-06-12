struct Params {
  inner_color: vec4f,
  outer_color: vec4f,
  // centre of the radial sweep, in uv units (0..1). [0.5, 0.5] is the
  // image centre.
  centre: vec2f,
  // radius at which the gradient finishes — inside this distance the
  // colour is fully inner, outside fully outer.
  radius: f32,
  // smoothstep curve exponent (same scale as linear-gradient).
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
  let d = length(in.uv - params.centre);
  let t01 = clamp(d / max(params.radius, 1e-5), 0.0, 1.0);
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
  return mix(params.inner_color, params.outer_color, t);
}
