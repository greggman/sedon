import type { CpuMesh } from './mesh.js';

// Revolve a 2D profile around the Y axis to make a surface of revolution.
// Furniture wins: turned legs, balusters, knobs, lamp bases, vase shapes.
// The profile is a polyline of [x, y] points authored in the XZ-plane
// editor (z is ignored by callers — they pass an `[x, y]`-shaped pair list).
//
// Topology: `profile.length` rings × (`segments + 1`) vertices per ring
// (seam duplicated so UV-wrap reads cleanly and the radial seam isn't a
// degenerate triangle). Adjacent rings are stitched with two triangles per
// segment per inter-ring strip. End caps are added when the profile's
// terminal points sit off-axis (x > 0) — capStart/capEnd toggle those.
//
// Normals: derived from the 2D profile tangent rotated 90° clockwise into
// the 2D outward normal, then revolved around Y. Matches the "material on
// the right of the profile as you walk from start to end" convention, so
// CCW winding faces outward for a profile authored top-down. If the
// profile is wound the other way, the user can flip via a transform's
// negative scale on X (or we can add an `invert` toggle later).

export interface LatheProfilePoint {
  x: number;
  y: number;
}

export interface LatheOptions {
  segments?: number;
  capStart?: boolean;
  capEnd?: boolean;
}

