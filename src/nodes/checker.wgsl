struct Params {
  fg: vec4f,
  bg: vec4f,
  divisions: vec2f,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> params: Params;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
  // Big-triangle fullscreen pass — same trick `core/grid` uses.
  let x = f32(i & 1u) * 4.0 - 1.0;
  let y = f32(i >> 1u) * 4.0 - 1.0;
  var out: VsOut;
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Walk into cell space, take the integer cell index, and pick fg
  // when (col + row) is even. `floor` is essential: `i32(uv * div)`
  // would round-to-zero across the negative-UV side (we don't get
  // those here, but `floor` is the unambiguous "which cell is this".
  let cell = floor(in.uv * params.divisions);
  let parity = (i32(cell.x) + i32(cell.y)) & 1;
  return select(params.bg, params.fg, parity == 0);
}
