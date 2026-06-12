struct Params {
  // hue shift in turns (1.0 = full rotation around the colour wheel).
  hue: f32,
  // saturation multiplier. 1.0 = no change, 0.0 = fully greyscale,
  // > 1.0 = boosted, < 0 wraps but isn't meaningful.
  saturation: f32,
  // value (brightness) multiplier. 1.0 = no change.
  value: f32,
  _pad: f32,
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

// Sam Hocevar's branchless RGB↔HSV. Stable across drivers, no branches
// on per-fragment values so the textureSample stays in uniform flow.
fn rgb_to_hsv(c: vec3f) -> vec3f {
  let K = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p = mix(vec4f(c.bg, K.wz), vec4f(c.gb, K.xy), step(c.b, c.g));
  let q = mix(vec4f(p.xyw, c.r), vec4f(c.r, p.yzx), step(p.x, c.r));
  let d = q.x - min(q.w, q.y);
  let e = 1.0e-10;
  return vec3f(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

fn hsv_to_rgb(c: vec3f) -> vec3f {
  let K = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let p = abs(fract(vec3f(c.x) + K.xyz) * 6.0 - vec3f(K.w));
  return c.z * mix(vec3f(K.x), clamp(p - vec3f(K.x), vec3f(0.0), vec3f(1.0)), c.y);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let c = textureSample(src, samp, in.uv);
  var hsv = rgb_to_hsv(c.rgb);
  hsv.x = fract(hsv.x + params.hue);
  hsv.y = clamp(hsv.y * params.saturation, 0.0, 1.0);
  hsv.z = max(hsv.z * params.value, 0.0);
  return vec4f(hsv_to_rgb(hsv), c.a);
}
