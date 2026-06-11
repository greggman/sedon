import type { CpuMesh } from './mesh.js';

// Cone with base at y=0, apex at y=height. Same base-anchored convention as
// the cylinder so it sits naturally on instance points.
//
// Side normals: a cone's slant is a straight line, so the surface normal is
// constant along each slant — perpendicular to the slant in the radial-
// vertical plane. Derivation gives n = (h·cosθ, R, h·sinθ) / √(h²+R²) at
// every point on the slant for azimuth θ. So bottom-ring vertex and top-ring
// (apex) vertex at the same θ share the same normal, and adjacent segments
// share normals at the seam — fragment-shader interpolation reads as a
// smoothly-shaded cone.
//
// Top "ring" is segs+1 vertices all coincident at (0, height, 0) but each
// carrying its azimuth's slant normal. Per-segment top vertices give a sharp
// apex without facet artifacts mid-slant.

/**
 * Generate a (partial-range) cone mesh.
 *
 * Defaults reproduce a closed full cone with a bottom cap. Restricting
 * the angle range carves out a wedge from the apex; with `cap: true`
 * (the default) the bottom cap becomes a pie slice and two radial
 * triangle walls fill from apex down to the bottom-edge endpoints.
 * `cap: false` drops every cap.
 */
export interface GenerateConeOpts {
  radius: number;
  height: number;
  segments: number;
  angleStart?: number;
  angleEnd?: number;
  cap?: boolean;
}

