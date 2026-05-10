// Output: grayscale slope mask. Black = flat, white = steep. The R channel
// carries the slope so downstream blend nodes can use it directly as a
// blend factor (e.g., blend(grass_tex, rock_tex, slope_mask) for terrain).

struct Params {
  strength: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var height: texture_2d<f32>;
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
  let dims = vec2f(textureDimensions(height));
  let texel = 1.0 / dims;

  // Central differences for the gradient — same neighbor sampling as
  // normal-from-height, but we just want |grad| as a scalar.
  let l = textureSample(height, samp, in.uv - vec2f(texel.x, 0.0)).r;
  let r = textureSample(height, samp, in.uv + vec2f(texel.x, 0.0)).r;
  let u = textureSample(height, samp, in.uv - vec2f(0.0, texel.y)).r;
  let d = textureSample(height, samp, in.uv + vec2f(0.0, texel.y)).r;

  let dx = (r - l) * params.strength;
  let dy = (d - u) * params.strength;

  let slope = clamp(sqrt(dx * dx + dy * dy), 0.0, 1.0);
  return vec4f(slope, slope, slope, 1.0);
}
