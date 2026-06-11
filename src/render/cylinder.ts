import type { CpuMesh } from './mesh.js';

// Cylinder with base at y=0 and top at y=height (the asymmetric "grows
// upward from origin" convention rather than centered). For trees, towers,
// and columns the base-anchored origin saves a Transform node downstream.
//
// Side vertices duplicate the seam (segments+1 per ring) so cylindrical UV
// wrap works without a degenerate triangle. Caps use distinct vertices with
// +Y / -Y normals so the corner between side and cap stays sharp regardless
// of how the side is shaded.

/**
 * Generate a (partial-range) cylinder mesh.
 *
 * Defaults reproduce a closed full cylinder with top + bottom caps.
 * Restricting the angle range carves out a wedge; with `cap: true`
 * the top + bottom partial discs (pie slices) close as before AND
 * the two flat radial walls of the wedge are added so the wedge
 * reads as a solid pie slice. `cap: false` drops every cap — useful
 * for tube / shell geometry.
 */
export interface GenerateCylinderOpts {
  radius: number;
  height: number;
  /** Radial subdivisions across the windowed angle range. */
  segments: number;
  /** Start of the angle window, radians. Default 0. */
  angleStart?: number;
  /** End of the angle window, radians. Default 2π (full circle). */
  angleEnd?: number;
  /**
   * Close every open boundary with a flat cap: top + bottom discs
   * always (which become pie slices when the angle range is partial),
   * plus two radial walls at the angle-window edges when partial.
   * Defaults to true.
   */
  cap?: boolean;
}

