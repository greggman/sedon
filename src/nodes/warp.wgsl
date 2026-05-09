struct Params {
  intensity: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var warp: texture_2d<f32>;
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
  // Two samples of the warp texture at offset UVs give us independent X/Y
  // displacement from a single grayscale source. Remap [0, 1] to [-1, 1] so
  // the warp pushes both directions equally.
  let dx = textureSample(warp, samp, in.uv).r * 2.0 - 1.0;
  let dy = textureSample(warp, samp, in.uv + vec2f(0.5, 0.5)).r * 2.0 - 1.0;
  let warped_uv = in.uv + vec2f(dx, dy) * params.intensity;
  return textureSample(src, samp, warped_uv);
}
