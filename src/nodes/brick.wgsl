struct Params {
  brick_color: vec4f,
  mortar_color: vec4f,
  // x = tiles across, y = rows down
  divisions: vec2f,
  // half-thickness of the mortar gap, in cell-uv units (0..0.5)
  mortar: f32,
  // per-row horizontal offset as a fraction of one brick width.
  // 0.5 = classic running bond; 0 = stack bond; 0.33 = third bond.
  row_offset: f32,
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
  let row = floor(in.uv.y * params.divisions.y);
  // Each row N shifts by `N * row_offset` of a brick width. Under
  // fract that gives 2-row running bond at 0.5, third bond at 1/3,
  // 4-row diagonal at 0.25, etc. Integer values wrap back to stack.
  let shift = row * params.row_offset;
  let shifted_uv_x = fract(in.uv.x + shift);

  // Cell-local UV in [0, 1] for both axes.
  let cell_u = fract(shifted_uv_x * params.divisions.x);
  let cell_v = fract(in.uv.y * params.divisions.y);

  let in_mortar =
    cell_u < params.mortar
    || cell_u > 1.0 - params.mortar
    || cell_v < params.mortar
    || cell_v > 1.0 - params.mortar;

  return select(params.brick_color, params.mortar_color, in_mortar);
}
