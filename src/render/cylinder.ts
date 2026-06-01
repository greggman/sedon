import type { CpuMesh } from './mesh.js';

// Cylinder with base at y=0 and top at y=height (the asymmetric "grows
// upward from origin" convention rather than centered). For trees, towers,
// and columns the base-anchored origin saves a Transform node downstream.
//
// Side vertices duplicate the seam (segments+1 per ring) so cylindrical UV
// wrap works without a degenerate triangle. Caps use distinct vertices with
// +Y / -Y normals so the corner between side and cap stays sharp regardless
// of how the side is shaded.
export function generateCylinder(radius: number, height: number, segments: number): CpuMesh {
  const segs = Math.max(3, Math.floor(segments));

  const sideRingV = segs + 1;
  const sideV = 2 * sideRingV;
  const topCapBase = sideV;
  const topCapV = 1 + segs;
  const bottomCapBase = topCapBase + topCapV;
  const bottomCapV = 1 + segs;
  const totalV = bottomCapBase + bottomCapV;

  const totalI = segs * 6 /* sides */ + segs * 3 * 2 /* caps */;

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
      // mod twoPI is need to avoid seems for compute-normals
      const theta = (2 * Math.PI * s) / segs % twoPI;
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
    // CCW from outside the cylinder. With theta increasing toward +Z, vertex
    // b sits in the +Z direction from a (i.e. to the LEFT in the screen of a
    // viewer standing at +X looking back at origin), so the CCW winding is
    // (a, d, b) and (a, c, d).
    indices[idx++] = a;
    indices[idx++] = d;
    indices[idx++] = b;
    indices[idx++] = a;
    indices[idx++] = c;
    indices[idx++] = d;
  }

  // Top cap: center + rim, all with +Y normal. Disc-style UV from rim to
  // center. Fan triangles wind CCW when viewed from +Y so back-face culling
  // keeps the upward face.
  positions[topCapBase * 3]     = 0;
  positions[topCapBase * 3 + 1] = height;
  positions[topCapBase * 3 + 2] = 0;
  normals[topCapBase * 3]     = 0;
  normals[topCapBase * 3 + 1] = 1;
  normals[topCapBase * 3 + 2] = 0;
  uvs[topCapBase * 2]     = 0.5;
  uvs[topCapBase * 2 + 1] = 0.5;
  for (let s = 0; s < segs; s++) {
    const theta = (2 * Math.PI * s) / segs;
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
    indices[idx++] = topCapBase + 1 + ((s + 1) % segs);
    indices[idx++] = topCapBase + 1 + s;
  }

  // Bottom cap: center + rim, all with -Y normal. Fan winding is reversed so
  // it's CCW when viewed from -Y.
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
