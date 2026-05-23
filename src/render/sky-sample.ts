// CPU port of sky.wgsl's atmosphere() — Nishita single-scattering through
// a spherical Earth. Used by core/output to derive hemisphere ambient
// (skyColor, groundColor) and the sun's atmospheric tint, so the scene
// lighting stays locked to the same sun-position knob as the rendered sky.
//
// Formulas mirror sky.wgsl exactly so the derived ambient matches the
// pixels the user sees overhead. Returns LINEAR HDR — no sRGB conversion.

type V3 = [number, number, number];

/**
 * Atmospheric scattering uses an arbitrary intensity scalar — `sky.wgsl`
 * passes 22 (set in scene.ts) for the rendered sky. Sampling the same
 * function at the SAME intensity for the hemisphere ambient is what
 * keeps the derived ambient brightness in lockstep with the sky pixels
 * the user actually sees. The user's `light_intensity` input on
 * core/output controls direct sun brightness only — it does NOT scale
 * the integrated sky here.
 */
export const ATMOSPHERIC_SUN_INTENSITY = 22;

const EARTH_RADIUS = 6360000;
const ATMOS_RADIUS = 6420000;
const RAYLEIGH_SCALE_HEIGHT = 8000;
const MIE_SCALE_HEIGHT = 1200;
const BETA_R: V3 = [5.5e-6, 13.0e-6, 22.4e-6];
const BETA_M_SCALAR = 21e-6;
const MIE_G = 0.76;
const NUM_SAMPLES = 16;
const NUM_LIGHT_SAMPLES = 8;
const PI = Math.PI;

// Far intersection of a ray with a sphere at the origin. Negative means
// no hit (used for light rays grazing the planet — sun below horizon).
function intersectSphere(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, radius: number): number {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const d = b * b - c;
  if (d < 0) return -1;
  return -b + Math.sqrt(d);
}

function phaseRayleigh(mu: number): number {
  return (3 / (16 * PI)) * (1 + mu * mu);
}

function phaseMie(mu: number, g: number): number {
  const g2 = g * g;
  const denom = Math.pow(1 + g2 - 2 * g * mu, 1.5);
  return ((3 / (8 * PI)) * ((1 - g2) * (1 + mu * mu))) / ((2 + g2) * Math.max(denom, 1e-6));
}

function normalize3(x: number, y: number, z: number): V3 {
  const len = Math.hypot(x, y, z);
  if (len < 1e-12) return [0, 1, 0];
  return [x / len, y / len, z / len];
}

/**
 * Linear HDR radiance for a view ray, identical to sky.wgsl's atmosphere().
 * `viewDir` and `sunDir` must be unit-length. `sunIntensity` matches the
 * shader's sky.cameraForward.w (the same intensity the sky renderer uses).
 */
export function sampleSky(viewDir: V3, sunDir: V3, sunIntensity: number): V3 {
  const cy = EARTH_RADIUS + 1;
  const tAtmos = intersectSphere(0, cy, 0, viewDir[0], viewDir[1], viewDir[2], ATMOS_RADIUS);
  if (tAtmos < 0) return [0, 0, 0];

  const segment = tAtmos / NUM_SAMPLES;
  const mu = viewDir[0] * sunDir[0] + viewDir[1] * sunDir[1] + viewDir[2] * sunDir[2];
  const phaseR = phaseRayleigh(mu);
  const phaseM = phaseMie(mu, MIE_G);

  let sumR0 = 0, sumR1 = 0, sumR2 = 0;
  let sumM0 = 0, sumM1 = 0, sumM2 = 0;
  let optR = 0, optM = 0;

  for (let i = 0; i < NUM_SAMPLES; i++) {
    const t = (i + 0.5) * segment;
    const px = viewDir[0] * t;
    const py = cy + viewDir[1] * t;
    const pz = viewDir[2] * t;
    const h = Math.hypot(px, py, pz) - EARTH_RADIUS;
    if (h < 0) break;

    const hr = Math.exp(-h / RAYLEIGH_SCALE_HEIGHT) * segment;
    const hm = Math.exp(-h / MIE_SCALE_HEIGHT) * segment;
    optR += hr;
    optM += hm;

    const tLight = intersectSphere(px, py, pz, sunDir[0], sunDir[1], sunDir[2], ATMOS_RADIUS);
    const lightSeg = tLight / NUM_LIGHT_SAMPLES;
    let optLR = 0, optLM = 0;
    let blocked = false;
    for (let j = 0; j < NUM_LIGHT_SAMPLES; j++) {
      const lt = (j + 0.5) * lightSeg;
      const lx = px + sunDir[0] * lt;
      const ly = py + sunDir[1] * lt;
      const lz = pz + sunDir[2] * lt;
      const lh = Math.hypot(lx, ly, lz) - EARTH_RADIUS;
      if (lh < 0) { blocked = true; break; }
      optLR += Math.exp(-lh / RAYLEIGH_SCALE_HEIGHT) * lightSeg;
      optLM += Math.exp(-lh / MIE_SCALE_HEIGHT) * lightSeg;
    }
    if (!blocked) {
      // 1.1× Mie absorption matches the shader's Nishita tweak.
      const tauR0 = BETA_R[0] * (optR + optLR);
      const tauR1 = BETA_R[1] * (optR + optLR);
      const tauR2 = BETA_R[2] * (optR + optLR);
      const tauM = BETA_M_SCALAR * 1.1 * (optM + optLM);
      const a0 = Math.exp(-(tauR0 + tauM));
      const a1 = Math.exp(-(tauR1 + tauM));
      const a2 = Math.exp(-(tauR2 + tauM));
      sumR0 += a0 * hr; sumR1 += a1 * hr; sumR2 += a2 * hr;
      sumM0 += a0 * hm; sumM1 += a1 * hm; sumM2 += a2 * hm;
    }
  }

  return [
    sunIntensity * (sumR0 * BETA_R[0] * phaseR + sumM0 * BETA_M_SCALAR * phaseM),
    sunIntensity * (sumR1 * BETA_R[1] * phaseR + sumM1 * BETA_M_SCALAR * phaseM),
    sunIntensity * (sumR2 * BETA_R[2] * phaseR + sumM2 * BETA_M_SCALAR * phaseM),
  ];
}

