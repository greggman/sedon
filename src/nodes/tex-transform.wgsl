struct Params {
  // pivot in uv units. Scale/rotation happen around this point.
  pivot: vec2f,
  // scale around pivot. >1 zooms in, <1 zooms out.
  scale: vec2f,
  // translation applied after scale/rotation, in uv units.
  translate: vec2f,
  // rotation around pivot, radians (positive = counter-clockwise).
  rotation: f32,
  // 0 = repeat (handled by sampler addressMode), 1 = clamp to edge,
  // 2 = clamp to colour (return bg_color outside [0,1]).
  edge_mode: f32,
  bg_color: vec4f,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

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
  // Build sample uv by inverting the transform: the output pixel
  // asks "which uv on src maps here?". We compose translate → rotate
  // → scale → pivot all in reverse so authoring values feel natural.
  // First subtract translate (so applied translation moves the image,
  // not the sampler), then re-centre on pivot.
  let p = in.uv - params.translate - params.pivot;

  // Inverse rotation.
  let c = cos(-params.rotation);
  let s = sin(-params.rotation);
  let rotated = vec2f(c * p.x - s * p.y, s * p.x + c * p.y);

  // Inverse scale (avoid divide-by-zero). A scale of 0 collapses to
  // a single pixel, which we choose to read as "sample pivot".
  let inv_scale = vec2f(
    select(1.0 / params.scale.x, 0.0, abs(params.scale.x) < 1e-6),
    select(1.0 / params.scale.y, 0.0, abs(params.scale.y) < 1e-6),
  );
  let sample_uv = rotated * inv_scale + params.pivot;

  // textureSample requires uniform control flow, so always sample —
  // then choose between the sampled colour and bg_color based on
  // edge_mode and the bounds test.
  let sampled = textureSample(src, samp, sample_uv);
  let mode = i32(params.edge_mode + 0.5);
  let out_of_bounds =
    sample_uv.x < 0.0 || sample_uv.x > 1.0 ||
    sample_uv.y < 0.0 || sample_uv.y > 1.0;
  let use_bg = (mode == 2) && out_of_bounds;
  return select(sampled, params.bg_color, use_bg);
}
