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
  // > 0.5 → camera is below scene water level; mix the output toward
  // `underwater_color` to give a submerged look (blue/green tint +
  // slight dim). 0 disables.
  underwater_active: f32,
  // 0..1 mix factor toward underwater_color when active.
  underwater_strength: f32,
  // .xyz = RGB tint applied when underwater. .w piggybacks `time`
  // (seconds), driving the underwater UV-wobble shimmer.
  underwater_color: vec4f,
  // .x = zNear, .y = zFar of the scene's reverse-Z perspective
  // projection. Used to recover real world distance from the
  // reverse-Z depth value for distance-based underwater fog —
  // `1 - depth_value` alone is hyperbolic and ~constant for most
  // visible depths, so direct fog on it produces no gradient.
  depth_unproject: vec4f,
};

@group(0) @binding(0) var scene_tex: texture_2d<f32>;
@group(0) @binding(1) var bloom_tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> params: Params;
// Scene depth (reverse-Z, depth32float) — sampled when underwater
// to drive distance-based fog falloff.
@group(0) @binding(4) var depth_tex: texture_2d<f32>;

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
  // Underwater shimmer: when submerged, wobble the screen-space
  // sample UV with a pair of cross-axis sines driven by time. Gives
  // the wavy-glass distortion you see looking up from a pool. Tiny
  // amplitude (~0.4% of the screen) keeps it subtle, not nauseating.
  var sample_uv = in.uv;
  if (params.underwater_active > 0.5) {
    let t = params.underwater_color.w;
    let wobble = vec2f(
      sin(in.uv.y * 30.0 + t * 2.0) * 0.004,
      sin(in.uv.x * 25.0 + t * 1.7) * 0.004,
    );
    sample_uv = clamp(in.uv + wobble, vec2f(0.0), vec2f(1.0));
  }
  let scene = textureSample(scene_tex, samp, sample_uv).rgb;
  let bloom = textureSample(bloom_tex, samp, sample_uv).rgb;
  var combined = scene + bloom * params.bloom_intensity;
  // Underwater tint + distance fog. Applied in LINEAR HDR before
  // tonemap so bright sun glints fade with the rest of the scene.
  // Distance fog uses the depth texture's reverse-Z value as a
  // proxy for "how far the photon travelled through water before
  // hitting that surface". Far pixels fade hard to the murk colour;
  // near pixels keep their original tone modulated by the base tint.
  if (params.underwater_active > 0.5) {
    let tint = params.underwater_color.rgb;
    let dims = textureDimensions(depth_tex);
    let px = vec2i(
      clamp(i32(in.uv.x * f32(dims.x)), 0, i32(dims.x) - 1),
      clamp(i32(in.uv.y * f32(dims.y)), 0, i32(dims.y) - 1),
    );
    let d = textureLoad(depth_tex, px, 0).r;
    // Recover real world distance from the reverse-Z depth value.
    // Reverse-Z perspective: d = zNear * (zFar - dist) / (dist *
    // (zFar - zNear)). Inverting gives the closed-form below. Sky
    // pixels (d → 0) collapse to zFar, treated as full murk.
    let zNear = params.depth_unproject.x;
    let zFar = params.depth_unproject.y;
    let dist = (zNear * zFar) / (zNear + d * (zFar - zNear));
    // exp(-dist * density). Density ~0.06 → visibility 0.5 at ~12
    // units, 0.05 at ~50 units, ~0 at the far plane. Matches the
    // "things 5–10 m away still read clear, anything past 30 m is
    // murk" feel of looking through real cloudy water.
    let visibility = exp(-dist * 0.06);
    let near_color = mix(combined, combined * tint, params.underwater_strength);
    let murk_color = tint * 0.25; // dim ambient floor far from camera
    combined = mix(murk_color, near_color, visibility);
  }
  let tonemapped = select(combined, khronos_neutral_tonemap(combined), params.tonemap_enabled > 0.5);
  return vec4f(linear_to_srgb(tonemapped), 1.0);
}
