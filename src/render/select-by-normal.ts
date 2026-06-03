// Face selection by NORMAL DIRECTION. For each triangle, compute its
// face normal from positions + winding, then mark it selected if the
// angle between that normal and the user-given direction is at-or-
// below the threshold.
//
// Output is keyed by triangle index (`selection.faces[f]`) — the
// per-tri convention matches `MeshSelection.faces` in resources.ts
// and is the input shape `core/extrude` consumes.

import type { CpuMeshRef } from '../core/resources.js';

export interface SelectByNormalOptions {
  /** Target direction. Need not be unit; normalised internally. */
  direction: [number, number, number];
  /** Max angle in RADIANS between face normal and direction. */
  thresholdRadians: number;
  /** When true, select faces OUTSIDE the threshold instead. */
  selectBelow?: boolean;
}

export function selectFacesByNormal(
  mesh: CpuMeshRef,
  options: SelectByNormalOptions,
): Uint8Array {
  const [dxRaw, dyRaw, dzRaw] = options.direction;
  const dlen = Math.hypot(dxRaw, dyRaw, dzRaw);
  // Degenerate direction → nothing matches; return all-zeros so the
  // downstream ops short-circuit and the user sees "no effect" — same
  // shape as a deselect-everything pass.
  if (dlen < 1e-12) return new Uint8Array((mesh.indices.length / 3) | 0);
  const dx = dxRaw / dlen, dy = dyRaw / dlen, dz = dzRaw / dlen;

  const cosThreshold = Math.cos(options.thresholdRadians);
  const selectBelow = options.selectBelow ?? false;
  const faceCount = (mesh.indices.length / 3) | 0;
  const mask = new Uint8Array(faceCount);

  for (let f = 0; f < faceCount; f++) {
    const i0 = mesh.indices[f * 3]!;
    const i1 = mesh.indices[f * 3 + 1]!;
    const i2 = mesh.indices[f * 3 + 2]!;
    const ax = mesh.positions[i0 * 3]!, ay = mesh.positions[i0 * 3 + 1]!, az = mesh.positions[i0 * 3 + 2]!;
    const bx = mesh.positions[i1 * 3]!, by = mesh.positions[i1 * 3 + 1]!, bz = mesh.positions[i1 * 3 + 2]!;
    const cx = mesh.positions[i2 * 3]!, cy = mesh.positions[i2 * 3 + 1]!, cz = mesh.positions[i2 * 3 + 2]!;
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const nlen = Math.hypot(nx, ny, nz);
    // Degenerate face → never selected (no defensible normal).
    if (nlen < 1e-12) continue;
    const cosAngle = (nx * dx + ny * dy + nz * dz) / nlen;
    // angle ≤ threshold  ⇔  cos(angle) ≥ cos(threshold)
    const withinThreshold = cosAngle >= cosThreshold;
    if (selectBelow ? !withinThreshold : withinThreshold) mask[f] = 1;
  }
  return mask;
}

export function countSelectedFaces(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === 1) n++;
  return n;
}
