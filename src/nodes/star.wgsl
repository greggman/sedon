struct Params {
  star_color: vec4f,
  bg_color: vec4f,
  centre: vec2f,
  outer_radius: f32,
  // 0..1: ratio of inner-valley radius to outer-point radius. 0.38 ≈
  // the classic 5-pointed star; higher = fatter polygon-like; lower
  // = spikier.
  inner_ratio: f32,
  // number of star points (>= 3).
  points: f32,
  // rotation in radians (default already includes a +π/2 so angle=0
  // is point-up; positive = counter-clockwise).
  angle: f32,
  // edge softness in UV units. 0 = hard edge.
  softness: f32,
  _pad: f32,
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

const TAU = 6.28318530717958647692;

// Signed distance to a regular N-pointed star at the origin.
// Negative inside, positive outside.
fn sd_star(p: vec2f, outer_r: f32, inner_ratio: f32, n: f32) -> f32 {
  let inner_r = outer_r * inner_ratio;
  let spoke_angle = TAU / n;
  let half_spoke = spoke_angle * 0.5;

  // Snap to the wedge that's centred on the nearest spoke direction.
  let r = length(p);
  let theta = atan2(p.y, p.x);
  let segment_idx = floor(theta / spoke_angle + 0.5);
  let local_theta = theta - segment_idx * spoke_angle;

  // Mirror to the upper half so we only need to test one edge.
  let local_p = vec2f(r * cos(local_theta), r * abs(sin(local_theta)));

  // Outer point at (outer_r, 0), inner valley at the half-spoke angle.
  let outer = vec2f(outer_r, 0.0);
  let inner = vec2f(inner_r * cos(half_spoke), inner_r * sin(half_spoke));
  let edge = inner - outer;
  let edge_len_sq = max(dot(edge, edge), 1e-12);

  // Closest point on the outer→inner segment (clamped to [0,1]).
  let to_p = local_p - outer;
  let t = clamp(dot(to_p, edge) / edge_len_sq, 0.0, 1.0);
  let closest = outer + edge * t;
  let dist = length(local_p - closest);

  // Inward normal of the edge in the upper-half wedge is
  // (-edge.y, edge.x); positive outward dot means the point is on the
  // outside side of the edge.
  let outward = vec2f(edge.y, -edge.x);
  let signed = dot(to_p, outward);
  return select(-dist, dist, signed > 0.0);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Centre on params.centre and pre-rotate so angle=0 = point-up.
  let p_raw = in.uv - params.centre;
  let a = params.angle + 1.5707963267948966;  // +π/2 so 0 = up
  let c = cos(-a);
  let s = sin(-a);
  let p = vec2f(c * p_raw.x - s * p_raw.y, s * p_raw.x + c * p_raw.y);

  let n = max(params.points, 3.0);
  let ratio = clamp(params.inner_ratio, 0.05, 0.95);
  let d = sd_star(p, params.outer_radius, ratio, n);

  // d < 0 = inside. Mix from star to bg across the softness band.
  let t = smoothstep(-params.softness, params.softness, d);
  return mix(params.star_color, params.bg_color, t);
}
