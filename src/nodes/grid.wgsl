struct Params {
  fg: vec4f,
  bg: vec4f,
  divisions: vec2f,
  line_width: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> params: Params;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
  // Big triangle covering the screen: (-1,-1), (3,-1), (-1,3). The third vertex
  // overhangs the viewport so the whole [-1,1]² square is rasterized.
  let x = f32(i & 1u) * 4.0 - 1.0;
  let y = f32(i >> 1u) * 4.0 - 1.0;
  var out: VsOut;
  out.position = vec4f(x, y, 0.0, 1.0);
  // Map clip-space [-1,1] to UV [0,1], flipping Y so V=0 is at the top.
  out.uv = vec2f((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let cell = fract(in.uv * params.divisions);
  let half_line = vec2f(params.line_width * 0.5);
  let on_line = any(cell < half_line) || any(cell > vec2f(1.0) - half_line);
  return select(params.bg, params.fg, on_line);
}
