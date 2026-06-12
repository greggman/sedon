struct Params {
  poly_color: vec4f,
  mortar_color: vec4f,
  // grid divisions: polygons across × polygons down on a square grid.
  divisions: vec2f,
  // mortar half-thickness as a fraction of cell radius. For N=4 with
  // angle=0 this is the gap between square tiles; for other N the
  // visible "mortar" is the gap-shape between non-tiling polygons
  // PLUS this band.
  mortar: f32,
  // number of polygon sides. 3 = triangle, 4 = square, 6 = hexagon,
  // 8 = octagon. Float (not int) so it survives the f32 uniform path.
  sides: f32,
  // rotation of each polygon around its centre, in radians.
  angle: f32,
  // horizontal offset (in cell units) applied on every other row.
  // 0 = aligned grid; 0.5 = classic running-bond brick stagger.
  row_offset: f32,
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
  let x = f32(i & 1u) * 4.0 - 1.0;
  let y = f32(i >> 1u) * 4.0 - 1.0;
  var out: VsOut;
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}

// Distance from origin to the regular-polygon edge in the direction
// of p. Equivalent to the projection of p onto the inward normal of
// the nearest edge. Returns a value to compare against the polygon's
// apothem (centre-to-edge distance).
fn poly_dist(p: vec2f, n: f32) -> f32 {
  let segment = 6.28318530717958647692 / n;
  let theta = atan2(p.y, p.x);
  let sector_angle = floor(theta / segment + 0.5) * segment;
  return length(p) * cos(theta - sector_angle);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Square grid: cell coord is floor(uv * divisions). Each row adds
  // `row * row_offset` to its x; under fract that gives 2-row
  // alternation at 0.5, 3-row diagonal at 1/3, 4-row at 0.25,
  // arbitrary fractions for sweep patterns.
  let scaled_y = in.uv.y * params.divisions.y;
  let row = floor(scaled_y);
  let scaled_x = in.uv.x * params.divisions.x + row * params.row_offset;
  let scaled = vec2f(scaled_x, scaled_y);
  let cell_uv = fract(scaled);

  // Local coord in cell centred at origin, in [-0.5, 0.5].
  var local = cell_uv - 0.5;

  // Rotate the local point. Negative angle so positive `angle` rotates
  // the polygon counter-clockwise.
  let c_a = cos(-params.angle);
  let s_a = sin(-params.angle);
  local = vec2f(c_a * local.x - s_a * local.y, s_a * local.x + c_a * local.y);

  let sides = max(params.sides, 3.0);
  let d = poly_dist(local, sides);
  // The polygon's apothem is `0.5 - mortar` — anything beyond that is
  // mortar/gap. For N=4 at angle=0 this gives an axis-aligned square
  // that tiles perfectly. For other N, the polygons don't tile, so
  // the corners between cells fill with mortar_color.
  let in_mortar = d > (0.5 - params.mortar);
  return select(params.poly_color, params.mortar_color, in_mortar);
}
