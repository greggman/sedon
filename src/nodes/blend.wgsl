struct Params {
  factor: f32,
  mode: f32,   // 0=mix, 1=add, 2=multiply, 3=screen
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var tex_a: texture_2d<f32>;
@group(0) @binding(2) var tex_b: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

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
  let a = textureSample(tex_a, samp, in.uv);
  let b = textureSample(tex_b, samp, in.uv);

  // Branch on a uniform value keeps control flow uniform across the
  // wave, so the texture samples above stay valid. saturate() clamps
  // ADD's result so values can't blow up beyond 1 in rgba8unorm.
  let mode = i32(params.mode + 0.5);
  if (mode == 1) {
    // Add: a + b × factor. factor=1 is plain saturation-add; factor<1
    // gates how much b contributes.
    return saturate(a + b * params.factor);
  }
  if (mode == 2) {
    // Multiply: a × mix(1, b, factor). factor=1 is plain multiply;
    // factor<1 weakens b's contribution (closer to passing a through).
    return a * mix(vec4f(1.0), b, params.factor);
  }
  if (mode == 3) {
    // Screen: 1 − (1 − a)(1 − b × factor). Brightens — opposite of
    // multiply.
    let b_scaled = b * params.factor;
    return vec4f(1.0) - (vec4f(1.0) - a) * (vec4f(1.0) - b_scaled);
  }
  // Default (mix): standard linear interpolation.
  return mix(a, b, params.factor);
}
