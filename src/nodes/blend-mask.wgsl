// Per-pixel mask blend: output = mix(a, b, mask.r). Mask black → all a,
// mask white → all b. Companion to the uniform-factor `blend` node — used
// for splat-painting (e.g., grass × rock blended by a slope mask).

@group(0) @binding(0) var tex_a: texture_2d<f32>;
@group(0) @binding(1) var tex_b: texture_2d<f32>;
@group(0) @binding(2) var mask: texture_2d<f32>;
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
  let m = clamp(textureSample(mask, samp, in.uv).r, 0.0, 1.0);
  return mix(a, b, m);
}
