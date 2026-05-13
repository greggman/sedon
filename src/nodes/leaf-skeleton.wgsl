// leaf/skeleton — parametric leaf outline + venation.
//
// Two fragment entry points share the same vertex shader and uniform
// buffer:
//   fs_shape — outputs the leaf silhouette: RGB = white inside the
//              outline, alpha = AA-masked outline (0 outside, 1 inside,
//              with a 1.5-pixel feather at the boundary).
//   fs_veins — outputs the venation: a midrib + N pairs of curved
//              primary veins (quadratic-bezier polylines) + sub-branches
//              off each primary. RGB = vein density clipped to the
//              leaf; alpha = the shape mask so the preview composites
//              cleanly over the checkerboard.

struct Params {
  length_scale: f32,            // vertical extent of the leaf within the texture
  width_scale: f32,             // peak half-width as a fraction of texture width
  tip_pointedness: f32,         // exponent on (1 − y_norm); higher = sharper tip
  base_curvature: f32,          // exponent on y_norm; higher = more rounded base
  branch_count: f32,            // number of primary vein pairs along the midrib
  branch_angle: f32,            // degrees from the midrib (0 = parallel-to-midrib, 90 = perpendicular)
  branch_curve: f32,            // 0 = straight veins, 1 = full outward-then-tipward arc
  branch_taper: f32,            // 0..1, how much the primary thins from base to tip
  sub_branch_count: f32,        // ladder ribs per primary
  sub_branch_curve_start: f32,  // forward bias of the FIRST sub-rib (near primary's base) — 0 = perpendicular
  sub_branch_curve_growth: f32, // additional forward bias by the LAST sub-rib (near primary's tip) — total = start + growth
  seed: f32,                    // unused in V1, reserved for jitter
};

@group(0) @binding(0) var<uniform> params: Params;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  let x = f32(idx & 1u) * 4.0 - 1.0;
  let y = f32((idx >> 1u) & 1u) * 4.0 - 1.0;
  var out: VsOut;
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f(x * 0.5 + 0.5, y * 0.5 + 0.5);
  return out;
}

// uv.y → y_norm in [0,1] (0 = leaf base, 1 = leaf tip).
fn to_leaf_y(uv_y: f32) -> f32 {
  let half_range = 0.45 * max(params.length_scale, 0.0001);
  return (uv_y - 0.5 + half_range) / (2.0 * half_range);
}

fn from_leaf_y(y_norm: f32) -> f32 {
  let half_range = 0.45 * max(params.length_scale, 0.0001);
  return y_norm * (2.0 * half_range) + 0.5 - half_range;
}

// Leaf half-width as a UV fraction at vertical position y_norm. Beta-
// like profile y^a × (1-y)^b, rescaled so its peak equals width_scale.
fn half_width(y_norm: f32) -> f32 {
  if (y_norm <= 0.0 || y_norm >= 1.0) { return 0.0; }
  let a = max(params.base_curvature, 0.05);
  let b = max(params.tip_pointedness, 0.05);
  let profile = pow(y_norm, a) * pow(1.0 - y_norm, b);
  let peak_y = a / (a + b);
  let peak_val = pow(peak_y, a) * pow(1.0 - peak_y, b);
  return params.width_scale * profile / max(peak_val, 0.0001);
}

fn leaf_sdf(uv: vec2f) -> f32 {
  let y_norm = to_leaf_y(uv.y);
  if (y_norm <= 0.0) { return 0.5 - uv.y; }
  if (y_norm >= 1.0) { return uv.y - 0.5; }
  return abs(uv.x - 0.5) - half_width(y_norm);
}

fn antialiased_mask(sdf: f32) -> f32 {
  let edge = 1.5 / 512.0;
  return 1.0 - smoothstep(-edge, edge, sdf);
}

@fragment
fn fs_shape(in: VsOut) -> @location(0) vec4f {
  let m = antialiased_mask(leaf_sdf(in.uv));
  return vec4f(m, m, m, m);
}

// 2D point-to-segment distance.
fn segment_distance(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let ap = p - a;
  let t = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(p - (a + ab * t));
}

// Stroke distance → density 0..1 with a smooth rolloff.
fn stroke_density(d: f32, thickness: f32) -> f32 {
  return 1.0 - smoothstep(0.0, thickness, d);
}

// Quadratic bezier point at t.
fn bez(t: f32, p0: vec2f, p1: vec2f, p2: vec2f) -> vec2f {
  let u = 1.0 - t;
  return p0 * (u * u) + p1 * (2.0 * u * t) + p2 * (t * t);
}

// Approximate a bezier curve as a 6-segment polyline and return the
// max stroke density the pixel sees against it. Thickness tapers
// linearly from `t0` (start) to `t1` (end).
fn bezier_stroke(uv: vec2f, p0: vec2f, p1: vec2f, p2: vec2f, t0: f32, t1: f32) -> f32 {
  let segments = 6;
  var density = 0.0;
  var prev = p0;
  for (var s = 1; s <= segments; s = s + 1) {
    let t = f32(s) / f32(segments);
    let next = bez(t, p0, p1, p2);
    let d = segment_distance(uv, prev, next);
    let thick = mix(t0, t1, t);
    density = max(density, stroke_density(d, thick));
    prev = next;
  }
  return density;
}

