import type { CpuMesh } from './mesh.js';

// Sweep a 2D cross-section along a 3D polyline path.
//
// Each path sample places a "ring" — the cross-section transformed into
// a plane perpendicular to the path's local tangent. Adjacent rings
// are stitched with quads (two triangles each) to form the swept tube.
//
// Frame convention: we use a "rotation-minimising frame" approximation,
// seeded with an up-vector that's stable for typical mostly-horizontal
// paths (world-up). The frame's `right` axis aligns with the cross-
// section's local X; `up` aligns with its local Y. Wrapping a section
// 90° around a corner happens naturally because each ring's frame is
// computed from that segment's tangent.
//
// Caps: the first and last cross-sections close the tube at each end
// when `cap_start` / `cap_end` are on. Caps assume the cross-section
// is a SIMPLE CONVEX polygon — we fan-triangulate from the centroid.
// Non-convex caps render with overlaps, which is fine for typical
// moulding / baseboard profiles but breaks on, say, a "C" shape; the
// user can disable caps and emit them separately if they need that.

export interface ExtrudeProfilePoint { x: number; y: number }

export interface ExtrudeOptions {
  /** Whether the cross-section is a closed loop (its last edge connects
   *  back to its first). Default true — typical for a moulding profile.
   *  Off for an open ribbon / belt strap. */
  closedSection?: boolean;
  capStart?: boolean;
  capEnd?: boolean;
}

