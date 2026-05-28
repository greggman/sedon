// Animated water surface. Standard scene-entity vertex pipeline (same
// per-instance transform layout as PBR + terrain-splat), with a
// procedural fragment that builds tangent-space normals from
// scrolling sine waves and renders a tight-rough specular highlight
// against the sun.
//
// All-procedural — no textures, no per-material bindings beyond a
// small uniform block (colour + wave + roughness).
//
// `time` lives at the trailing slot of the shared scene uniform
// buffer (offset 272), so adding water doesn't require touching any
// other shader's `Uniforms` struct.

struct Uniforms {
  modelView: mat4x4f,
  projection: mat4x4f,
  lightViewProj: mat4x4f,
  lightDirWorld: vec3f,
  lightColor: vec3f,
  skyColor: vec3f,
  ambientIntensity: f32,
  groundColor: vec3f,
  fog: vec4f,
  time: f32,
};

struct WaterParams {
  color: vec4f,
  // x = waveStrength, y = waveScale, z = waveSpeed, w = roughness
  waves: vec4f,
  // x,y = worldSize (heightfield XZ extent), z = heightMin, w = heightMax
  world: vec4f,
  // x = foamWidth (world units), y = foamEnabled (0/1), z/w = unused
  foam: vec4f,
  // x = rippleStrength, y = rippleScale, z = rippleSpeed, w = unused.
  // Per-fragment-only sub-mesh wave layer; see fs_main for how it
  // combines with the mesh-scale `waves` layer.
  ripple: vec4f,
  // x = absorption (per-world-unit Beer-Lambert rate), y/z/w unused.
  // Drives the depth-based tint applied to refraction in fs_main.
  transport: vec4f,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var shadow_map: texture_depth_2d;
@group(0) @binding(3) var shadow_samp: sampler_comparison;

@group(1) @binding(0) var<uniform> water: WaterParams;
@group(1) @binding(1) var heightTex: texture_2d<f32>;
@group(1) @binding(2) var heightSamp: sampler;

// Copy of the depth buffer at the end of the opaque pass (everything
// EXCEPT water has been drawn into it). Sampled in screen space for
// SSR ray marching: each step's projected NDC.z is compared against
// the stored depth to detect hits. depth32float bound as
// `texture_2d<f32>` with unfilterable-float sampleType — read via
// textureLoad, not textureSample.
@group(2) @binding(0) var sceneDepth: texture_2d<f32>;
// Full-res copy of the opaque HDR scene, taken right before water
// draws. Used for two things: (1) refraction — sample at the water
// fragment's own screen UV with a wave-normal offset to look THROUGH
// the surface, (2) the SSR hit sample — read the colour at the
// reflection-ray's hit pixel to feed back into the reflection term.
@group(2) @binding(1) var refractionTex: texture_2d<f32>;

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
  @location(2) world_pos: vec3f,
  @location(3) tint: vec4f,
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
  let inst_mat = mat4x4f(in.inst_col0, in.inst_col1, in.inst_col2, in.inst_col3);
  var world_pos4 = inst_mat * vec4f(in.position, 1.0);
  // Displace vertices vertically by the wave height field. Same
  // function the fragment shader uses, so the analytic normal it
  // computes is the true derivative of THIS surface (no shading-vs-
  // silhouette mismatch). Strength + scale + speed come from the
  // shared per-material uniforms.
  let strength = water.waves.x;
  let scale = water.waves.y;
  let speed = water.waves.z;
  let wave = computeWaves(world_pos4.xz, uniforms.time, strength, scale, speed);
  world_pos4.y = world_pos4.y + wave.h;
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
  out.tint = in.inst_tint;
  return out;
}

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
fn srgb_to_linear(color: vec3f) -> vec3f {
  return pow(color, vec3f(2.2));
}
fn apply_fog(lit: vec3f, view_pos_z: f32) -> vec3f {
  let visibility = exp(-uniforms.fog.w * abs(view_pos_z));
  return mix(srgb_to_linear(uniforms.fog.xyz), lit, visibility);
}

