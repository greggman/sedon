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
export function generateCone(radius: number, height: number, segments: number): CpuMesh {
  const segs = Math.max(3, Math.floor(segments));

  const sideRingV = segs + 1;
  const sideV = 2 * sideRingV;
  const bottomCapBase = sideV;
  const bottomCapV = 1 + segs;
  const totalV = bottomCapBase + bottomCapV;

  const totalI = segs * 6 /* sides */ + segs * 3 /* bottom cap */;

  const positions = new Float32Array(totalV * 3);
  const normals = new Float32Array(totalV * 3);
  const uvs = new Float32Array(totalV * 2);
  const indices = new Uint32Array(totalI);

  // Slant normal scaling. n_unscaled = (h·cosθ, R, h·sinθ); |.| = √(h²+R²).
  const slantInv = 1 / Math.hypot(height, radius);
  const nY = radius * slantInv;

  for (let r = 0; r < 2; r++) {
    const y = r * height;
    const isApex = r === 1;
    for (let s = 0; s <= segs; s++) {
      const theta = (2 * Math.PI * s) / segs;
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

  // Bottom cap: center + rim, all with -Y normal. Wound CCW when viewed
  // from -Y (from below).
  positions[bottomCapBase * 3]     = 0;
  positions[bottomCapBase * 3 + 1] = 0;
  positions[bottomCapBase * 3 + 2] = 0;
  normals[bottomCapBase * 3]     = 0;
  normals[bottomCapBase * 3 + 1] = -1;
  normals[bottomCapBase * 3 + 2] = 0;
  uvs[bottomCapBase * 2]     = 0.5;
  uvs[bottomCapBase * 2 + 1] = 0.5;
  for (let s = 0; s < segs; s++) {
    const theta = (2 * Math.PI * s) / segs;
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
    indices[idx++] = bottomCapBase + 1 + ((s + 1) % segs);
  }

  return { positions, normals, uvs, indices };
}
