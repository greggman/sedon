// Shared shadow PCF. Concatenated into pbr.wgsl and terrain-splat.wgsl
// at module-creation time (see pbr-kind.ts / terrain-splat-kind.ts) —
// WGSL has no `#include`, but JavaScript template strings work fine.
//
// Forward-references the host shader's `uniforms`, `shadow_map`, and
// `shadow_samp` bindings — WGSL allows this since the module is
// resolved as a whole regardless of textual order.

// 16-sample Poisson disk in [-1, 1]² (Mittring's set), irregular enough
// that the kernel pattern doesn't band at shadow penumbras.
var<private> POISSON_DISK_16: array<vec2f, 16> = array<vec2f, 16>(
  vec2f(-0.94201624, -0.39906216),
  vec2f( 0.94558609, -0.76890725),
  vec2f(-0.09418410, -0.92938870),
  vec2f( 0.34495938,  0.29387760),
  vec2f(-0.91588581,  0.45771432),
  vec2f(-0.81544232, -0.87912464),
  vec2f(-0.38277543,  0.27676845),
  vec2f( 0.97484398,  0.75648379),
  vec2f( 0.44323325, -0.97511554),
  vec2f( 0.53742981, -0.47373420),
  vec2f(-0.26496911, -0.41893023),
  vec2f( 0.79197514,  0.19090188),
  vec2f(-0.24188840,  0.99706507),
  vec2f(-0.81409955,  0.91437590),
  vec2f( 0.19984126,  0.78641367),
  vec2f( 0.14383161, -0.14100790),
);

// 16-tap Poisson disk PCF with per-fragment rotation. Returns 1.0 for
// fully lit, 0.0 for fully occluded, fractional in penumbras. Out-of-
// bounds fragments fall back to lit (single-cascade shadow map — distant
// occluders wouldn't be expected to cast strong shadows anyway).
//
// PCF loop is unconditional so textureSampleCompare stays in uniform
// control flow (WGSL requirement). Out-of-bounds fragments still execute
// the loop but `select` returns 1.0 over the PCF result for them.
//
// Bias 0.003 is added to the fragment depth (reverse-Z, so larger =
// closer to light) to avoid self-shadow acne — tuned against the forest
// demo; too small → acne stripes, too large → peter-panning.
fn sample_shadow(world_pos: vec3f) -> f32 {
  let light_clip = uniforms.lightViewProj * vec4f(world_pos, 1.0);
  // Ortho projection: w == 1, no divide needed.
  let shadow_uv = vec2f(light_clip.x * 0.5 + 0.5, 0.5 - light_clip.y * 0.5);
  let depth_ref = light_clip.z + 0.003;
  let in_bounds =
    all(shadow_uv >= vec2f(0.0)) && all(shadow_uv <= vec2f(1.0))
    && light_clip.z >= 0.0 && light_clip.z <= 1.0;

  // Pseudo-random rotation derived from world XZ — stable per surface
  // point, so the rotation doesn't shimmer when the camera moves.
  let hash = fract(sin(dot(world_pos.xz, vec2f(12.9898, 78.233))) * 43758.5453);
  let theta = hash * 6.28318530718;
  let cs = cos(theta);
  let sn = sin(theta);

  // ~3 texels of a 2048-pixel shadow map. Larger = softer / wider
  // penumbra, smaller = closer to hard shadows.
  let radius = 3.0 / 2048.0;

  var sum = 0.0;
  for (var i = 0u; i < 16u; i = i + 1u) {
    let s = POISSON_DISK_16[i];
    let offset = vec2f(s.x * cs - s.y * sn, s.x * sn + s.y * cs) * radius;
    sum = sum + textureSampleCompare(shadow_map, shadow_samp, shadow_uv + offset, depth_ref);
  }
  return select(1.0, sum / 16.0, in_bounds);
}
