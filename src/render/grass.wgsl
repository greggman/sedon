// Grass render pass. drawIndexedIndirect over the cross-quad card mesh;
// each instance reads its placement (written by grass-cull.wgsl) from
// the `instances` storage buffer via @builtin(instance_index). Group 0
// is the shared scene bind group (camera matrices, lighting, fog) — the
// same layout every material kind uses — so grass reuses the scene's
// view/projection and day/night-faded light without its own copy.

struct SceneU {
  modelView: mat4x4f,
  projection: mat4x4f,
  lightViewProj: mat4x4f,
  lightDirWorld: vec3f,
  lightColor: vec3f,
  ambient: vec3f,
  fog: vec4f,         // rgb = fog colour, w = density
};
@group(0) @binding(0) var<uniform> scene: SceneU;

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
  @location(4) viewPos: vec3f,
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
  let blade = instances[in.inst];
  let pos = blade.posScale.xyz;
  let scale = blade.posScale.w;
  let yaw = blade.data.x;
  // position.y is the mesh's 0(base)..1(tip) height fraction.
  let heightFrac = in.position.y;

  // Scale the unit card to the field's blade size (× per-blade scale).
  var local = vec3f(
    in.position.x * u.blade.x * scale,
    in.position.y * u.blade.y * scale,
    in.position.z * u.blade.x * scale,
  );

  // Wind: only the tip sways (heightFrac²), phase offset by world XZ so
  // neighbouring blades aren't in lockstep. Static when time is frozen
  // (animation paused) since u.cameraPos.w stops advancing.
  let t = u.cameraPos.w;
  let phase = pos.x * 0.35 + pos.z * 0.35;
  let sway = sin(t * u.blade.w + phase) * u.blade.z * heightFrac * heightFrac;
  local.x += sway;
  local.z += sway * 0.5;

  // Yaw-rotate about +Y, then translate to the blade's world position.
  let cy = cos(yaw);
  let sy = sin(yaw);
  let rx = local.x * cy + local.z * sy;
  let rz = -local.x * sy + local.z * cy;
  let world = vec3f(pos.x + rx, pos.y + local.y, pos.z + rz);

  var out: VsOut;
  let viewPos4 = scene.modelView * vec4f(world, 1.0);
  out.viewPos = viewPos4.xyz;
  out.clip = scene.projection * viewPos4;
  out.uv = in.uv;
  out.typeIndex = blade.data.y;
  // Base→tip colour gradient, jittered per blade by colorRand.
  let tint = mix(u.baseColor.rgb, u.tipColor.rgb, heightFrac);
  let cr = (blade.data.w - 0.5) * u.baseColor.w; // colorVariation = baseColor.w
  out.color = tint * (1.0 + cr);
  out.fade = blade.data.z;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let tex = textureSample(cards, samp, in.uv, i32(in.typeIndex));
  // Alpha-cut, scaled by the distance fade so blades thin out toward
  // the draw-distance ring rather than popping at a hard edge.
  let a = tex.a * in.fade;
  if (a < 0.5) { discard; }
  // Soft, even lighting off a sky-up normal (see grass-card.ts): sun
  // term + ambient, sharing the scene's day/night-faded light values.
  let ndl = max(dot(normalize(scene.lightDirWorld), vec3f(0.0, 1.0, 0.0)), 0.0);
  let lit = tex.rgb * in.color * (scene.ambient + scene.lightColor * ndl);
  // Match the scene's exponential fog so grass recedes into the same
  // haze the terrain does.
  let dist = length(in.viewPos);
  let fogF = clamp(1.0 - exp(-dist * scene.fog.w), 0.0, 1.0);
  let col = mix(lit, scene.fog.rgb, fogF);
  return vec4f(col, 1.0);
}
