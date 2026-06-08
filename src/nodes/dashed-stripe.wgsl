struct Params {
  fg: vec4f,
  bg: vec4f,
  // Packed into a single vec4 to keep uniform layout trivially
  // aligned (vec4f members at offsets 0, 16, 32 — no scalar-stride
  // ambiguity). x=dash_count, y=dash_fraction, z=stripe_width,
  // w=orientation (0=horizontal dashes along U, 1=vertical along V).
  cfg: vec4f,
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
  let dash_count = params.cfg.x;
  let dash_fraction = params.cfg.y;
  let stripe_width = params.cfg.z;
  let orientation = params.cfg.w;

  // Pick the axis the dashes run ALONG and the axis the stripe band
  // is CENTRED on. Horizontal mode → along=U, across=V; vertical
  // swaps them.
  let horizontal = orientation < 0.5;
  let along = select(in.uv.y, in.uv.x, horizontal);
  let across = select(in.uv.x, in.uv.y, horizontal);

  // Two conditions, ANDed: inside the centered band AND inside a
  // dash segment of the period. Single return at the end — early
  // returns inside `if` have tripped pipeline-layout validation on
  // some Dawn versions; this rewrite sidesteps that whether or not
  // it's a real bug here.
  let half_band = stripe_width * 0.5;
  let in_band = abs(across - 0.5) < half_band;
  let cell = fract(along * dash_count);
  let on_dash = cell < dash_fraction;
  let lit = in_band && on_dash;
  return select(params.bg, params.fg, lit);
}
