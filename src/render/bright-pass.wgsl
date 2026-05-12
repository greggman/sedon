// Bright-pass: read the HDR scene, output the brightness above the bloom
// threshold (with a soft knee) to a smaller texture that the blur passes
// will smear into the bloom glow.

struct Params {
  threshold: f32,
  soft_knee: f32,
};

@group(0) @binding(0) var scene_tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> params: Params;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

// Standard fullscreen-triangle trick. Index 0,1,2 maps to NDC corners
// (-1,-1), (3,-1), (-1,3); UVs interpolate to cover the visible (0,0)→(1,1).
@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
  let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(i & 2u) * 2.0 - 1.0;
  var out: VsOut;
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let color = textureSample(scene_tex, samp, in.uv).rgb;
  let lum = dot(color, vec3f(0.2126, 0.7152, 0.0722)); // BT.709 luminance
  // Smoothstep ramp from (threshold - knee) → (threshold + knee), so the
  // transition isn't a hard step that creates a visible bloom edge.
  let lower = params.threshold - params.soft_knee;
  let upper = params.threshold + params.soft_knee;
  let t = clamp((lum - lower) / max(upper - lower, 0.0001), 0.0, 1.0);
  let soft = t * t * (3.0 - 2.0 * t);
  return vec4f(color * soft, 1.0);
}
