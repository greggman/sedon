struct Params {
  cell_color: vec4f,
  edge_color: vec4f,
  // cell density across the texture (integer-rounded for tileability).
  scale: f32,
  // half-width of the edge band (in cell-space units). 0 = pure
  // binary lines; 0.05 = visible band; 0.2 = thick "ridge".
  edge_width: f32,
  // randomness inside each cell (0..1). 1 = points anywhere in cell;
  // 0 = centred = regular grid.
  jitter: f32,
  // random seed.
  seed: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
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

fn hash22(p: vec2f) -> vec2f {
  let h = vec2f(
    dot(p, vec2f(127.1, 311.7)),
    dot(p, vec2f(269.5, 183.3)),
  );
  return fract(sin(h) * 43758.5453123);
}

fn wrap(i: vec2f, tile: f32) -> vec2f {
  return i - tile * floor(i / tile);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let tile = max(round(params.scale), 1.0);
  let seed_off = vec2f(params.seed * 17.13, params.seed * 31.97);
  let p = in.uv * tile + seed_off;

  let i = floor(p);
  let f = p - i;

  // Find F1 (nearest feature) and F2 (second nearest). Walk the 3×3
  // surrounding cells; jitter < 1 keeps feature points safely within
  // their cells so 3×3 is always enough.
  var f1 = 1.5;
  var f2 = 1.5;
  for (var dx = -1; dx <= 1; dx = dx + 1) {
    for (var dy = -1; dy <= 1; dy = dy + 1) {
      let neighbor = vec2f(f32(dx), f32(dy));
      let cell = wrap(i + neighbor, tile);
      let pt = hash22(cell);
      // Centre + jitter * (point - 0.5) keeps the feature inside the
      // cell while letting the user dial randomness.
      let jittered = 0.5 + (pt - 0.5) * params.jitter;
      let diff = neighbor + jittered - f;
      let d = length(diff);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }

  // F2 - F1 is small near cell boundaries (the two nearest features
  // are equidistant there) and large near cell centres. Threshold for
  // the edge band.
  let dist_to_edge = f2 - f1;
  let edge = 1.0 - smoothstep(0.0, max(params.edge_width, 1e-4), dist_to_edge);
  return mix(params.cell_color, params.edge_color, edge);
}
