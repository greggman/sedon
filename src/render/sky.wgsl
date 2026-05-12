// Physical atmospheric sky — single-scattering Rayleigh + Mie. Each
// fragment's view direction is reconstructed from its screen NDC plus
// the camera basis (right/up/forward in world space, passed in via the
// uniform). The view ray is then marched through a spherical-Earth
// atmosphere, and at each sample we accumulate Rayleigh (wavelength-
// dependent → blue sky) and Mie (gray, forward-scattering → sun halo)
// contributions weighted by the transmittance to the sun.
//
// Output is linear HDR. Distant sky is the integrated scattering
// (handles sunset reddening, blue zenith, horizon brightening for free);
// the sun itself is added as a bright disc that naturally exceeds the
// bloom threshold downstream. No screen-space gradient anymore — the
// old sky.top/sky.bottom inputs on core/output are unused; sun angle
// (lighting.direction) is the one knob.
//
// Formulas from Nishita 1993 / Hillaire "Physically-Based Rendering of
// the Atmosphere"; 16 primary samples × 8 light samples gives a smooth
// result at ~few ms/frame on a 2K canvas.

struct Sky {
  // camera-right (world space) in xyz; tan(fov_y / 2) in w
  cameraRight: vec4f,
  // camera-up (world space) in xyz; aspect = width / height in w
  cameraUp: vec4f,
  // camera-forward (world space) in xyz; sun intensity (linear HDR) in w
  cameraForward: vec4f,
  // direction TO the sun (world space), normalized; w unused
  sunDir: vec4f,
  // sRGB fog color in xyz (linearized in shader); w unused. The scene
  // shaders fade distant geometry toward this; blending the sky toward
  // it near the horizon keeps scene and sky converging to the same
  // color, so silhouettes of distant fogged geometry sit naturally
  // against the sky rather than reading as a flat strip.
  fogColor: vec4f,
};

@group(0) @binding(0) var<uniform> sky: Sky;