/**
 * RGB transmittance of the atmosphere along the sun ray FROM the camera,
 * i.e. the fraction of pure-white sunlight that reaches a surface at sea
 * level. Returns ~[0.95,0.90,0.84] at zenith (slightly yellow), strongly
 * red at sunset, and [0,0,0] when the sun is below the horizon (rejected
 * by the sphere intersection — matches the sky shader's "blocked" branch).
 */
export function sunTransmittance(sunDir: V3): V3 {
  const sn = normalize3(sunDir[0], sunDir[1], sunDir[2]);
  const cy = EARTH_RADIUS + 1;
  const t = intersectSphere(0, cy, 0, sn[0], sn[1], sn[2], ATMOS_RADIUS);
  if (t < 0) return [0, 0, 0];
  const seg = t / NUM_LIGHT_SAMPLES;
  let optR = 0, optM = 0;
  for (let j = 0; j < NUM_LIGHT_SAMPLES; j++) {
    const lt = (j + 0.5) * seg;
    const lx = sn[0] * lt;
    const ly = cy + sn[1] * lt;
    const lz = sn[2] * lt;
    const lh = Math.hypot(lx, ly, lz) - EARTH_RADIUS;
    if (lh < 0) return [0, 0, 0];
    optR += Math.exp(-lh / RAYLEIGH_SCALE_HEIGHT) * seg;
    optM += Math.exp(-lh / MIE_SCALE_HEIGHT) * seg;
  }
  const tauM = BETA_M_SCALAR * 1.1 * optM;
  return [
    Math.exp(-(BETA_R[0] * optR + tauM)),
    Math.exp(-(BETA_R[1] * optR + tauM)),
    Math.exp(-(BETA_R[2] * optR + tauM)),
  ];
}

/**
 * Derive hemisphere ambient + sun colour from a sun direction. All values
 * are LINEAR HDR.
 *
 *   skyColor    — atmospheric radiance at the zenith. Surfaces facing UP
 *                 read this colour through the hemisphere blend. Sampled
 *                 at ATMOSPHERIC_SUN_INTENSITY so it matches the visible
 *                 sky pixels rather than tracking the user's
 *                 light_intensity (which controls only direct sun).
 *   groundColor — atmospheric radiance just above the horizon, multiplied
 *                 by `terrainTintLinear` × `bounceFactor`. This stands in
 *                 for sky light that hit the ground and bounced back up;
 *                 surfaces facing DOWN read it.
 *   sunColor    — direct sunlight reaching the scene, equal to
 *                 `sunLinearHDR` × atmospheric transmittance along the sun
 *                 ray (so sunsets warm automatically).
 *
 * `sunLinearHDR` is the FINAL linear-HDR sun colour BEFORE transmittance —
 * usually `srgb_to_linear(light_color × intensity)`. Multiplying intensity
 * into the colour BEFORE the sRGB→linear transfer matches the old shader's
 * `srgb_to_linear(uniforms.lightColor)` behaviour, so existing graphs
 * authored against intensity=3 stay at the brightness they were tuned at.
 */
export function deriveLighting(
  lightDirInput: V3,
  sunLinearHDR: V3,
  terrainTintLinear: V3,
  bounceFactor: number,
): { sky: V3; ground: V3; sun: V3; sunDir: V3 } {
  const sd = normalize3(lightDirInput[0], lightDirInput[1], lightDirInput[2]);
  const zenith: V3 = [0, 1, 0];
  // Just above the horizon — where the bulk of sky irradiance lives and
  // where atmosphere reddening shows up most strongly at sunset, so the
  // bounce-light tone tracks the visible horizon colour.
  const horizon: V3 = normalize3(sd[0], 0.1, sd[2]);
  const sky = sampleSky(zenith, sd, ATMOSPHERIC_SUN_INTENSITY);
  const horizonRad = sampleSky(horizon, sd, ATMOSPHERIC_SUN_INTENSITY);
  const ground: V3 = [
    horizonRad[0] * terrainTintLinear[0] * bounceFactor,
    horizonRad[1] * terrainTintLinear[1] * bounceFactor,
    horizonRad[2] * terrainTintLinear[2] * bounceFactor,
  ];
  const tr = sunTransmittance(sd);
  const sun: V3 = [
    sunLinearHDR[0] * tr[0],
    sunLinearHDR[1] * tr[1],
    sunLinearHDR[2] * tr[2],
  ];
  return { sky, ground, sun, sunDir: sd };
}

// Approximate sRGB → linear used by the shader (gamma 2.2). Exposed so
// `output.ts` can linearize user-authored colours before feeding them
// into deriveLighting (the resulting LightingValue is all linear).
export function srgbToLinear(c: V3): V3 {
  return [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)];
}
