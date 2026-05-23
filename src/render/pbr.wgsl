// PBR (Cook-Torrance GGX) material kind. The first kind to use the split
// bind-group convention:
//
//   @group(0) — scene-level bindings shared across all material kinds:
//     binding 0: scene uniforms (modelView, projection, lightViewProj,
//                lighting, fog)
//     binding 1: shared color sampler
//     binding 2: shadow map (depth) — filled by the shadow pass
//     binding 3: shadow comparison sampler (linear → 2×2 PCF)
//
//   @group(1) — kind-specific bindings:
//     binding 0: basecolor texture
//     binding 1: per-material params (roughness, metallic, detail scale/strength)
//     binding 2: normal map (flat 1×1 placeholder when material has none)
//     binding 3: detail basecolor — greyscale 0.5-centered multiplier
//     binding 4: detail normal — high-freq tangent-space normal
//
// Detail textures are sampled at uv * detailScale (typically 4–16× tighter
// than the base) and overlaid on the base lookups. Both detail slots have
// flat placeholders so an authored material that doesn't wire them costs
// only the sample, not a code path.
//
// Adding a new kind means declaring its own @group(1) layout — @group(0)
// stays exactly as below.

struct Uniforms {
  modelView: mat4x4f,
  projection: mat4x4f,
  lightViewProj: mat4x4f,
  lightDirWorld: vec3f,
  // Sun colour — linear HDR, already includes atmospheric transmittance
  // along the sun ray (set by output.ts via deriveLighting). No
  // srgb-linearization in the shader anymore.
  lightColor: vec3f,
  // Hemisphere ambient — both linear HDR, derived from the same
  // atmosphere model that draws the sky. ambientIntensity scales the
  // whole hemisphere term (packed in skyColor.w).
  skyColor: vec3f,
  ambientIntensity: f32,
  groundColor: vec3f,
  fog: vec4f,
};

struct Material {
  roughness: f32,
  metallic: f32,
  detailScale: f32,
  detailStrength: f32,
  // When unlit > 0.5, fs_main skips lighting and returns the
  // (linearized) basecolor × tint × detail factor directly. Used by
  // the preview pane's flat synthesized tiles so authoring a texture
  // shows the texture itself.
  unlit: f32,
  // Alpha threshold for hard-cutout rendering (leaves, fronds, decals).
  // 0 = no cutout (opaque pipeline). >0 = fragments with basecolor.a
  // below this value are discarded. The renderer pairs this with a
  // cull-none pipeline so cutout cards show from both sides.
  alphaCutoff: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var shadow_map: texture_depth_2d;
@group(0) @binding(3) var shadow_samp: sampler_comparison;

@group(1) @binding(0) var basecolor: texture_2d<f32>;
@group(1) @binding(1) var<uniform> material: Material;
@group(1) @binding(2) var normal_map: texture_2d<f32>;
@group(1) @binding(3) var detail_basecolor: texture_2d<f32>;
@group(1) @binding(4) var detail_normal: texture_2d<f32>;

struct VsIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) inst_col0: vec4f,
  @location(4) inst_col1: vec4f,
  @location(5) inst_col2: vec4f,
  @location(6) inst_col3: vec4f,
  @location(7) inst_tint: vec4f,
};

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) view_pos: vec3f,
  @location(1) view_normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) tint: vec4f,
  // World-space position carried through so the fragment can transform
  // into light clip space for shadow sampling without re-multiplying by
  // the instance matrix per fragment.
  @location(4) world_pos: vec3f,
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
  let inst_mat = mat4x4f(in.inst_col0, in.inst_col1, in.inst_col2, in.inst_col3);
  let world_pos4 = inst_mat * vec4f(in.position, 1.0);
  let view_pos4 = uniforms.modelView * world_pos4;
  var out: VsOut;
  out.position = uniforms.projection * view_pos4;
  out.view_pos = view_pos4.xyz;
  out.world_pos = world_pos4.xyz;

  let inst_3x3 = mat3x3f(in.inst_col0.xyz, in.inst_col1.xyz, in.inst_col2.xyz);
  let world_normal = inst_3x3 * in.normal;
  let normal_mat = mat3x3f(
    uniforms.modelView[0].xyz,
    uniforms.modelView[1].xyz,
    uniforms.modelView[2].xyz,
  );
  out.view_normal = normal_mat * world_normal;
  out.uv = in.uv;
  out.tint = in.inst_tint;
  return out;
}