// Procedural water surface = sum of three scrolling sine waves at
// non-aligned directions. Returns both the height (consumed by the
// vertex shader for vertical displacement) and the analytic
// tangent-space normal (consumed by the fragment shader). Sharing
// one function for both keeps the surface physically consistent —
// the normal you see at a fragment is the true derivative of the
// height the vertex shader displaced to.
//
// World-XZ inputs so the wave pattern is locked to the world, not
// the mesh. Wider planes don't stretch the waves; subdividing the
// mesh gives more taps of the same field.
struct Wave {
  h: f32,
  n: vec3f,
};

// Per-fragment ripple normal — a 6-octave sum-of-sines with golden-
// ratio frequency steps and golden-angle direction steps. The
// golden-ratio choice is deliberate: φ is the worst irrationally
// approximable number, so no two octaves' frequencies form a small
// integer ratio and no two octaves' directions are parallel —
// neither dimension can produce a repeating interference pattern at
// any small scale. Higher octaves carry less amplitude but higher
// frequency (and thus comparable slope), giving fine surface detail
// without any one octave dominating.
//
// Only the NORMAL is needed (the vertex shader doesn't displace by
// ripples — that'd require an absurdly dense mesh). 6 octaves cost
// roughly 2× the 3-sine computeWaves; the explicit accumulator loop
// + early-exit-friendly structure makes it cheap enough to run per
// fragment.
fn computeRipplesNormal(worldXZ: vec2f, t: f32, strength: f32, scale: f32, speed: f32) -> vec3f {
  let invScale = 1.0 / max(scale, 0.0001);
  let p = worldXZ * invScale;
  let goldenAngle: f32 = 2.39996323;  // 2π × (1 - 1/φ)
  let phi: f32 = 1.6180339;
  var dh_x: f32 = 0.0;
  var dh_z: f32 = 0.0;
  var amp_sum: f32 = 0.0;
  var freq: f32 = 1.0;
  var amp: f32 = 1.0;
  for (var i: u32 = 0u; i < 6u; i = i + 1u) {
    let angle = f32(i) * goldenAngle;
    let dir = vec2f(cos(angle), sin(angle));
    // Per-octave speed jitter so the layers don't pulse in unison.
    let phase = dot(p, dir) * freq + t * speed * (1.0 + f32(i) * 0.137);
    let c = cos(phase) * amp * freq;
    dh_x += c * dir.x;
    dh_z += c * dir.y;
    amp_sum += amp;
    freq *= phi;
    amp /= phi;
  }
  let k = strength * invScale / amp_sum;
  return normalize(vec3f(-dh_x * k, 1.0, -dh_z * k));
}

fn computeWaves(worldXZ: vec2f, t: f32, strength: f32, scale: f32, speed: f32) -> Wave {
  let invScale = 1.0 / max(scale, 0.0001);
  let p = worldXZ * invScale;
  let d1 = vec2f( 1.0,  0.6);
  let d2 = vec2f(-0.4,  1.0);
  let d3 = vec2f( 0.7, -0.9);
  let ph1 = dot(p, d1) + t * 1.0 * speed;
  let ph2 = dot(p, d2) + t * 1.3 * speed;
  let ph3 = dot(p, d3) + t * 0.7 * speed;
  let s1 = sin(ph1);
  let s2 = sin(ph2);
  let s3 = sin(ph3);
  let c1 = cos(ph1);
  let c2 = cos(ph2);
  let c3 = cos(ph3);
  let dhx = (c1 * d1.x + c2 * d2.x + c3 * d3.x) * strength * invScale;
  let dhz = (c1 * d1.y + c2 * d2.y + c3 * d3.y) * strength * invScale;
  var out: Wave;
  out.h = (s1 + s2 + s3) * strength;
  out.n = normalize(vec3f(-dhx, 1.0, -dhz));
  return out;
}

