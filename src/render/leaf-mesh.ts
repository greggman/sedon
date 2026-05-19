import type { CpuMesh } from './mesh.js';

// Generate a curved 3D leaf card. The base sits at the origin; the tip
// rises along +Y to `length`; width spans `±width/2` along X; the leaf
// face initially looks at +Z (the +Y axis is the petiole-to-tip
// direction). Pair with `core/instance-geometry-on-points` (`align:
// true`) so the leaf's +Y aligns to each point's outward normal.
//
// Shape deformation (added to a flat rectangle):
//   • `curl`  — drops the tip in -Z as a quadratic of v: z_tip = -curl.
//   • `bend`  — drops both edges in -Z as a quadratic of |u - 0.5|.
//   • `cup`   — pulls width inward toward the tip by a multiplicative
//               profile width * (1 - cup * v²), so the leaf widens
//               near the base and narrows toward the tip (closer to a
//               real leaf silhouette than a strict rectangle).
//
// Normals are analytical: n = (dp/du) × (dp/dv) at each vertex, then
// normalized. UVs map u→[0,1] across width, v→[0,1] base→tip (the same
// convention `core/leaf-skeleton` uses for its silhouette + vein
// textures, so a leaf-skeleton mask materials cleanly onto this card).
export interface LeafMeshOpts {
  length: number;
  width: number;
  /** Tip drop along -Z (world units). */
  curl: number;
  /** Edge drop along -Z (world units). */
  bend: number;
  /**
   * 0 = strict rectangle; 1 = width tapers to zero at the tip. ~0.3
   * approximates a typical lanceolate leaf without making it look
   * needle-shaped.
   */
  cup: number;
  /** Vertices along the length minus 1. */
  lengthDivisions: number;
  /** Vertices across the width minus 1. */
  widthDivisions: number;
}

export function generateLeafMesh(opts: LeafMeshOpts): CpuMesh {
  const lengthDivisions = Math.max(1, Math.floor(opts.lengthDivisions));
  const widthDivisions = Math.max(1, Math.floor(opts.widthDivisions));
  const vertsX = widthDivisions + 1;
  const vertsV = lengthDivisions + 1;
  const numVerts = vertsX * vertsV;

  const positions = new Float32Array(numVerts * 3);
  const normals = new Float32Array(numVerts * 3);
  const uvs = new Float32Array(numVerts * 2);

  const { length, width, curl, bend, cup } = opts;

  let p = 0;
  let uv = 0;
  for (let vi = 0; vi < vertsV; vi++) {
    const v = vi / lengthDivisions; // 0..1, base→tip
    const widthScale = 1 - cup * v * v;
    const localWidth = width * widthScale;
    for (let ui = 0; ui < vertsX; ui++) {
      const u = ui / widthDivisions; // 0..1
      const x = (u - 0.5) * localWidth;
      const y = v * length;
      const edge = 2 * u - 1; // -1..1
      const z = -curl * v * v - bend * edge * edge;

      positions[p]     = x;
      positions[p + 1] = y;
      positions[p + 2] = z;

      // Analytical normal: tangent_u × tangent_v at this vertex.
      //   tangent_u = (∂x/∂u, ∂y/∂u, ∂z/∂u) = (localWidth, 0, dz/du)
      //   tangent_v = (∂x/∂v, ∂y/∂v, ∂z/∂v) = (x · dWidthScale/dv / widthScale,
      //                                          length,
      //                                          dz/dv)
      // The cup taper adds an x-component to ∂/∂v because each row's
      // width depends on v, so a vertex with x≠0 shifts inward as v
      // grows. Without modelling that, lateral normals tilt the wrong
      // way at the leaf tip.
      const dzdu = -bend * 2 * edge * 2; // -4*bend*(2u-1)
      const dzdv = -curl * 2 * v;
      const dWidthScaleDv = -2 * cup * v;
      const dxdv = (u - 0.5) * width * dWidthScaleDv;

      const tux = localWidth;
      const tuy = 0;
      const tuz = dzdu;
      const tvx = dxdv;
      const tvy = length;
      const tvz = dzdv;
      let nx = tuy * tvz - tuz * tvy;
      let ny = tuz * tvx - tux * tvz;
      let nz = tux * tvy - tuy * tvx;
      const nlen = Math.hypot(nx, ny, nz) || 1;
      nx /= nlen; ny /= nlen; nz /= nlen;
      normals[p]     = nx;
      normals[p + 1] = ny;
      normals[p + 2] = nz;

      uvs[uv]     = u;
      uvs[uv + 1] = v;
      p += 3;
      uv += 2;
    }
  }

  // Index the grid as a triangle strip per row. CCW winding when viewed
  // from +Z so default back-face culling drops the underside.
  const indices = new Uint32Array(lengthDivisions * widthDivisions * 6);
  let i = 0;
  for (let vi = 0; vi < lengthDivisions; vi++) {
    for (let ui = 0; ui < widthDivisions; ui++) {
      const a = vi * vertsX + ui;
      const b = a + vertsX;
      indices[i++] = a;
      indices[i++] = b;
      indices[i++] = a + 1;
      indices[i++] = b;
      indices[i++] = b + 1;
      indices[i++] = a + 1;
    }
  }

  return { positions, normals, uvs, indices };
}
