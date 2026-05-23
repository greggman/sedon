// Grass render pass. drawIndexedIndirect over the cross-quad card mesh;
// each instance reads its placement (written by grass-cull.wgsl) from
// the `instances` storage buffer via @builtin(instance_index). Group 0
// is the shared scene bind group (camera matrices, lighting, fog, AND
// the shadow map) — same layout every material kind uses — so grass
// reuses the scene's view/projection, day/night-faded light, and the
// shadow pass's depth map. shadow-pcf.wgsl is concatenated ahead of
// this at module build (see grass.ts), supplying `sample_shadow`; it
// references the `uniforms`, `shadow_map`, `shadow_samp` declared here.

struct SceneU {
  modelView: mat4x4f,
  projection: mat4x4f,
  lightViewProj: mat4x4f,
  lightDirWorld: vec3f,
  lightColor: vec3f,        // linear HDR (atmospheric sun)
  skyColor: vec3f,          // linear HDR (hemisphere up)
  ambientIntensity: f32,    // scales whole hemisphere term (packed with skyColor)
  groundColor: vec3f,       // linear HDR (hemisphere down)
  fog: vec4f,               // rgb = fog colour (sRGB), w = density
};
@group(0) @binding(0) var<uniform> uniforms: SceneU;
@group(0) @binding(2) var shadow_map: texture_depth_2d;
@group(0) @binding(3) var shadow_samp: sampler_comparison;

struct GrassU {
  viewProj: mat4x4f,
  cameraPos: vec4f,   // xyz, w = time
  grid: vec4f,
  worldMap: vec4f,
  params0: vec4f,
  blade: vec4f,       // bladeW, bladeH, windStrength, windSpeed
  baseColor: vec4f,   // rgb, colorVariation
  tipColor: vec4f,    // rgb, seed
  counts: vec4u,
};
struct GrassInstance {
  posScale: vec4f,    // xyz pos, w scale
  data: vec4f,        // yaw, typeIndex, fade, colorRand
};
@group(1) @binding(0) var<uniform> u: GrassU;
@group(1) @binding(1) var<storage, read> instances: array<GrassInstance>;
@group(1) @binding(2) var cards: texture_2d_array<f32>;
@group(1) @binding(3) var samp: sampler;

struct VsIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @builtin(instance_index) inst: u32,
};
struct VsOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) typeIndex: f32,
  @location(2) color: vec3f,
  @location(3) fade: f32,
  @location(4) view_pos: vec3f,
  @location(5) world_pos: vec3f,
};

fn srgb_to_linear(color: vec3f) -> vec3f {
  return pow(color, vec3f(2.2));
}

// 4×4 Bayer ordered-dither threshold in [0,1) from the pixel coord.
// Used for the distance fade: as `fade` drops toward the draw-distance
// ring, progressively more pixels fail `fade < threshold` and discard,
// dissolving blades out smoothly instead of popping at a hard alpha
// cut. Ordered (not random) so it's temporally stable — no shimmer as
// the camera moves, which a per-pixel hash would cause without TAA.
fn bayer4x4(p: vec2f) -> f32 {
  let x = u32(p.x) & 3u;
  let y = u32(p.y) & 3u;
  let idx = y * 4u + x;
  var m = array<f32, 16>(
    0.0,  8.0,  2.0, 10.0,
    12.0, 4.0, 14.0,  6.0,
    3.0, 11.0,  1.0,  9.0,
    15.0, 7.0, 13.0,  5.0,
  );
  return (m[idx] + 0.5) / 16.0;
}

@vertex
fn vs_main(in: VsIn) -> VsOut {
  let blade = instances[in.inst];
  let pos = blade.posScale.xyz;
  let scale = blade.posScale.w;
  let yaw = blade.data.x;
  let heightFrac = in.position.y;  // 0 base .. 1 tip

  var local = vec3f(
    in.position.x * u.blade.x * scale,
    in.position.y * u.blade.y * scale,
    in.position.z * u.blade.x * scale,
  );

  // Wind: only the tip sways (heightFrac²), phase offset by world XZ.
  let t = u.cameraPos.w;
  let phase = pos.x * 0.35 + pos.z * 0.35;
  let sway = sin(t * u.blade.w + phase) * u.blade.z * heightFrac * heightFrac;
  local.x += sway;
  local.z += sway * 0.5;

  let cy = cos(yaw);
  let sy = sin(yaw);
  let rx = local.x * cy + local.z * sy;
  let rz = -local.x * sy + local.z * cy;
  let world = vec3f(pos.x + rx, pos.y + local.y, pos.z + rz);

  var out: VsOut;
  let viewPos4 = uniforms.modelView * vec4f(world, 1.0);
  out.view_pos = viewPos4.xyz;
  out.clip = uniforms.projection * viewPos4;
  out.world_pos = world;
  out.uv = in.uv;
  out.typeIndex = blade.data.y;
  let tint = mix(u.baseColor.rgb, u.tipColor.rgb, heightFrac);
  let cr = (blade.data.w - 0.5) * u.baseColor.w; // colorVariation = baseColor.w
  out.color = tint * (1.0 + cr);
  out.fade = blade.data.z;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let tex = textureSample(cards, samp, in.uv, i32(in.typeIndex));
  // Blade silhouette: hard alpha-cut on the card's authored alpha.
  if (tex.a < 0.5) { discard; }
  // Distance fade: dissolve via ordered dither (no hard ring pop).
  if (in.fade < bayer4x4(in.clip.xy)) { discard; }

  // Match the scene's colour pipeline: authored colours are sRGB,
  // linearize before lighting; write linear HDR (composite tone-maps).
  let albedo = srgb_to_linear(tex.rgb * in.color);
  let n = vec3f(0.0, 1.0, 0.0);                       // soft sky-up normal
  let l = normalize(uniforms.lightDirWorld);
  let n_dot_l = max(dot(n, l), 0.0);
  let shadow = sample_shadow(in.world_pos);            // trees shadow the grass
  // Hemisphere ambient — grass uses a sky-up normal, so it reads mostly
  // sky tint with a touch of ground bounce, matching the PBR path.
  let hemi_t = n.y * 0.5 + 0.5;
  let ambient_color = mix(uniforms.groundColor, uniforms.skyColor, hemi_t) * uniforms.ambientIntensity;
  // Lambert diffuse + hemisphere ambient. lightColor / sky / ground are
  // already linear HDR — no srgb conversion needed.
  let lit = albedo / 3.14159265 * uniforms.lightColor * n_dot_l * shadow + albedo * ambient_color;
  // Fog matches pbr.apply_fog: exp falloff in view-z, sRGB fog colour.
  let visibility = exp(-uniforms.fog.w * abs(in.view_pos.z));
  let col = mix(srgb_to_linear(uniforms.fog.rgb), lit, visibility);
  return vec4f(col, 1.0);
}
