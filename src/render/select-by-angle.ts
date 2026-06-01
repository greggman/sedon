// Edge selection by dihedral angle: emit an edge selection mask
// where each shared (manifold) edge whose two faces meet at an
// angle ≥ threshold is marked 1. Used by bevel / chamfer as the
// canonical "select the sharp edges" pattern — bevelling a cube
// (all 90° edges) or the join between a lathe body and its end cap
// (90° rim) is exactly this.
//
// Output shape: a Uint8Array of length `3 * faceCount` (one byte per
// half-edge id). Both twins of a selected edge are marked 1 — the
// canonical invariant for the `edges` slot of MeshSelection (so
// consumers don't have to pick a "primary" side per edge). Boundary
// half-edges (twin = -1) and degenerate-face half-edges are NEVER
// selected: there's no dihedral angle to threshold against.
//
// Welding: the convention follows `computeNormalsWithCuspAngle` —
// vertices at coincident positions are welded for topology purposes
// when `weldByPosition` is on (default), so split-vertex primitives
// (cube / sphere / cylinder) treat their face-to-face edges as
// shared and the angle test runs against the actual dihedral. Without
// welding, those edges read as boundaries and never get selected.

import type { CpuMeshRef } from '../core/resources.js';
import { buildHalfEdgeMesh, faceOf } from './half-edge-mesh.js';

export interface SelectByAngleOptions {
  /**
   * Treat coincident-position vertices as one for topology. Default
   * true. See computeNormalsWithCuspAngle for the rationale — Sedon
   * primitives emit split vertices so face-to-face edges look like
   * boundaries without welding.
   */
  weldByPosition?: boolean;
  /**
   * When true, selection MATCHES edges with dihedral angle STRICTLY
   * LESS than the threshold instead. Useful as the building block
   * for "select coplanar regions." Default false (the bevel use
   * case — select sharp edges, i.e. angle ≥ threshold).
   */
  selectBelow?: boolean;
}

export function selectEdgesByAngle(
  mesh: CpuMeshRef,
  thresholdRadians: number,
  options: SelectByAngleOptions = {},
): Uint8Array {
  const weldByPosition = options.weldByPosition ?? true;
  const selectBelow = options.selectBelow ?? false;

  // Build the topology mesh, optionally welding coincident positions.
  let topoIndices = mesh.indices;
  if (weldByPosition) {
    const canonical = buildPositionWeldMap(mesh.positions);
    let needsRemap = false;
    for (let i = 0; i < mesh.indices.length; i++) {
      if (canonical[mesh.indices[i]!]! !== mesh.indices[i]!) {
        needsRemap = true;
        break;
      }
    }
    if (needsRemap) {
      topoIndices = new Uint32Array(mesh.indices.length);
      for (let i = 0; i < mesh.indices.length; i++) {
        topoIndices[i] = canonical[mesh.indices[i]!]!;
      }
    }
  }
  const topoMesh: CpuMeshRef = topoIndices === mesh.indices
    ? mesh
    : { positions: mesh.positions, normals: mesh.normals, uvs: mesh.uvs, indices: topoIndices };
  const half = buildHalfEdgeMesh(topoMesh);
  const faceCount = half.faceCount;
  const halfEdgeCount = half.halfEdgeCount;

  // Per-face unit normals; degenerate faces leave (0,0,0) and are
  // skipped during the angle test.
  const faceNormals = new Float32Array(faceCount * 3);
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
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) {
      faceNormals[f * 3]     = nx / len;
      faceNormals[f * 3 + 1] = ny / len;
      faceNormals[f * 3 + 2] = nz / len;
    }
  }

  // Test each half-edge's edge against the threshold. We visit each
  // edge twice (once per twin) — set both bytes so consumers can
  // read either half and get the same answer. cos(threshold) lets
  // us skip a per-edge `acos`. Strict-less-than vs strict-greater-
  // than corresponds to the `selectBelow` flag.
  const cosThreshold = Math.cos(thresholdRadians);
  const edges = new Uint8Array(halfEdgeCount);
  for (let he = 0; he < halfEdgeCount; he++) {
    if (edges[he] === 1) continue;
    const t = half.twin[he]!;
    if (t < 0) continue; // boundary / non-manifold — no dihedral angle
    const fa = faceOf(he);
    const fb = faceOf(t);
    const nax = faceNormals[fa * 3]!, nay = faceNormals[fa * 3 + 1]!, naz = faceNormals[fa * 3 + 2]!;
    const nbx = faceNormals[fb * 3]!, nby = faceNormals[fb * 3 + 1]!, nbz = faceNormals[fb * 3 + 2]!;
    if ((nax === 0 && nay === 0 && naz === 0) || (nbx === 0 && nby === 0 && nbz === 0)) continue;
    const cosAngle = nax * nbx + nay * nby + naz * nbz;
    // angle >= threshold ⇔ cos(angle) <= cos(threshold).
    // angle <  threshold ⇔ cos(angle) >  cos(threshold).
    const selected = selectBelow
      ? cosAngle > cosThreshold
      : cosAngle <= cosThreshold;
    if (selected) {
      edges[he] = 1;
      edges[t]  = 1;
    }
  }
  return edges;
}

/**
 * Same position-weld helper as compute-normals. Inlined here to avoid
 * coupling the two modules; if we add more consumers we'll lift it
 * to a shared utility.
 */
function buildPositionWeldMap(positions: Float32Array): Uint32Array {
  const vCount = (positions.length / 3) | 0;
  const map = new Uint32Array(vCount);
  const posMap = new Map<string, number>();
  for (let v = 0; v < vCount; v++) {
    const x = positions[v * 3]!;
    const y = positions[v * 3 + 1]!;
    const z = positions[v * 3 + 2]!;
    const key = `${x},${y},${z}`;
    const existing = posMap.get(key);
    if (existing === undefined) {
      posMap.set(key, v);
      map[v] = v;
    } else {
      map[v] = existing;
    }
  }
  return map;
}

/** Count selected edges in an edge-selection mask. Selection marks
 *  both twins of an undirected edge, so the byte count is exactly
 *  2× the logical edge count — we divide by 2 for the user-facing
 *  number. */
export function countSelectedEdges(edges: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < edges.length; i++) count += edges[i]!;
  return count >> 1;
}
