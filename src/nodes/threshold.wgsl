struct Params {
  // colour for input < threshold (after softness band).
  low_color: vec4f,
  // colour for input > threshold (after softness band).
  high_color: vec4f,
  // luminance cutoff in [0,1].
  threshold: f32,
  // edge softness around the threshold; 0 = pure binary cutoff,
  // > 0 = smoothstep band of this half-width on each side.
  softness: f32,
  // 0 = use Rec. 709 luminance; 1 = use red channel only; 2 = use
  // alpha channel.
  channel: f32,
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

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let s = textureSample(src, samp, in.uv);
  let ch = i32(params.channel + 0.5);
  var v: f32;
  if (ch == 1) {
    v = s.r;
  } else if (ch == 2) {
    v = s.a;
  } else {
    // Rec. 709 luma.
    v = dot(s.rgb, vec3f(0.2126, 0.7152, 0.0722));
  }

  let half = max(params.softness, 0.0);
  let t = smoothstep(params.threshold - half, params.threshold + half, v);
  return mix(params.low_color, params.high_color, t);
}