export function generateLathe(
  profile: ReadonlyArray<LatheProfilePoint>,
  options: LatheOptions = {},
): CpuMesh {
  const segs = Math.max(3, Math.floor(options.segments ?? 24));
  const capStart = options.capStart ?? true;
  const capEnd = options.capEnd ?? true;

  // Need at least 2 profile points to form a strip. Empty/single-point
  // profiles produce an empty mesh rather than a crash — upstream nodes
  // (random / loaded profile data) might produce zero points.
  if (profile.length < 2) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      uvs: new Float32Array(0),
      indices: new Uint32Array(0),
    };
  }

  const rings = profile.length;
  const ringV = segs + 1; // seam duplicated

  // 2D outward normal per profile point. Central difference for
  // interior; one-sided at endpoints. Rotating the profile tangent
  // (dx, dy) by 90° CW gives outward (dy, -dx) when the profile is
  // authored top-to-bottom with material to the right (the common
  // convention for a vase/leg silhouette).
  const profileTangents: { tx: number; ty: number }[] = [];
  for (let i = 0; i < rings; i++) {
    const prev = profile[Math.max(0, i - 1)]!;
    const next = profile[Math.min(rings - 1, i + 1)]!;
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    profileTangents.push({ tx, ty });
  }

  // Cumulative arc length along the profile, normalised → UV.v.
  // Stretches non-uniform — same as Houdini's `lathe` default. Users
  // who care about per-segment UV pacing can post-process with
  // core/uv-transform later.
  const cumLen = [0];
  for (let i = 1; i < rings; i++) {
    const dx = profile[i]!.x - profile[i - 1]!.x;
    const dy = profile[i]!.y - profile[i - 1]!.y;
    cumLen.push(cumLen[i - 1]! + Math.hypot(dx, dy));
  }
  const totalLen = cumLen[rings - 1]! || 1;

  // Body vertices.
  const bodyV = rings * ringV;
  // Caps: when the terminal profile point has x > 0 we add a disc to
  // close the open ring. center vertex + `segs` rim vertices each.
  const wantCapStart = capStart && profile[0]!.x > 1e-6;
  const wantCapEnd = capEnd && profile[rings - 1]!.x > 1e-6;
  const startCapBase = bodyV;
  const startCapV = wantCapStart ? 1 + segs : 0;
  const endCapBase = startCapBase + startCapV;
  const endCapV = wantCapEnd ? 1 + segs : 0;
  const totalV = endCapBase + endCapV;

  const totalI =
    (rings - 1) * segs * 6 + // body strips
    (wantCapStart ? segs * 3 : 0) +
    (wantCapEnd ? segs * 3 : 0);

  const positions = new Float32Array(totalV * 3);
  const normals = new Float32Array(totalV * 3);
  const uvs = new Float32Array(totalV * 2);
  const indices = new Uint32Array(totalI);

  // Body: ring-by-ring sweep around Y.
  for (let i = 0; i < rings; i++) {
    const p = profile[i]!;
    const { tx, ty } = profileTangents[i]!;
    // 2D outward normal (CW-rotated tangent). nx is the radial
    // component (will get revolved), ny is straight Y.
    const nx2 = ty;
    const ny2 = -tx;
    const v = cumLen[i]! / totalLen;
    for (let s = 0; s <= segs; s++) {
      const theta = (2 * Math.PI * s) / segs;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const idx = i * ringV + s;
      positions[idx * 3]     = cos * p.x;
      positions[idx * 3 + 1] = p.y;
      positions[idx * 3 + 2] = sin * p.x;
      // Revolve the 2D outward normal around Y. If the profile point
      // is on-axis (x == 0) the revolved normal still has the right
      // direction for shading; only the position collapses.
      let rx = cos * nx2;
      let ry = ny2;
      let rz = sin * nx2;
      const nlen = Math.hypot(rx, ry, rz) || 1;
      rx /= nlen;
      ry /= nlen;
      rz /= nlen;
      normals[idx * 3]     = rx;
      normals[idx * 3 + 1] = ry;
      normals[idx * 3 + 2] = rz;
      uvs[idx * 2]     = s / segs;
      uvs[idx * 2 + 1] = v;
    }
  }

  let ii = 0;
  // Body strips: ring i to ring i+1, segment s to s+1. CCW from outside
  // matches the cylinder.ts convention (theta increasing toward +Z).
  for (let i = 0; i < rings - 1; i++) {
    for (let s = 0; s < segs; s++) {
      const a = i * ringV + s;
      const b = i * ringV + s + 1;
      const c = (i + 1) * ringV + s;
      const d = (i + 1) * ringV + s + 1;
      indices[ii++] = a;
      indices[ii++] = d;
      indices[ii++] = b;
      indices[ii++] = a;
      indices[ii++] = c;
      indices[ii++] = d;
    }
  }

  // Start cap (profile point 0 — typically the TOP of a vase / KNOB
  // top of a leg). Normal +Y if profile starts at the top; here we
  // use the profile-tangent-derived normal: rotate (tx, ty) CCW 90°
  // to get the cap's outward direction in 2D, then it's purely along
  // Y for a profile that runs along Y. Simpler approach: just emit a
  // disc with normal pointing the OPPOSITE of the body sweep at the
  // start (i.e., away from the next profile point).
  if (wantCapStart) {
    const p = profile[0]!;
    const next = profile[1]!;
    // Cap normal: along the "outside" direction at the boundary, which
    // is opposite the sweep into the body. For a profile that runs
    // downward (next.y < p.y), the cap normal is +Y.
    const dy = next.y - p.y;
    const ny = dy > 0 ? -1 : 1; // sign such that we point away from body
    positions[startCapBase * 3]     = 0;
    positions[startCapBase * 3 + 1] = p.y;
    positions[startCapBase * 3 + 2] = 0;
    normals[startCapBase * 3]     = 0;
    normals[startCapBase * 3 + 1] = ny;
    normals[startCapBase * 3 + 2] = 0;
    uvs[startCapBase * 2]     = 0.5;
    uvs[startCapBase * 2 + 1] = 0.5;
    for (let s = 0; s < segs; s++) {
      const theta = (2 * Math.PI * s) / segs;
      const cx = Math.cos(theta);
      const cz = Math.sin(theta);
      const idx = startCapBase + 1 + s;
      positions[idx * 3]     = cx * p.x;
      positions[idx * 3 + 1] = p.y;
      positions[idx * 3 + 2] = cz * p.x;
      normals[idx * 3]     = 0;
      normals[idx * 3 + 1] = ny;
      normals[idx * 3 + 2] = 0;
      uvs[idx * 2]     = 0.5 + cx * 0.5;
      uvs[idx * 2 + 1] = 0.5 + cz * 0.5 * ny;
    }
    // CCW from the cap's outward face: +Y normal → wind CCW as seen
    // from +Y; -Y normal → reverse.
    for (let s = 0; s < segs; s++) {
      indices[ii++] = startCapBase;
      if (ny > 0) {
        indices[ii++] = startCapBase + 1 + ((s + 1) % segs);
        indices[ii++] = startCapBase + 1 + s;
      } else {
        indices[ii++] = startCapBase + 1 + s;
        indices[ii++] = startCapBase + 1 + ((s + 1) % segs);
      }
    }
  }

  if (wantCapEnd) {
    const p = profile[rings - 1]!;
    const prev = profile[rings - 2]!;
    const dy = p.y - prev.y;
    const ny = dy > 0 ? 1 : -1;
    positions[endCapBase * 3]     = 0;
    positions[endCapBase * 3 + 1] = p.y;
    positions[endCapBase * 3 + 2] = 0;
    normals[endCapBase * 3]     = 0;
    normals[endCapBase * 3 + 1] = ny;
    normals[endCapBase * 3 + 2] = 0;
    uvs[endCapBase * 2]     = 0.5;
    uvs[endCapBase * 2 + 1] = 0.5;
    for (let s = 0; s < segs; s++) {
      const theta = (2 * Math.PI * s) / segs;
      const cx = Math.cos(theta);
      const cz = Math.sin(theta);
      const idx = endCapBase + 1 + s;
      positions[idx * 3]     = cx * p.x;
      positions[idx * 3 + 1] = p.y;
      positions[idx * 3 + 2] = cz * p.x;
      normals[idx * 3]     = 0;
      normals[idx * 3 + 1] = ny;
      normals[idx * 3 + 2] = 0;
      uvs[idx * 2]     = 0.5 + cx * 0.5;
      uvs[idx * 2 + 1] = 0.5 + cz * 0.5 * ny;
    }
    for (let s = 0; s < segs; s++) {
      indices[ii++] = endCapBase;
      if (ny > 0) {
        indices[ii++] = endCapBase + 1 + ((s + 1) % segs);
        indices[ii++] = endCapBase + 1 + s;
      } else {
        indices[ii++] = endCapBase + 1 + s;
        indices[ii++] = endCapBase + 1 + ((s + 1) % segs);
      }
    }
  }

  return { positions, normals, uvs, indices };
}