@fragment
fn fs_veins(in: VsOut) -> @location(0) vec4f {
  let mask = antialiased_mask(leaf_sdf(in.uv));
  if (mask < 0.005) {
    return vec4f(0.0);
  }
  let y_norm = to_leaf_y(in.uv.y);

  // Midrib: straight vertical line, taper from a thick base to a fine
  // tip. Real leaves have a near-straight midrib; the visual interest
  // comes from the curved primaries off it.
  let midrib_base = 0.014;
  let midrib_tip = midrib_base * 0.25;
  let midrib_thickness = mix(midrib_base, midrib_tip, y_norm);
  let midrib_d = abs(in.uv.x - 0.5);
  var density = stroke_density(midrib_d, midrib_thickness);

  // Primary side veins. Each is a quadratic bezier curving outward
  // away from the midrib then sweeping back toward the leaf tip — the
  // characteristic shape of real pinnate venation. branch_curve
  // controls the outward bulge: 0 makes the curve degenerate to a
  // straight line, 1 puts the control point well past the endpoint
  // (strong arc).
  let n_primary = i32(max(params.branch_count, 0.0));
  let angle_rad = clamp(params.branch_angle, 5.0, 85.0) * 3.14159265 / 180.0;
  let curve = clamp(params.branch_curve, 0.0, 1.0);
  let primary_thick_base = 0.0065;
  let primary_thick_tip = primary_thick_base * max(1.0 - params.branch_taper, 0.1);

  let n_sub = i32(max(params.sub_branch_count, 0.0));
  let sub_thick_base = 0.0028;
  let sub_thick_tip = sub_thick_base * 0.5;

  for (var i = 0; i < n_primary; i = i + 1) {
    let t_root = (f32(i) + 0.5) / f32(n_primary);
    let root_y_norm = mix(0.08, 0.85, t_root);
    let root_uv_y = from_leaf_y(root_y_norm);
    let p0 = vec2f(0.5, root_uv_y);

    // End of the primary: ~88% out to the leaf edge, at a y above the
    // root by an amount proportional to (90° − branch_angle). Steeper
    // angles → primary climbs more vertically → end y much higher.
    // Empirically picked offsets so default settings look right.
    let end_y_norm = clamp(root_y_norm + 0.10 + 0.08 * (params.branch_angle / 90.0), 0.0, 0.95);
    let end_uv_y = from_leaf_y(end_y_norm);
    let end_hw = half_width(end_y_norm) * 0.88;

    for (var side = -1.0; side <= 1.0; side = side + 2.0) {
      let p2 = vec2f(0.5 + side * end_hw, end_uv_y);
      // Control point bulges outward (further from midrib than the
      // endpoint) and stays low (closer to the root y than the
      // endpoint). Lerp from "straight line midpoint" toward the arced
      // control by `curve`.
      let straight_mid = mix(p0, p2, 0.5);
      let arced_ctrl = vec2f(
        0.5 + side * end_hw * 1.25,
        mix(root_uv_y, end_uv_y, 0.25),
      );
      let p1 = mix(straight_mid, arced_ctrl, curve);
      density = max(
        density,
        bezier_stroke(in.uv, p0, p1, p2, primary_thick_base, primary_thick_tip),
      );

      // Sub-veins: evenly-spaced ribs running perpendicular-ish off
      // the primary toward the leaf edge — a ladder, not a fan. Each
      // sub starts on the primary, heads outward (90° from the
      // primary's local tangent) with a forward bias toward the tip
      // that grows from the first sub-rib (near the primary's base)
      // to the last (near the primary's tip).
      //
      // The forward-bias growth matches real leaves: sub-ribs near
      // the leaf base are nearly perpendicular to their primary,
      // and ones near the tip curve forward more strongly because
      // the primary itself is curving toward the tip and the ribs
      // follow that bend.
      let denom = f32(max(n_sub - 1, 1));
      for (var k = 0; k < n_sub; k = k + 1) {
        let t_sub = mix(0.05, 0.95, (f32(k) + 0.5) / max(f32(n_sub), 1.0));
        let sub_p0 = bez(t_sub, p0, p1, p2);
        // Primary's tangent at t_sub, then perpendicular pointing
        // AWAY from the midrib. Two perpendicular candidates differ
        // in sign; pick the one whose x matches `side`.
        let tan = normalize(bez(t_sub + 0.01, p0, p1, p2) - bez(t_sub - 0.01, p0, p1, p2));
        let perp = vec2f(tan.y, -tan.x);
        let outward = perp * sign(side * perp.x + 0.0001);

        // Length: reach ~78% of the available space from the primary
        // to the leaf edge at the sub-vein's local y. This keeps
        // sub-veins inside the leaf and avoids them visibly stopping
        // mid-air the way a fixed length would.
        let local_y = to_leaf_y(sub_p0.y);
        let edge_x = half_width(local_y);
        let dist_from_midrib = abs(sub_p0.x - 0.5);
        let space = max(edge_x - dist_from_midrib, 0.0);
        let sub_len = space * 0.78;

        // Forward bias grows linearly with k: first sub gets
        // `curve_start`, last gets `curve_start + curve_growth`.
        let k_norm = f32(k) / denom;
        let forward = params.sub_branch_curve_start
                    + k_norm * params.sub_branch_curve_growth;
        let sub_p2 = sub_p0 + outward * sub_len + tan * sub_len * forward;
        let sub_p1 = sub_p0 + outward * sub_len * 0.55 + tan * sub_len * forward * 0.5;
        density = max(
          density,
          bezier_stroke(in.uv, sub_p0, sub_p1, sub_p2, sub_thick_base, sub_thick_tip),
        );
      }
    }
  }

  let v = density * mask;
  return vec4f(v, v, v, mask);
}
