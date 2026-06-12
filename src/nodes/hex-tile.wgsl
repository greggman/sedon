struct Params {
  hex_color: vec4f,
  mortar_color: vec4f,
  // hex divisions across the texture (approximate; vertical spacing
  // is sqrt(3)/2 of horizontal so the cells stay regular).
  divisions: vec2f,
  // mortar half-thickness as a fraction of a cell's "radius" (in the
  // hex-distance sense). 0 = no mortar; 0.1 = 10% of cell.
  mortar: f32,
  // rotation of each hex around its own centre, in radians. 0 = the
  // shipped flat-top orientation; π/6 (30°) = pointy-top.
  angle: f32,
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

// Inigo Quilez's "two lattices, pick the closer one" trick for hex
// grids: tile space with two offset rectangular lattices, the union
// of their nearest-cell neighbourhoods is the hex tiling.
fn hex_dist(p: vec2f) -> f32 {
  let q = abs(p);
  // Distance to the hexagonal boundary, with the hex normalised so
  // a unit cell has its edge at dist=0.5. The two axis projections
  // are the cube-coord constraints.
  return max(q.x * 0.866025 + q.y * 0.5, q.y);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Scale uv so the hex pitch matches divisions. Y gets the sqrt(3)/2
  // factor so the cells come out regular instead of stretched.
  let p = in.uv * params.divisions * vec2f(1.0, 1.0 / 0.866025);
  let r = vec2f(1.0, 1.73205); // (1, sqrt(3))
  let h = r * 0.5;

  let a = (p - r * floor(p / r)) - h;
  let b = ((p + h) - r * floor((p + h) / r)) - h;
  let use_a = length(a) < length(b);
  let local = select(b, a, use_a);

  // Rotate the local point around the cell centre. Rotating the
  // input by -angle makes the shape appear to rotate by +angle.
  let c_a = cos(-params.angle);
  let s_a = sin(-params.angle);
  let rotated = vec2f(c_a * local.x - s_a * local.y, s_a * local.x + c_a * local.y);

  // hex_dist of the local point: 0 at the cell centre, 0.5 at the
  // cell edge. Mortar lives in the band (0.5 - mortar .. 0.5).
  let d = hex_dist(rotated);
  let in_mortar = d > (0.5 - params.mortar);
  return select(params.hex_color, params.mortar_color, in_mortar);
}