export function generateCylinder(opts: GenerateCylinderOpts): CpuMesh {
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
  const topCapBase = sideV;
  const topCapV = cap ? 1 + sideRingV : 0;
  const bottomCapBase = topCapBase + topCapV;
  const bottomCapV = cap ? 1 + sideRingV : 0;
  const radialCapBase = bottomCapBase + bottomCapV;
  // Two radial walls × 4 vertices each (corners of a rectangle).
  const radialCapV = needRadialWalls ? 8 : 0;
  const totalV = radialCapBase + radialCapV;

  const totalI =
    segs * 6
    + (cap ? segs * 3 * 2 : 0)
    + (needRadialWalls ? 6 * 2 : 0);

  const positions = new Float32Array(totalV * 3);
  const normals = new Float32Array(totalV * 3);
  const uvs = new Float32Array(totalV * 2);
  const indices = new Uint32Array(totalI);

  const twoPI = 2 * Math.PI;
  // Side: bottom ring (r=0) at y=0, top ring (r=1) at y=height. Normals are
  // radial. UV.v runs 0..1 from bottom to top.
  for (let r = 0; r < 2; r++) {
    const y = r * height;
    for (let s = 0; s <= segs; s++) {
      const rawTheta = angleStart + (angleSpan * s) / segs;
      // mod twoPI is needed to avoid seams in compute-normals at full
      // circumference; for a partial wedge the endpoints are distinct
      // so we leave them un-wrapped.
      const theta = isFullCircle ? rawTheta % twoPI : rawTheta;
      const cx = Math.cos(theta);
      const cz = Math.sin(theta);
      const i = r * sideRingV + s;
      positions[i * 3]     = cx * radius;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = cz * radius;
      normals[i * 3]     = cx;
      normals[i * 3 + 1] = 0;
      normals[i * 3 + 2] = cz;
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
    // CCW from outside the cylinder.
    indices[idx++] = a;
    indices[idx++] = d;
    indices[idx++] = b;
    indices[idx++] = a;
    indices[idx++] = c;
    indices[idx++] = d;
  }

  if (cap) {
    // Top cap: center + rim, all with +Y normal. Disc-style UV from rim to
    // center. Fan triangles wind CCW when viewed from +Y. With the angle
    // range partial, this becomes a pie slice; the same fan winding works
    // because we use the raw theta on each rim vertex.
    positions[topCapBase * 3]     = 0;
    positions[topCapBase * 3 + 1] = height;
    positions[topCapBase * 3 + 2] = 0;
    normals[topCapBase * 3]     = 0;
    normals[topCapBase * 3 + 1] = 1;
    normals[topCapBase * 3 + 2] = 0;
    uvs[topCapBase * 2]     = 0.5;
    uvs[topCapBase * 2 + 1] = 0.5;
    for (let s = 0; s <= segs; s++) {
      const rawTheta = angleStart + (angleSpan * s) / segs;
      const theta = isFullCircle ? rawTheta % twoPI : rawTheta;
      const cx = Math.cos(theta);
      const cz = Math.sin(theta);
      const i = topCapBase + 1 + s;
      positions[i * 3]     = cx * radius;
      positions[i * 3 + 1] = height;
      positions[i * 3 + 2] = cz * radius;
      normals[i * 3]     = 0;
      normals[i * 3 + 1] = 1;
      normals[i * 3 + 2] = 0;
      uvs[i * 2]     = 0.5 + cx * 0.5;
      uvs[i * 2 + 1] = 0.5 + cz * 0.5;
    }
    for (let s = 0; s < segs; s++) {
      indices[idx++] = topCapBase;
      indices[idx++] = topCapBase + 1 + s + 1;
      indices[idx++] = topCapBase + 1 + s;
    }

    // Bottom cap: center + rim, all with -Y normal. Fan winding is reversed.
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
    // Two flat rectangular walls at the angle-window edges. Each is
    // defined by 4 corners: (0,0,0), (rim_at_start,0,?), (rim,height,?),
    // (0,height,0). Wound so the outward face points OUT of the wedge
    // body. The normal is perpendicular to the wedge edge in the XZ
    // plane.
    const cs = Math.cos(angleStart);
    const ss = Math.sin(angleStart);
    const ce = Math.cos(angleEnd);
    const se = Math.sin(angleEnd);
    // Start wall normal: points opposite to the wedge interior. For a
    // wedge starting at angleStart, the interior is on the +angle side,
    // so the outward face faces toward decreasing angle. Tangent along
    // wall is (cs, 0, ss); rotate 90° clockwise around Y to get the
    // outward normal: (ss, 0, -cs).
    const startBase = radialCapBase;
    positions[startBase * 3]     = 0;
    positions[startBase * 3 + 1] = 0;
    positions[startBase * 3 + 2] = 0;
    positions[(startBase + 1) * 3]     = cs * radius;
    positions[(startBase + 1) * 3 + 1] = 0;
    positions[(startBase + 1) * 3 + 2] = ss * radius;
    positions[(startBase + 2) * 3]     = cs * radius;
    positions[(startBase + 2) * 3 + 1] = height;
    positions[(startBase + 2) * 3 + 2] = ss * radius;
    positions[(startBase + 3) * 3]     = 0;
    positions[(startBase + 3) * 3 + 1] = height;
    positions[(startBase + 3) * 3 + 2] = 0;
    for (let k = 0; k < 4; k++) {
      normals[(startBase + k) * 3]     = ss;
      normals[(startBase + k) * 3 + 1] = 0;
      normals[(startBase + k) * 3 + 2] = -cs;
    }
    uvs[startBase * 2]     = 0; uvs[startBase * 2 + 1] = 0;
    uvs[(startBase + 1) * 2]     = 1; uvs[(startBase + 1) * 2 + 1] = 0;
    uvs[(startBase + 2) * 2]     = 1; uvs[(startBase + 2) * 2 + 1] = 1;
    uvs[(startBase + 3) * 2]     = 0; uvs[(startBase + 3) * 2 + 1] = 1;
    // Two triangles, wound so the face normal matches the declared
    // outward normal (ss, 0, -cs). Cross-product check:
    // (v2-v0) × (v1-v0) = h·r·(ss, 0, -cs) ✓.
    indices[idx++] = startBase;
    indices[idx++] = startBase + 2;
    indices[idx++] = startBase + 1;
    indices[idx++] = startBase;
    indices[idx++] = startBase + 3;
    indices[idx++] = startBase + 2;

    // End wall — outward normal flipped relative to start wall: tangent
    // is (ce, 0, se), rotated 90° COUNTER-clockwise around Y →
    // (-se, 0, ce).
    const endBase = radialCapBase + 4;
    positions[endBase * 3]     = 0;
    positions[endBase * 3 + 1] = 0;
    positions[endBase * 3 + 2] = 0;
    positions[(endBase + 1) * 3]     = ce * radius;
    positions[(endBase + 1) * 3 + 1] = 0;
    positions[(endBase + 1) * 3 + 2] = se * radius;
    positions[(endBase + 2) * 3]     = ce * radius;
    positions[(endBase + 2) * 3 + 1] = height;
    positions[(endBase + 2) * 3 + 2] = se * radius;
    positions[(endBase + 3) * 3]     = 0;
    positions[(endBase + 3) * 3 + 1] = height;
    positions[(endBase + 3) * 3 + 2] = 0;
    for (let k = 0; k < 4; k++) {
      normals[(endBase + k) * 3]     = -se;
      normals[(endBase + k) * 3 + 1] = 0;
      normals[(endBase + k) * 3 + 2] = ce;
    }
    uvs[endBase * 2]     = 0; uvs[endBase * 2 + 1] = 0;
    uvs[(endBase + 1) * 2]     = 1; uvs[(endBase + 1) * 2 + 1] = 0;
    uvs[(endBase + 2) * 2]     = 1; uvs[(endBase + 2) * 2 + 1] = 1;
    uvs[(endBase + 3) * 2]     = 0; uvs[(endBase + 3) * 2 + 1] = 1;
    // Wound so the face normal matches the declared (-se, 0, ce).
    indices[idx++] = endBase;
    indices[idx++] = endBase + 1;
    indices[idx++] = endBase + 2;
    indices[idx++] = endBase;
    indices[idx++] = endBase + 2;
    indices[idx++] = endBase + 3;
  }

  return { positions, normals, uvs, indices };
}