// sample_shadow + POISSON_DISK_16 are concatenated in from
// shadow-pcf.wgsl at module-creation time (see pbr-kind.ts). They
// reference `uniforms`, `shadow_map`, `shadow_samp` declared above —
// WGSL allows forward references to module-scope items.

const PI: f32 = 3.14159265359;

fn distribution_ggx(n_dot_h: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let n_dot_h2 = n_dot_h * n_dot_h;
  let denom = n_dot_h2 * (a2 - 1.0) + 1.0;
  return a2 / max(PI * denom * denom, 0.0001);
}

fn geometry_schlick_ggx(n_dot_v: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return n_dot_v / (n_dot_v * (1.0 - k) + k);
}

fn geometry_smith(n_dot_v: f32, n_dot_l: f32, roughness: f32) -> f32 {
  return geometry_schlick_ggx(n_dot_v, roughness) * geometry_schlick_ggx(n_dot_l, roughness);
}

fn fresnel_schlick(cos_theta: f32, f0: vec3f) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(clamp(1.0 - cos_theta, 0.0, 1.0), 5.0);
}

fn cotangent_frame(n: vec3f, p: vec3f, uv: vec2f) -> mat3x3f {
  let dp1 = dpdx(p);
  let dp2 = dpdy(p);
  let duv1 = dpdx(uv);
  let duv2 = dpdy(uv);

  let dp2perp = cross(dp2, n);
  let dp1perp = cross(n, dp1);
  let t = dp2perp * duv1.x + dp1perp * duv2.x;
  let b = dp2perp * duv1.y + dp1perp * duv2.y;

  let invmax = inverseSqrt(max(dot(t, t), dot(b, b)));
  return mat3x3f(t * invmax, b * invmax, n);
}

// Build the tangent-space normal: base normal-map sample, plus detail
// normal sampled at uv * detailScale and folded in by adding its XY and
// multiplying its Z. Strength scales the detail's XY contribution so 0
// reduces to the base; the flat (0,0,1) placeholder makes this a no-op
// for materials without an authored detail normal.
fn perturb_normal(n: vec3f, p: vec3f, uv: vec2f) -> vec3f {
  let base = textureSample(normal_map, samp, uv).rgb * 2.0 - vec3f(1.0);
  let detail_uv = uv * material.detailScale;
  let detail = textureSample(detail_normal, samp, detail_uv).rgb * 2.0 - vec3f(1.0);
  let blended_tangent = normalize(vec3f(
    base.xy + detail.xy * material.detailStrength,
    base.z * detail.z,
  ));
  let tbn = cotangent_frame(n, p, uv);
  return normalize(tbn * blended_tangent);
}

// Greyscale detail modulates albedo. sample=0.5 is the no-op midpoint;
// values below darken, above lighten. Strength linearly scales the
// deviation from 0.5, so strength=0 returns 1.0 (no change).
fn detail_albedo_factor(uv: vec2f) -> f32 {
  let sample = textureSample(detail_basecolor, samp, uv * material.detailScale).r;
  return 1.0 + (sample - 0.5) * 2.0 * material.detailStrength;
}

