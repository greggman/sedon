// Final composite. Reads the HDR scene + the blurred bloom, adds them,
// runs Khronos PBR Neutral tone-mapping, encodes to sRGB, writes to the
// swapchain. This is where the renderer transitions from linear-light
// HDR space (everything upstream) to display space.
//
// The tone-map / sRGB encode pair used to live in each material shader.
// Moving it here means materials write linear HDR (so bright pixels are
// real numbers like 2-8, not clipped at 1) which is what bloom needs to
// see — otherwise nothing would be "above threshold" to bloom.

struct Params {
  bloom_intensity: f32,
  // > 0.5 → apply Khronos Neutral tonemap before sRGB encode (default
  // for actual scenes). ≤ 0.5 → skip tonemap, write linear→sRGB only.
  // The "skip" path is used by flat texture-preview tiles so authored
  // values display exactly as authored (round-trip identity for
  // in-[0,1] colors).
  tonemap_enabled: f32,
};

@group(0) @binding(0) var scene_tex: texture_2d<f32>;
@group(0) @binding(1) var bloom_tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> params: Params;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
  let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(i & 2u) * 2.0 - 1.0;
  var out: VsOut;
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

// Khronos PBR Neutral tonemapper. Identity below ~0.76, smooth highlight
// roll-off above. Authored colors round-trip unchanged; only HDR bright
// pixels get compressed. See pbr.wgsl history for the move from ACES.
fn khronos_neutral_tonemap(color_in: vec3f) -> vec3f {
  let startCompression = 0.8 - 0.04;
  let desaturation = 0.15;
  var color = color_in;
  let x = min(color.r, min(color.g, color.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  color = color - vec3f(offset);
  let peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) {
    return color;
  }
  let d = 1.0 - startCompression;
  let newPeak = 1.0 - d * d / (peak + d - startCompression);
  color = color * (newPeak / peak);
  let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3f(newPeak), g);
}

fn linear_to_srgb(color: vec3f) -> vec3f {
  return pow(color, vec3f(1.0 / 2.2));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let scene = textureSample(scene_tex, samp, in.uv).rgb;
  let bloom = textureSample(bloom_tex, samp, in.uv).rgb;
  let combined = scene + bloom * params.bloom_intensity;
  let tonemapped = select(combined, khronos_neutral_tonemap(combined), params.tonemap_enabled > 0.5);
  return vec4f(linear_to_srgb(tonemapped), 1.0);
}