struct VsOut {
  @builtin(position) position: vec4f,
  // Screen NDC: x,y ∈ [-1, 1]. Sky covers the full fullscreen triangle.
  @location(0) screen_uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  let x = f32((idx << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(idx & 2u) * 2.0 - 1.0;
  var out: VsOut;
  // Far-plane z under reverse-Z so depth test (if any) loses to real
  // geometry. The sky pipeline disables depth anyway.
  out.position = vec4f(x, y, 0.0, 1.0);
  out.screen_uv = vec2f(x, y);
  return out;
}

// Real-world meters. Camera sits 1m above sea level at world origin XZ;
// planet center is at (0, -EARTH_RADIUS, 0). The atmosphere is the
// spherical shell between EARTH_RADIUS and ATMOS_RADIUS.
const EARTH_RADIUS: f32 = 6360000.0;
const ATMOS_RADIUS: f32 = 6420000.0;
const RAYLEIGH_SCALE_HEIGHT: f32 = 8000.0;
const MIE_SCALE_HEIGHT: f32 = 1200.0;
// Rayleigh: blue scatters ~4× more than red, which is why the sky reads
// as blue overhead and warmer at the horizon (longer path eats the blue).
const BETA_R: vec3f = vec3f(5.5e-6, 13.0e-6, 22.4e-6);
// Mie: aerosols, wavelength-independent. Gives the white-ish halo
// around the sun.
const BETA_M: vec3f = vec3f(21e-6);
// Mie phase asymmetry. 0 = isotropic; +1 = pure forward; ~0.76 is the
// classic value that produces a visible (but not pinpoint) sun halo.
const MIE_G: f32 = 0.76;
const PI: f32 = 3.14159265359;
const NUM_SAMPLES: u32 = 16u;
const NUM_LIGHT_SAMPLES: u32 = 8u;

// Far intersection of a ray with a sphere centered at the origin. Used
// twice: once for the primary view ray hitting the atmosphere shell from
// inside, once per primary sample for the sun ray. Returns -1 when the
// ray doesn't intersect (shouldn't happen for view ray, can happen for
// light ray when the sun is below the local horizon).
fn intersect_sphere(orig: vec3f, dir: vec3f, radius: f32) -> f32 {
  let b = dot(orig, dir);
  let c = dot(orig, orig) - radius * radius;
  let d = b * b - c;
  if (d < 0.0) {
    return -1.0;
  }
  return -b + sqrt(d);
}

fn phase_rayleigh(mu: f32) -> f32 {
  return 3.0 / (16.0 * PI) * (1.0 + mu * mu);
}

fn phase_mie(mu: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = pow(1.0 + g2 - 2.0 * g * mu, 1.5);
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) /
         ((2.0 + g2) * max(denom, 1e-6));
}

fn atmosphere(view_dir: vec3f, sun_dir: vec3f, sun_intensity: f32) -> vec3f {
  // Camera sits ~1m above sea-level at world origin XZ. Add the Earth
  // radius so the atmosphere model treats it as on the planet surface.
  let cam_pos = vec3f(0.0, EARTH_RADIUS + 1.0, 0.0);
  let t_atmos = intersect_sphere(cam_pos, view_dir, ATMOS_RADIUS);
  if (t_atmos < 0.0) {
    return vec3f(0.0);
  }
  let segment = t_atmos / f32(NUM_SAMPLES);
  let mu = dot(view_dir, sun_dir);
  let phase_r = phase_rayleigh(mu);
  let phase_m = phase_mie(mu, MIE_G);

  var sum_r = vec3f(0.0);
  var sum_m = vec3f(0.0);
  var opt_r = 0.0; // optical depth along view ray so far
  var opt_m = 0.0;

  for (var i: u32 = 0u; i < NUM_SAMPLES; i = i + 1u) {
    let t = (f32(i) + 0.5) * segment;
    let sample_pos = cam_pos + view_dir * t;
    let height = length(sample_pos) - EARTH_RADIUS;
    if (height < 0.0) {
      // Sample sank below ground (shouldn't happen for sky, but guard).
      break;
    }
    let hr = exp(-height / RAYLEIGH_SCALE_HEIGHT) * segment;
    let hm = exp(-height / MIE_SCALE_HEIGHT) * segment;
    opt_r = opt_r + hr;
    opt_m = opt_m + hm;

    // Optical depth from sample point toward the sun. If the ray
    // intersects the planet (sun below the local horizon), that
    // sample receives no direct light — skip its contribution.
    let t_light = intersect_sphere(sample_pos, sun_dir, ATMOS_RADIUS);
    let light_seg = t_light / f32(NUM_LIGHT_SAMPLES);
    var opt_lr = 0.0;
    var opt_lm = 0.0;
    var blocked = false;
    for (var j: u32 = 0u; j < NUM_LIGHT_SAMPLES; j = j + 1u) {
      let lt = (f32(j) + 0.5) * light_seg;
      let light_pos = sample_pos + sun_dir * lt;
      let lh = length(light_pos) - EARTH_RADIUS;
      if (lh < 0.0) {
        blocked = true;
        break;
      }
      opt_lr = opt_lr + exp(-lh / RAYLEIGH_SCALE_HEIGHT) * light_seg;
      opt_lm = opt_lm + exp(-lh / MIE_SCALE_HEIGHT) * light_seg;
    }
    if (!blocked) {
      // 1.1× factor on Mie absorption (classic Nishita tweak that makes
      // the sun halo a touch more visible).
      let tau = BETA_R * (opt_r + opt_lr) + BETA_M * 1.1 * (opt_m + opt_lm);
      let attenuation = exp(-tau);
      sum_r = sum_r + attenuation * hr;
      sum_m = sum_m + attenuation * hm;
    }
  }

  return sun_intensity * (sum_r * BETA_R * phase_r + sum_m * BETA_M * phase_m);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Reconstruct world-space view direction. screen_uv is NDC [-1, 1];
  // the view frustum at NDC x = ±1 spans ±aspect * tan(fovY/2) along
  // camera-right, and at NDC y = ±1 spans ±tan(fovY/2) along camera-up.
  let tan_half_fov = sky.cameraRight.w;
  let aspect = sky.cameraUp.w;
  let view_dir = normalize(
    sky.cameraForward.xyz +
    sky.cameraRight.xyz * (in.screen_uv.x * tan_half_fov * aspect) +
    sky.cameraUp.xyz * (in.screen_uv.y * tan_half_fov)
  );
  let sun_dir = sky.sunDir.xyz;
  let sun_intensity = sky.cameraForward.w;

  // Atmospheric scattering (Rayleigh + Mie). Returns linear HDR.
  //
  // For view rays below the horizon (y < 0) the ray-march hits the
  // ground almost immediately and accumulates ~nothing, producing
  // black — which reads as a hole when finite scene geometry doesn't
  // cover the full lower hemisphere. We CLAMP the view-Y to 0 so the
  // whole below-horizon area samples the horizon color (smooth match
  // across the horizon line), then fade toward a dim neutral ground
  // color further down.
  //
  // Mirroring (sample at abs(y)) was tried first but produces a
  // visible "ghost sun halo" below the horizon at the sun's reflected
  // position — the Mie phase peaks at mu≈1, which the mirror lines
  // up artificially. Clamp + fade has no such artifact.
  let raw_sample = vec3f(view_dir.x, max(view_dir.y, 0.0), view_dir.z);
  // Straight-down view yields a zero-length vector that can't be
  // normalized; substitute an arbitrary horizontal direction. The
  // `below` mix fully replaces the result with fog color there
  // anyway, so the azimuth choice is invisible.
  let sample_dir = select(
    vec3f(1.0, 0.0, 0.0),
    normalize(raw_sample),
    dot(raw_sample, raw_sample) > 1e-6,
  );
  var color = atmosphere(sample_dir, sun_dir, sun_intensity);

  // Blend the atmospheric color toward the linear-space fog color near
  // the horizon. Scene geometry (in pbr.wgsl / terrain-splat.wgsl) fades
  // to this same fog color over distance, so distant trees + distant
  // sky now meet at the same color at the horizon line instead of
  // creating a visible color seam. Blend weight decays with view-Y so
  // the zenith stays atmosphere-dominant.
  let fog_linear = pow(sky.fogColor.xyz, vec3f(2.2));
  let above_y = max(view_dir.y, 0.0);
  let horizon_weight = exp(-above_y * 6.0) * 0.85;
  color = mix(color, fog_linear, horizon_weight);

  // Below the horizon: smoothly land on the fog color (no atmospheric
  // ghost-halo from mirroring, no flat dark void). The first ~5°
  // smoothstep matches the scene's fog tone so the boundary disappears.
  let below = smoothstep(0.0, -0.08, view_dir.y);
  color = mix(color, fog_linear, below);

  // Twilight → night transition based on sun elevation. The atmosphere
  // model returns ~0 once the sun is below the horizon (every sample's
  // light ray hits the planet) — without this fade we'd be left with
  // the fog color or worse, so "sun below the floor" reads as foggy
  // void rather than night. The scene-side lighting + ambient are
  // also dimmed in scene.ts, so the whole environment darkens together.
  let night_factor = smoothstep(0.0, -0.2, sun_dir.y);
  let night_sky = vec3f(0.003, 0.006, 0.015); // dim navy
  color = mix(color, night_sky, night_factor);

  // Sun disc — only when the sun is above the horizon. Faded as it
  // crosses so the disc doesn't pop out as it sets. The HDR value
  // (20× sun_intensity) is well above bloom's threshold, so the bloom
  // pass adds the surrounding glow that reads as "the sun" rather
  // than "a white dot."
  let sun_visible = smoothstep(-0.02, 0.02, sun_dir.y);
  let mu = dot(view_dir, sun_dir);
  let sun_inner = cos(0.005);  // ~0.29°
  let sun_outer = cos(0.012);  // ~0.69°
  let alpha = smoothstep(sun_outer, sun_inner, mu) * sun_visible;
  if (alpha > 0.0) {
    color = color + alpha * vec3f(sun_intensity * 20.0);
  }

  return vec4f(color, 1.0);
}