export function generateCone(opts: GenerateConeOpts): CpuMesh {
  const radius = opts.radius;
  const height = opts.height;
  const segs = Math.max(3, Math.floor(opts.segments));
  const angleStart = opts.angleStart ?? 0;
  const angleEnd = opts.angleEnd ?? 2 * Math.PI;
  const cap = opts.cap ?? true;
  const angleSpan = angleEnd - angleStart;
  const isFullCircle = angleSpan >= 2 * Math.PI - 1e-9;
  const needRadialWalls = cap && !isFullCircle;

  const sideRingV = segs + 1;
  const sideV = 2 * sideRingV;
  const bottomCapBase = sideV;
  const bottomCapV = cap ? 1 + sideRingV : 0;
  const radialCapBase = bottomCapBase + bottomCapV;
  // Two radial walls × 3 vertices each (apex + two base corners).
  const radialCapV = needRadialWalls ? 6 : 0;
  const totalV = radialCapBase + radialCapV;

  const totalI =
    segs * 6
    + (cap ? segs * 3 : 0)
    + (needRadialWalls ? 3 * 2 : 0);

  const positions = new Float32Array(totalV * 3);
  const normals = new Float32Array(totalV * 3);
  const uvs = new Float32Array(totalV * 2);
  const indices = new Uint32Array(totalI);

  // Slant normal scaling. n_unscaled = (h·cosθ, R, h·sinθ); |.| = √(h²+R²).
  const slantInv = 1 / Math.hypot(height, radius);
  const nY = radius * slantInv;
  const twoPI = 2 * Math.PI;

  for (let r = 0; r < 2; r++) {
    const y = r * height;
    const isApex = r === 1;
    for (let s = 0; s <= segs; s++) {
      const rawTheta = angleStart + (angleSpan * s) / segs;
      // mod twoPI only for the full-circle seam so compute-normals
      // handles the wrap correctly; a partial wedge keeps endpoint
      // theta distinct.
      const theta = isFullCircle ? rawTheta % twoPI : rawTheta;
      const cx = Math.cos(theta);
      const cz = Math.sin(theta);
      const i = r * sideRingV + s;
      positions[i * 3]     = isApex ? 0 : cx * radius;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = isApex ? 0 : cz * radius;
      normals[i * 3]     = cx * height * slantInv;
      normals[i * 3 + 1] = nY;
      normals[i * 3 + 2] = cz * height * slantInv;
      uvs[i * 2]     = s / segs;
      uvs[i * 2 + 1] = r;
    }
  }

  let idx = 0;
  for (let s = 0; s < segs; s++) {
    const a = s;
    const b = s + 1;
    const c = sideRingV + s;
    const d = sideRingV + s + 1;
    // Same CCW-from-outside winding as cylinder side.
    indices[idx++] = a;
    indices[idx++] = d;
    indices[idx++] = b;
    indices[idx++] = a;
    indices[idx++] = c;
    indices[idx++] = d;
  }

  if (cap) {
    // Bottom cap: center + rim, all with -Y normal. Wound CCW when viewed
    // from -Y. Becomes a pie slice if the angle range is partial.
    positions[bottomCapBase * 3]     = 0;
    positions[bottomCapBase * 3 + 1] = 0;
    positions[bottomCapBase * 3 + 2] = 0;
    normals[bottomCapBase * 3]     = 0;
    normals[bottomCapBase * 3 + 1] = -1;
    normals[bottomCapBase * 3 + 2] = 0;
    uvs[bottomCapBase * 2]     = 0.5;
    uvs[bottomCapBase * 2 + 1] = 0.5;
    for (let s = 0; s <= segs; s++) {
      const rawTheta = angleStart + (angleSpan * s) / segs;
      const theta = isFullCircle ? rawTheta % twoPI : rawTheta;
      const cx = Math.cos(theta);
      const cz = Math.sin(theta);
      const i = bottomCapBase + 1 + s;
      positions[i * 3]     = cx * radius;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = cz * radius;
      normals[i * 3]     = 0;
      normals[i * 3 + 1] = -1;
      normals[i * 3 + 2] = 0;
      uvs[i * 2]     = 0.5 + cx * 0.5;
      uvs[i * 2 + 1] = 0.5 - cz * 0.5;
    }
    for (let s = 0; s < segs; s++) {
      indices[idx++] = bottomCapBase;
      indices[idx++] = bottomCapBase + 1 + s;
      indices[idx++] = bottomCapBase + 1 + s + 1;
    }
  }

  if (needRadialWalls) {
    // Two flat triangle walls fill the wedge's open radial sides.
    // Each is the triangle (apex, base-centre, base-edge) where the
    // base edge is at angle_start or angle_end. The apex and the
    // base centre are coincident on the Y axis, and the base edge
    // sits on the cone rim.
    const cs = Math.cos(angleStart);
    const ss = Math.sin(angleStart);
    const ce = Math.cos(angleEnd);
    const se = Math.sin(angleEnd);

    // Start wall normal: outward from the wedge interior. Tangent
    // along the wall in the XZ plane is (cs, 0, ss); rotate 90°
    // clockwise around Y → outward normal (ss, 0, -cs).
    const startBase = radialCapBase;
    positions[startBase * 3]     = 0;
    positions[startBase * 3 + 1] = height;
    positions[startBase * 3 + 2] = 0;
    positions[(startBase + 1) * 3]     = 0;
    positions[(startBase + 1) * 3 + 1] = 0;
    positions[(startBase + 1) * 3 + 2] = 0;
    positions[(startBase + 2) * 3]     = cs * radius;
    positions[(startBase + 2) * 3 + 1] = 0;
    positions[(startBase + 2) * 3 + 2] = ss * radius;
    for (let k = 0; k < 3; k++) {
      normals[(startBase + k) * 3]     = ss;
      normals[(startBase + k) * 3 + 1] = 0;
      normals[(startBase + k) * 3 + 2] = -cs;
    }
    uvs[startBase * 2]     = 0.5; uvs[startBase * 2 + 1] = 1;
    uvs[(startBase + 1) * 2]     = 0; uvs[(startBase + 1) * 2 + 1] = 0;
    uvs[(startBase + 2) * 2]     = 1; uvs[(startBase + 2) * 2 + 1] = 0;
    // Wound so the face normal matches the declared (ss, 0, -cs).
    // Cross-product check: (v2-v0) × (v1-v0) = h·r·(ss, 0, -cs) ✓.
    indices[idx++] = startBase;
    indices[idx++] = startBase + 2;
    indices[idx++] = startBase + 1;

    // End wall: tangent (ce, 0, se), rotated 90° counter-clockwise →
    // outward normal (-se, 0, ce).
    const endBase = radialCapBase + 3;
    positions[endBase * 3]     = 0;
    positions[endBase * 3 + 1] = height;
    positions[endBase * 3 + 2] = 0;
    positions[(endBase + 1) * 3]     = 0;
    positions[(endBase + 1) * 3 + 1] = 0;
    positions[(endBase + 1) * 3 + 2] = 0;
    positions[(endBase + 2) * 3]     = ce * radius;
    positions[(endBase + 2) * 3 + 1] = 0;
    positions[(endBase + 2) * 3 + 2] = se * radius;
    for (let k = 0; k < 3; k++) {
      normals[(endBase + k) * 3]     = -se;
      normals[(endBase + k) * 3 + 1] = 0;
      normals[(endBase + k) * 3 + 2] = ce;
    }
    uvs[endBase * 2]     = 0.5; uvs[endBase * 2 + 1] = 1;
    uvs[(endBase + 1) * 2]     = 0; uvs[(endBase + 1) * 2 + 1] = 0;
    uvs[(endBase + 2) * 2]     = 1; uvs[(endBase + 2) * 2 + 1] = 0;
    // Wound so the face normal matches the declared (-se, 0, ce).
    indices[idx++] = endBase;
    indices[idx++] = endBase + 1;
    indices[idx++] = endBase + 2;
  }

  return { positions, normals, uvs, indices };
}