function normalize(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

function cross(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): [number, number, number] {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

export function generateExtrudeOnPath(
  pathSamples: Float32Array,
  pathCount: number,
  profile: ReadonlyArray<ExtrudeProfilePoint>,
  options: ExtrudeOptions = {},
): CpuMesh {
  const closedSection = options.closedSection ?? true;
  const capStart = options.capStart ?? true;
  const capEnd = options.capEnd ?? true;

  // Need at least 2 path samples and 2 cross-section points to form
  // any geometry.
  if (pathCount < 2 || profile.length < 2) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      uvs: new Float32Array(0),
      indices: new Uint32Array(0),
    };
  }

  // Per-sample tangent: forward difference at interior + endpoints
  // (one-sided at the ends).
  const tangents: [number, number, number][] = [];
  for (let i = 0; i < pathCount; i++) {
    const prevI = Math.max(0, i - 1);
    const nextI = Math.min(pathCount - 1, i + 1);
    const px = pathSamples[prevI * 3]!;
    const py = pathSamples[prevI * 3 + 1]!;
    const pz = pathSamples[prevI * 3 + 2]!;
    const nx = pathSamples[nextI * 3]!;
    const ny = pathSamples[nextI * 3 + 1]!;
    const nz = pathSamples[nextI * 3 + 2]!;
    tangents.push(normalize(nx - px, ny - py, nz - pz));
  }

  // Build a frame per sample. Seed with world-up; if the first
  // tangent is too parallel to world-up, swap to world-Z so the
  // initial `right` vector is well-defined. Propagate forward by
  // rotation-minimising: project the previous `up` onto the plane
  // perpendicular to the new tangent, renormalise.
  const ups: [number, number, number][] = [];
  const rights: [number, number, number][] = [];
  {
    const t0 = tangents[0]!;
    let seedUp: [number, number, number] = [0, 1, 0];
    if (Math.abs(t0[0] * seedUp[0] + t0[1] * seedUp[1] + t0[2] * seedUp[2]) > 0.99) {
      seedUp = [0, 0, 1];
    }
    let up = seedUp;
    for (let i = 0; i < pathCount; i++) {
      const t = tangents[i]!;
      // right = normalize(cross(up, t)); recompute up = cross(t, right)
      // so up is exactly perpendicular to t.
      let right = cross(up[0], up[1], up[2], t[0], t[1], t[2]);
      right = normalize(right[0], right[1], right[2]);
      const newUp = cross(t[0], t[1], t[2], right[0], right[1], right[2]);
      const upN = normalize(newUp[0], newUp[1], newUp[2]);
      rights.push(right);
      ups.push(upN);
      up = upN;
    }
  }

  // Cross-section vertex layout. For a CLOSED section we duplicate
  // the seam (sectionV = profile.length + 1) so UV wrap and per-
  // segment normals don't get smeared across the join. For an OPEN
  // section the ribbon just uses profile.length verts.
  const sectionN = profile.length;
  const sectionV = closedSection ? sectionN + 1 : sectionN;

  // Per-section-vertex 2D outward normal. For a closed convex
  // section it's the CW-rotated tangent of adjacent edges; for an
  // open ribbon we use the per-vertex average tangent. This gives a
  // smooth shaded sweep along curved cross-sections without doubling
  // vertices.
  const sectionNormals: [number, number][] = [];
  for (let i = 0; i < sectionN; i++) {
    const prev = profile[(i - 1 + sectionN) % sectionN]!;
    const next = profile[(i + 1) % sectionN]!;
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    // CW-90° rotation of tangent → outward normal (assuming CCW
    // section authoring). Reverse if the section came in CW; we
    // can't tell without a winding test, so document this and move on.
    sectionNormals.push([ty / len, -tx / len]);
  }

  // Cumulative arc length along the cross-section for UV.u, and
  // along the path for UV.v.
  const sectionLens = [0];
  for (let i = 1; i < sectionN; i++) {
    const dx = profile[i]!.x - profile[i - 1]!.x;
    const dy = profile[i]!.y - profile[i - 1]!.y;
    sectionLens.push(sectionLens[i - 1]! + Math.hypot(dx, dy));
  }
  if (closedSection) {
    const dx = profile[0]!.x - profile[sectionN - 1]!.x;
    const dy = profile[0]!.y - profile[sectionN - 1]!.y;
    sectionLens.push(sectionLens[sectionN - 1]! + Math.hypot(dx, dy));
  }
  const sectionTotal = sectionLens[sectionLens.length - 1]! || 1;

  const pathLens = [0];
  for (let i = 1; i < pathCount; i++) {
    const dx = pathSamples[i * 3]! - pathSamples[(i - 1) * 3]!;
    const dy = pathSamples[i * 3 + 1]! - pathSamples[(i - 1) * 3 + 1]!;
    const dz = pathSamples[i * 3 + 2]! - pathSamples[(i - 1) * 3 + 2]!;
    pathLens.push(pathLens[i - 1]! + Math.hypot(dx, dy, dz));
  }
  const pathTotal = pathLens[pathCount - 1]! || 1;

  // Body vertices: one per (path sample × section vertex).
  const bodyV = pathCount * sectionV;
  // Caps: triangulate the cross-section as a fan from its centroid.
  // 1 centroid + sectionN rim verts per cap.
  const wantCapStart = capStart && closedSection;
  const wantCapEnd = capEnd && closedSection;
  const startCapBase = bodyV;
  const startCapV = wantCapStart ? 1 + sectionN : 0;
  const endCapBase = startCapBase + startCapV;
  const endCapV = wantCapEnd ? 1 + sectionN : 0;
  const totalV = endCapBase + endCapV;

  // Indices: (pathCount - 1) strips × (sectionV - 1) quads × 2 tris.
  const stripSegs = sectionV - 1;
  const bodyI = (pathCount - 1) * stripSegs * 6;
  const capI = (wantCapStart ? sectionN * 3 : 0) + (wantCapEnd ? sectionN * 3 : 0);
  const totalI = bodyI + capI;

  const positions = new Float32Array(totalV * 3);
  const normals = new Float32Array(totalV * 3);
  const uvs = new Float32Array(totalV * 2);
  const indices = new Uint32Array(totalI);

  // Body sweep.
  for (let pi = 0; pi < pathCount; pi++) {
    const ox = pathSamples[pi * 3]!;
    const oy = pathSamples[pi * 3 + 1]!;
    const oz = pathSamples[pi * 3 + 2]!;
    const r = rights[pi]!;
    const u = ups[pi]!;
    const v = pathLens[pi]! / pathTotal;
    for (let si = 0; si < sectionV; si++) {
      const sIdx = si % sectionN; // wraps the duplicated seam vertex
      const p = profile[sIdx]!;
      const n2 = sectionNormals[sIdx]!;
      const idx = pi * sectionV + si;
      positions[idx * 3]     = ox + r[0] * p.x + u[0] * p.y;
      positions[idx * 3 + 1] = oy + r[1] * p.x + u[1] * p.y;
      positions[idx * 3 + 2] = oz + r[2] * p.x + u[2] * p.y;
      const nx3 = r[0] * n2[0] + u[0] * n2[1];
      const ny3 = r[1] * n2[0] + u[1] * n2[1];
      const nz3 = r[2] * n2[0] + u[2] * n2[1];
      const nlen = Math.hypot(nx3, ny3, nz3) || 1;
      normals[idx * 3]     = nx3 / nlen;
      normals[idx * 3 + 1] = ny3 / nlen;
      normals[idx * 3 + 2] = nz3 / nlen;
      uvs[idx * 2]     = sectionLens[si]! / sectionTotal;
      uvs[idx * 2 + 1] = v;
    }
  }

  let ii = 0;
  for (let pi = 0; pi < pathCount - 1; pi++) {
    for (let si = 0; si < stripSegs; si++) {
      const a = pi * sectionV + si;
      const b = pi * sectionV + si + 1;
      const c = (pi + 1) * sectionV + si;
      const d = (pi + 1) * sectionV + si + 1;
      indices[ii++] = a;
      indices[ii++] = d;
      indices[ii++] = b;
      indices[ii++] = a;
      indices[ii++] = c;
      indices[ii++] = d;
    }
  }

  // Caps. Centroid in 2D, then transformed into 3D with the frame
  // at that endpoint. Fan-triangulate from centroid; cap normal is
  // -tangent at start (pointing away from the path), +tangent at end.
  function emitCap(
    base: number,
    pathIdx: number,
    sign: 1 | -1,
  ): void {
    // Centroid in 2D.
    let cx = 0;
    let cy = 0;
    for (const p of profile) { cx += p.x; cy += p.y; }
    cx /= sectionN;
    cy /= sectionN;
    const ox = pathSamples[pathIdx * 3]!;
    const oy = pathSamples[pathIdx * 3 + 1]!;
    const oz = pathSamples[pathIdx * 3 + 2]!;
    const r = rights[pathIdx]!;
    const u = ups[pathIdx]!;
    const t = tangents[pathIdx]!;
    const nx = sign * t[0];
    const ny = sign * t[1];
    const nz = sign * t[2];
    positions[base * 3]     = ox + r[0] * cx + u[0] * cy;
    positions[base * 3 + 1] = oy + r[1] * cx + u[1] * cy;
    positions[base * 3 + 2] = oz + r[2] * cx + u[2] * cy;
    normals[base * 3]     = nx;
    normals[base * 3 + 1] = ny;
    normals[base * 3 + 2] = nz;
    uvs[base * 2]     = 0.5;
    uvs[base * 2 + 1] = 0.5;
    for (let i = 0; i < sectionN; i++) {
      const p = profile[i]!;
      const idx = base + 1 + i;
      positions[idx * 3]     = ox + r[0] * p.x + u[0] * p.y;
      positions[idx * 3 + 1] = oy + r[1] * p.x + u[1] * p.y;
      positions[idx * 3 + 2] = oz + r[2] * p.x + u[2] * p.y;
      normals[idx * 3]     = nx;
      normals[idx * 3 + 1] = ny;
      normals[idx * 3 + 2] = nz;
      uvs[idx * 2]     = 0.5 + p.x * 0.5;
      uvs[idx * 2 + 1] = 0.5 + p.y * 0.5;
    }
    // Wind so CCW from the OUTSIDE of the cap (i.e., the side the
    // normal points away from). For sign = 1 (end cap, outward normal
    // = +tangent), CCW order around the rim matches the natural
    // profile order; for sign = -1 (start cap), reverse.
    for (let i = 0; i < sectionN; i++) {
      indices[ii++] = base;
      if (sign > 0) {
        indices[ii++] = base + 1 + i;
        indices[ii++] = base + 1 + ((i + 1) % sectionN);
      } else {
        indices[ii++] = base + 1 + ((i + 1) % sectionN);
        indices[ii++] = base + 1 + i;
      }
    }
  }
  if (wantCapStart) emitCap(startCapBase, 0, -1);
  if (wantCapEnd) emitCap(endCapBase, pathCount - 1, 1);

  return { positions, normals, uvs, indices };
}