// Screen-space reflection with binary-search refinement. Two phases:
//
//  1. COARSE march — step the reflection ray through view space at
//     STEP_LEN intervals, checking the stored opaque depth at each
//     projected pixel. With reverse-Z, the stored depth is larger
//     for closer geometry. The first step whose NDC.z falls BELOW
//     the stored depth has crossed the depth surface — somewhere
//     between the previous step and this one.
//
//  2. REFINE — once a crossing is found, bisect between the last
//     "in-front" sample and the first "behind" sample 6 times to
//     pinpoint the actual crossing. Without refinement, the apparent
//     hit position depends on whether the coarse step happens to
//     land just inside or just outside the silhouette of nearby
//     geometry — producing aliased "tabs" of reflected colour where
//     no real intersection exists.
//
// After refinement, validate the hit with a small thickness check
// (the ray must be within THICKNESS view-units of the surface's
// recovered view-space depth). Recovering view-z from NDC.z uses
// the standard reverse-Z perspective identity:
//   view_z = -projection[3].z / (ndc.z + projection[2].z).
//
// Misses fall through to the sky colour (linear HDR ambient, from
// the atmosphere model).
fn ssr_reflect(view_pos: vec3f, n_view: vec3f) -> vec3f {
  let incident = normalize(view_pos);
  let refl_dir = reflect(incident, n_view);
  let dims = vec2f(textureDimensions(sceneDepth, 0));
  let MAX_STEPS = 48u;
  let REFINE_STEPS = 6u;
  let STEP_LEN: f32 = 1.0;
  let THICKNESS: f32 = 0.35;
  let p10 = uniforms.projection[2].z;
  let p14 = uniforms.projection[3].z;

  var prev_sample = view_pos;
  for (var i: u32 = 1u; i <= MAX_STEPS; i = i + 1u) {
    let sample_view = view_pos + refl_dir * (f32(i) * STEP_LEN);
    let clip = uniforms.projection * vec4f(sample_view, 1.0);
    if (clip.w <= 0.0) { break; }
    let ndc = clip.xyz / clip.w;
    if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) { break; }
    if (ndc.z < 0.0 || ndc.z > 1.0) { break; }
    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    let px = vec2i(uv * dims);
    let scene_depth = textureLoad(sceneDepth, px, 0).r;
    // scene_depth == 0 → sky pixel; can't possibly be a hit there.
    if (scene_depth > 0.0 && ndc.z < scene_depth) {
      // Binary-refine between prev_sample (in front of surface)
      // and sample_view (behind surface) for the exact crossing.
      var lo = prev_sample;
      var hi = sample_view;
      for (var j: u32 = 0u; j < REFINE_STEPS; j = j + 1u) {
        let mid = (lo + hi) * 0.5;
        let mid_clip = uniforms.projection * vec4f(mid, 1.0);
        let mid_ndc = mid_clip.xyz / mid_clip.w;
        let mid_uv = vec2f(mid_ndc.x * 0.5 + 0.5, 0.5 - mid_ndc.y * 0.5);
        let mid_px = vec2i(mid_uv * dims);
        let mid_depth = textureLoad(sceneDepth, mid_px, 0).r;
        if (mid_depth > 0.0 && mid_ndc.z < mid_depth) {
          hi = mid;
        } else {
          lo = mid;
        }
      }
      // hi ≈ the surface crossing. Sample colour + depth there and
      // validate the thickness: if the ray is too far behind the
      // recovered scene view-z, it crossed at a silhouette edge
      // (sky-vs-object discontinuity) rather than a real surface.
      let hi_clip = uniforms.projection * vec4f(hi, 1.0);
      let hi_ndc = hi_clip.xyz / hi_clip.w;
      let hi_uv = vec2f(hi_ndc.x * 0.5 + 0.5, 0.5 - hi_ndc.y * 0.5);
      let hi_px = vec2i(hi_uv * dims);
      let hi_depth = textureLoad(sceneDepth, hi_px, 0).r;
      if (hi_depth > 0.0) {
        let scene_view_z = -p14 / (hi_depth + p10);
        let depth_gap = scene_view_z - hi.z;
        if (depth_gap < THICKNESS) {
          return textureLoad(refractionTex, hi_px, 0).rgb;
        }
      }
      // Refined hit failed — drop to sky fallback rather than
      // continuing past the surface (we'd just keep producing
      // silhouette-edge false hits all the way to MAX_STEPS).
      break;
    }
    prev_sample = sample_view;
  }
  return uniforms.skyColor;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Build tangent-space normal from scrolling waves; rotate into
  // view space using the geometry's world basis (water plane has
  // world-up Y, so view_rot * tangent ≈ view_rot * world).
  let strength = water.waves.x;
  let scale = water.waves.y;
  let speed = water.waves.z;
  let roughness = water.waves.w;

  // Two-layer wave normal. The MESH-SCALE layer (lo) is the same
  // function the vertex shader displaces by — its normal here is
  // the true derivative of the displaced surface. The RIPPLE layer
  // (hi) is per-fragment only: typically tighter spatial scale +
  // lower amplitude, designed to add sub-mesh surface texture that
  // a tessellated plane can't carry through vertex displacement.
  // Combining their tangent-space slopes (xz components of the
  // (-dh/dx, 1, -dh/dz)-style normals) and renormalising gives
  // visually overlaid waves + ripples.
  //
  // The two layers are independently authored (water.waves vs
  // water.ripple) because the right ripple settings vary with the
  // chosen main wave settings — a calm pool wants small ripples
  // even when wave_strength=0, while a stormy ocean's big swells
  // should overpower the ripple noise. The RIPPLE_TIME_OFFSET
  // decorrelates the two layers' phases so the patterns read as
  // independent rather than two copies of one wave.
  let lo = computeWaves(in.world_pos.xz, uniforms.time, strength, scale, speed);
  let RIPPLE_TIME_OFFSET: f32 = 13.7;
  let hi_n = computeRipplesNormal(
    in.world_pos.xz,
    uniforms.time + RIPPLE_TIME_OFFSET,
    water.ripple.x,
    water.ripple.y,
    water.ripple.z,
  );
  let n_world = normalize(vec3f(lo.n.x + hi_n.x, 1.0, lo.n.z + hi_n.z));
  let view_rot = mat3x3f(
    uniforms.modelView[0].xyz,
    uniforms.modelView[1].xyz,
    uniforms.modelView[2].xyz,
  );
  let n = normalize(view_rot * n_world);

  let v = normalize(-in.view_pos);
  let l_world = normalize(uniforms.lightDirWorld);
  let l = normalize(view_rot * l_world);
  let h = normalize(v + l);

  let n_dot_v = max(dot(n, v), 0.0);
  let n_dot_l = max(dot(n, l), 0.0);
  let n_dot_h = max(dot(n, h), 0.0);
  let h_dot_v = max(dot(h, v), 0.0);

  // Geometric specular antialiasing. With the 6-octave ripple
  // normal varying rapidly across pixels and a low authored
  // `roughness` (0.05 for crisp sun glint), the raw GGX lobe is
  // narrow enough that adjacent pixels can land in completely
  // different parts of the highlight — producing single-pixel
  // sparkle "fireflies" that alias as the camera moves. The
  // Tokuyoshi-style fix widens the effective roughness in pixels
  // where the normal varies a lot, using screen-space derivatives
  // as a proxy for sub-pixel normal variance. Result: ripple
  // sparkles read as a continuous bright field instead of flickery
  // dots, while flat regions keep the authored crisp roughness.
  // Clamped to 0.25 so even pathologically noisy regions don't
  // become totally diffuse.
  let n_dx = dpdx(n_world);
  let n_dy = dpdy(n_world);
  let kernel_rough2 = min(2.0 * (dot(n_dx, n_dx) + dot(n_dy, n_dy)), 0.25);
  let eff_roughness = sqrt(roughness * roughness + kernel_rough2);

  // Water F0 is around 0.02 — physically correct, gives the soft
  // ambient reflectance + strong fresnel that water needs.
  let f0 = vec3f(0.02);
  // Microsurface Fresnel (h-based) drives the GGX specular lobe
  // for the sun glint. Macrosurface Fresnel (n_dot_v based) drives
  // the reflection-vs-refraction blend below — that's the correct
  // split because the SSR/environment reflection sees the
  // macroscopic surface, not the per-microfacet half-vector.
  let f_micro = fresnel_schlick(h_dot_v, f0);
  let f_macro = fresnel_schlick(n_dot_v, f0);
  let d = distribution_ggx(n_dot_h, eff_roughness);
  let g = geometry_smith(n_dot_v, n_dot_l, eff_roughness);
  let specular = (d * g * f_micro) / max(4.0 * n_dot_v * n_dot_l, 0.0001);

  let albedo = srgb_to_linear(water.color.rgb * in.tint.rgb);
  let k_d = (vec3f(1.0) - f_micro);
  // Hemisphere ambient — water reflects sky strongly upward.
  let hemi_t = n_world.y * 0.5 + 0.5;
  let ambient_color = mix(uniforms.groundColor, uniforms.skyColor, hemi_t) * uniforms.ambientIntensity;

  let direct = (k_d * albedo / PI + specular) * uniforms.lightColor * n_dot_l;
  let ambient_term = albedo * ambient_color;
  // Screen-space reflection. March the reflection ray through the
  // depth buffer of the opaque scene. Hits sample the refraction
  // colour copy at that pixel (the opaque scene buffer is the
  // refraction texture — same content); misses return the sky
  // colour. SSR replaces the older half-res planar-reflection pass,
  // which had to render the whole scene a second time with a
  // mirrored modelView and was the source of repeated correctness
  // bugs (winding flip, clip-plane, queue.writeBuffer ordering).
  let dims_main = vec2f(textureDimensions(refractionTex, 0));
  let screen_uv = in.position.xy / dims_main;
  let reflection_color = ssr_reflect(in.view_pos, n);
  // Refraction sample. The refraction texture is a copy of hdrColor
  // taken right before water draws (full-res), so it contains the
  // opaque scene underneath the water. Sampling with the wave
  // normal's XZ deflection gives the "scene wobbles through the
  // water" effect that sells the surface as a transparent fluid
  // rather than tinted glass. Stronger offset than reflection
  // because under-water distortion reads as more pronounced.
  let refr_uv = clamp(
    vec2f(screen_uv.x + n_world.x * 0.025, screen_uv.y + n_world.z * 0.025),
    vec2f(0.0),
    vec2f(1.0),
  );
  let refraction_color = textureSample(refractionTex, samp, refr_uv).rgb;
  // Depth-based Beer-Lambert tint. Recover the underwater geometry's
  // view-space z from the depth copy at this fragment's pixel (the
  // copy was snapshotted before water drew, so it never contains
  // water itself). The "water column depth" is the difference along
  // the view ray between the water surface and the geometry behind
  // it. Refraction attenuates per channel as
  //   T_rgb = exp(-depth · absorption · (1 - color_linear))
  // so channels far from `color` decay fastest with depth — a deep
  // body of teal water suppresses red first, then green, leaving
  // blue. At absorption=0 the depth term collapses to T=1 and we
  // fall back to refraction multiplied uniformly by water.color
  // (the pre-step-3 behaviour). The unfiltered point sample uses
  // the fragment's exact pixel (no wave-normal offset for depth;
  // mixing offset and non-offset samples would over-tint the
  // ripple-bent refraction).
  let water_color_lin = srgb_to_linear(water.color.rgb * in.tint.rgb);
  let p10 = uniforms.projection[2].z;
  let p14 = uniforms.projection[3].z;
  let scene_depth_here = textureLoad(sceneDepth, vec2i(in.position.xy), 0).r;
  // water_column = view-ray distance from this water fragment to
  // the underwater geometry behind it. Consumed by BOTH the
  // Beer-Lambert tint just below AND the depth-buffer foam logic
  // later (so anything piercing the water gets a fringe of foam,
  // not just terrain that the heightfield knows about). Zero when
  // there's nothing underwater (sky pixel).
  var water_column: f32 = 0.0;
  if (scene_depth_here > 0.0) {
    let scene_view_z = -p14 / (scene_depth_here + p10);
    // Both view-z are negative; ray travels from water (closer to
    // camera) to scene (farther). depth = how much extra view-ray
    // length is inside water.
    water_column = max(0.0, in.view_pos.z - scene_view_z);
  }
  var refracted_tinted: vec3f;
  if (water_column > 0.0 && water.transport.x > 0.0) {
    let absorption_rgb = vec3f(1.0) - water_color_lin;
    let transmittance = exp(-water_column * water.transport.x * absorption_rgb);
    refracted_tinted = mix(water_color_lin, refraction_color, transmittance);
  } else {
    refracted_tinted = refraction_color * water_color_lin;
  }
  // Reflection weight: fresnel `f` is correct for the physics but
  // it dives to ~0.02 at normal incidence, which makes top-down
  // water look like there's no mirror at all. Lift the floor to
  // ~0.25 so a viewer looking straight down at calm water still
  // sees terrain peaks reflected — same compromise every real-time
  // renderer makes for visual readability.
  // Fresnel-based mix between refraction (looking THROUGH the water
  // at the scene beneath) and reflection (mirrored content from
  // ABOVE the water). At grazing angles fresnel → 1 and water reads
  // as a near-perfect mirror; looking straight down, fresnel → 0
  // and you see almost entirely the refracted scene below. We
  // lift the floor to 0.25 so straight-down water still shows SOME
  // reflection — physically a bit too much but visually readable.
  let reflWeight = mix(0.25, 1.0, f_macro.r);
  let water_surface = mix(refracted_tinted, reflection_color, reflWeight);
  // Specular highlight (sun glint) sits on top of everything —
  // it's the bright streak you see when the sun is roughly opposite
  // the camera across the water plane.
  let specular_term = specular * uniforms.lightColor * n_dot_l;
  var lit = water_surface + specular_term;

  // Foam. Two independent sources, taking the max so each fills
  // gaps in the other:
  //
  //   • HEIGHTFIELD foam (terrain shoreline) — sample terrain Y
  //     at this fragment's world XZ from the bound heightfield;
  //     foam grows as terrain rises toward the water surface.
  //     Gives a believable WORLD-LOCKED shoreline ring that doesn't
  //     drift with camera angle. Requires a heightfield to be
  //     bound; only fires inside the heightfield's UV footprint
  //     (open water beyond the terrain edge gets no foam from
  //     this source).
  //
  //   • DEPTH-BUFFER foam (anything piercing the water) — reuses
  //     `water_column` from Beer-Lambert above. Where the water
  //     column over an underwater object is shallow, fade toward
  //     foam. Works for any opaque geometry the depth pass wrote:
  //     trees standing in water, partially-submerged rocks, the
  //     bottom of a cube touching the surface. NOT world-locked
  //     (it's view-ray length, not vertical depth), so on a flat
  //     terrain shoreline the heightfield source produces the
  //     nicer ring; the two are designed to coexist.
  //
  // Both use the same authored `foam_width` (world units). Foam
  // colour is multiplied by direct sun + ambient so it dims
  // correctly in shadow rather than glowing white.
  if (water.foam.x > 0.0) {
    var foam: f32 = 0.0;
    if (water.foam.y > 0.5) {
      let worldSize = water.world.xy;
      let hMin = water.world.z;
      let hMax = water.world.w;
      let uv = in.world_pos.xz / worldSize + vec2f(0.5);
      let inHeightfield = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
      if (inHeightfield) {
        let terrainH = textureSampleLevel(heightTex, heightSamp, uv, 0.0).r;
        let terrainY = hMin + terrainH * (hMax - hMin);
        let depth = max(in.world_pos.y - terrainY, 0.0);
        foam = max(foam, 1.0 - smoothstep(0.0, water.foam.x, depth));
      }
    }
    if (water_column > 0.0) {
      foam = max(foam, 1.0 - smoothstep(0.0, water.foam.x, water_column));
    }
    if (foam > 0.0) {
      let foam_color = srgb_to_linear(vec3f(0.9, 0.94, 0.96));
      lit = mix(lit, foam_color * (uniforms.lightColor * n_dot_l + ambient_color), foam);
    }
  }

  return vec4f(apply_fog(lit, in.view_pos.z), 1.0);
}