// Takes already-linearized albedo. lightColor / skyColor / groundColor on
// the uniform side are LINEAR HDR (derived from the atmosphere model by
// output.ts) — no srgb conversion here.
fn apply_lighting(albedo: vec3f, view_pos: vec3f, n: vec3f, roughness: f32, metallic: f32, shadow: f32) -> vec3f {
  let v = normalize(-view_pos);
  let l_world = normalize(uniforms.lightDirWorld);
  let view_rot = mat3x3f(
    uniforms.modelView[0].xyz,
    uniforms.modelView[1].xyz,
    uniforms.modelView[2].xyz,
  );
  let l = normalize(view_rot * l_world);
  let h = normalize(v + l);

  let n_dot_v = max(dot(n, v), 0.0);
  let n_dot_l = max(dot(n, l), 0.0);
  let n_dot_h = max(dot(n, h), 0.0);
  let h_dot_v = max(dot(h, v), 0.0);

  let f0 = mix(vec3f(0.04), albedo, metallic);
  let d = distribution_ggx(n_dot_h, roughness);
  let g = geometry_smith(n_dot_v, n_dot_l, roughness);
  let f = fresnel_schlick(h_dot_v, f0);
  let specular = (d * g * f) / max(4.0 * n_dot_v * n_dot_l, 0.0001);

  let k_s = f;
  let k_d = (vec3f(1.0) - k_s) * (1.0 - metallic);

  // Hemisphere ambient — surfaces facing up read the sky colour, surfaces
  // facing down read the ground bounce, with a smooth Lambert-cosine-ish
  // blend in between. Needs the WORLD-space normal (the sky is in world
  // space); n is view-space, so multiply by the transpose of view_rot
  // (orthonormal → transpose = inverse).
  let n_world = transpose(view_rot) * n;
  let hemi_t = n_world.y * 0.5 + 0.5;
  let ambient_color = mix(uniforms.groundColor, uniforms.skyColor, hemi_t) * uniforms.ambientIntensity;

  // Shadow attenuates direct light only. Ambient stays full — physically
  // wrong but visually right: a fully-shadowed surface still receives sky
  // bounce light and would otherwise read as pure black.
  let direct = (k_d * albedo / PI + specular) * uniforms.lightColor * n_dot_l * shadow;
  let ambient_term = albedo * ambient_color;
  return direct + ambient_term;
}

// Fog color is sRGB on the uniform side; linearize before mixing in
// linear-light space.
fn apply_fog(lit: vec3f, view_pos_z: f32) -> vec3f {
  let visibility = exp(-uniforms.fog.w * abs(view_pos_z));
  return mix(srgb_to_linear(uniforms.fog.xyz), lit, visibility);
}

// sRGB → linear via a gamma-2.2 approximation. Authored colors
// (basecolor textures, tints, light/ambient/fog/sky uniforms) are sRGB
// by convention — the user picks values that look right on a display.
// We linearize on entry and write linear HDR; tone-mapping + sRGB
// encode happens later in the composite pass, so bright sun-lit pixels
// can exceed 1.0 here and feed bloom.
//
// "Data" textures — normal maps, masks, detail factors, roughness —
// stay linear: no conversion needed.
fn srgb_to_linear(color: vec3f) -> vec3f {
  return pow(color, vec3f(2.2));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let albedo_sample = textureSample(basecolor, samp, in.uv);
  // Hard alpha cutout for foliage / decals. Default alphaCutoff=0 makes
  // this a no-op for opaque materials; the renderer also routes cutout
  // materials onto a separate cull-none pipeline so cards are two-sided.
  if (albedo_sample.a < material.alphaCutoff) {
    discard;
  }
  // basecolor + tint are sRGB-authored colors; the detail factor is a
  // greyscale multiplier (data, not color) and stays in unit space.
  // Apply the multiplier in linear space so its "0.5 = no-op" semantics
  // act on linear-light values.
  let albedo = srgb_to_linear(albedo_sample.rgb * in.tint.rgb) * detail_albedo_factor(in.uv);

  // Unlit shortcut: return the basecolor (in linear HDR — composite
  // still re-encodes sRGB so the round-trip is identity for in-[0,1]
  // values). Branching on a uniform value keeps control flow uniform,
  // so the subsequent texture/comparison samples below are safe to
  // skip. Used by synthesized texture/material/heightfield previews so
  // authored values display as authored.
  if (material.unlit > 0.5) {
    return vec4f(albedo, albedo_sample.a);
  }

  let n_geom = normalize(in.view_normal);
  let n = perturb_normal(n_geom, in.view_pos, in.uv);
  let shadow = sample_shadow(in.world_pos);

  let lit = apply_lighting(albedo, in.view_pos, n, material.roughness, material.metallic, shadow);
  let final_color = apply_fog(lit, in.view_pos.z);
  // Linear HDR output. Composite pass handles tone-map + sRGB.
  return vec4f(final_color, albedo_sample.a);
}
