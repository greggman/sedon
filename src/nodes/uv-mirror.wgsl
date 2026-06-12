struct Params {
  // mirror axis position in uv units. Default 0.5 (image centre).
  axis: vec2f,
  // 0 = no mirror, 1 = mirror.
  mirror_u: f32,
  mirror_v: f32,
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
  // Fold the uv around the axis on the chosen sides. The "folded"
  // coordinate is just `axis + abs(uv - axis)` on that axis — folded
  // ALWAYS reads from the "positive" side, so the result is symmetric
  // around the axis.
  let mu = params.mirror_u > 0.5;
  let mv = params.mirror_v > 0.5;
  let folded_u = select(in.uv.x, params.axis.x + abs(in.uv.x - params.axis.x), mu);
  let folded_v = select(in.uv.y, params.axis.y + abs(in.uv.y - params.axis.y), mv);
  return textureSample(src, samp, vec2f(folded_u, folded_v));
}
