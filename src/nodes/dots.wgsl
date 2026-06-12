struct Params {
  dot_color: vec4f,
  bg_color: vec4f,
  divisions: vec2f, // dots across × dots down
  // dot radius in cell-uv units. 0.5 = circle touches cell edge,
  // > 0.5 = dots overlap into a thicker mesh / hex-ish look.
  radius: f32,
  // edge softness in cell-uv units. 0 = hard-edged dot, 0.05 = soft
  // halo, useful for polka-dot bokeh / film grain.
  softness: f32,
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
  // Cell-local coords in [-0.5, 0.5], centred on each grid cell.
  let cell = fract(in.uv * params.divisions) - 0.5;
  let d = length(cell);
  // smoothstep from (radius + softness) outward to (radius - softness)
  // gives an inward-fading disc: 1 at the centre, 0 outside.
  let inner = max(params.radius - params.softness, 0.0);
  let outer = params.radius + params.softness;
  let dot_mask = 1.0 - smoothstep(inner, outer, d);
  return mix(params.bg_color, params.dot_color, dot_mask);
}
