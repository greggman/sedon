struct Params {
  ring_color: vec4f,
  gap_color: vec4f,
  centre: vec2f,
  // radius at which the rings start (in UV units).
  inner_radius: f32,
  // radius at which the rings stop. Outside this, gap_color.
  outer_radius: f32,
  // number of ring periods packed between inner and outer.
  ring_count: f32,
  // fraction of each period that is filled with ring_color. 0.5 =
  // equal ring/gap; 0.2 = thin rings; 0.8 = thin gaps.
  ring_width: f32,
  // edge softness in UV units.
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
  let r = length(in.uv - params.centre);

  // Normalised radius in [0,1] across the inner→outer band.
  let band = max(params.outer_radius - params.inner_radius, 1e-6);
  let t = (r - params.inner_radius) / band;
  // Period count: how many rings have we crossed.
  let local = fract(t * params.ring_count);

  // The ring color is the first `ring_width` portion of each period;
  // smoothstep over a `softness` band on each edge.
  let half_soft = params.softness * params.ring_count * 0.5;
  let rise = smoothstep(0.0, half_soft, local);
  let fall = smoothstep(params.ring_width - half_soft, params.ring_width + half_soft, local);
  let in_ring = rise * (1.0 - fall);

  // Outside the inner/outer band is solid gap.
  let in_band = step(0.0, t) * step(t, 1.0);
  return mix(params.gap_color, params.ring_color, in_ring * in_band);
}
