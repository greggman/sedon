// Per-corner normal recomputation with a cusp-angle threshold:
//   • Edges where the dihedral angle between the two faces is BELOW
//     the threshold are smoothed (the two faces share a vertex
//     normal at each of the edge's endpoints).
//   • Edges where the dihedral angle is at-or-above threshold are
//     CREASED (each face gets its own normal at the shared vertex —
//     the vertex is duplicated in the output).
//
// This is the standard "auto-smooth" / "smooth normals by angle"
// operation every DCC ships (Blender's Smooth Shading + Auto Smooth,
// Houdini's PolyDoctor → "compute vertex normals," Maya's Soften
// Edge). The algorithm walks each vertex's incident faces and
// partitions them into smoothing groups by reachability through
// below-threshold edges; each group contributes one output vertex
// with the area-weighted face-normal average.
//
// Inputs:
//   • `mesh`: the CpuMesh to process. Must be triangulated. Positions
//     and UVs are forwarded verbatim onto the output's per-corner
//     duplicates; only normals (and possibly the vertex count /
//     index buffer, when corners get split) change.
//   • `cuspAngleRadians`: a face-pair whose dihedral angle is
//     STRICTLY LESS than this is smoothed. Use π (180°) to smooth
//     everything (preserve the original vertex count when topology
//     allows it); use 0 to crease every shared edge (every face's
//     three corners get the raw face normal — output has
//     `3 * faceCount` vertices).
//
// Output: a new CpuMesh with potentially more vertices than the
// input. The face count and triangle indexing are preserved 1:1 with
// the input (we never add or remove triangles — only split shared
// vertices when needed). Positions / UVs are copied from the source
// vertex they came from; only the normal differs across split copies.
//
// Edge cases handled:
//   • Boundary / non-manifold edges (twin = -1 in the half-edge
//     mesh) act as creases — no smoothing across.
//   • Degenerate faces (zero area / zero face-normal magnitude)
//     contribute zero weight to the smoothing average; they get an
//     arbitrary unit normal (+Y) in the output so the buffer stays
//     valid for shading code that doesn't tolerate NaN.
//   • Pinch vertices: a vertex incident to faces whose normals
//     happen to cancel out (e.g. two opposed coplanar fans sharing
//     a vertex) ends up with a zero-magnitude average. We fall back
//     to the first face's normal in that group.

import type { CpuMeshRef } from '../core/resources.js';
import { buildHalfEdgeMesh, faceOf, nextInFace, prevInFace } from './half-edge-mesh.js';

export interface ComputeNormalsOptions {
  /**
   * Treat vertices at coincident POSITIONS as a single topological
   * vertex when building the smoothing graph. Most Sedon primitives
   * (cube, sphere, cylinder, …) emit per-face split vertices so each
   * face can carry its own UVs — those split vertices share positions
   * but reference DIFFERENT indices, so the half-edge layer would
   * otherwise see every edge as a boundary and refuse to smooth
   * across faces. Welding by position closes that gap for topology
   * WITHOUT collapsing UVs in the output — each original vertex
   * still emits its own output vertex (so per-face UV islands are
   * preserved), the smoothed normal just becomes the same averaged
   * value across all originals at that position. Default true.
   */
  weldByPosition?: boolean;
}

export function computeNormalsWithCuspAngle(
  mesh: CpuMeshRef,
  cuspAngleRadians: number,
  options: ComputeNormalsOptions = {},
): CpuMeshRef {
  const weldByPosition = options.weldByPosition ?? true;
  // Build the topology mesh. When welding is on, remap each vertex
  // index to the LOWEST-indexed vertex at the same position — the
  // half-edge builder uses these welded indices to detect shared
  // edges. Original positions / UVs are still indexed by their
  // ORIGINAL ids for the output pass.
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

  // ── Pass 1: per-face unit normals + per-corner angle weights. ───
  // Angle weighting (Max / Blender's "Auto Smooth" convention) gives
  // each face's contribution to the averaged vertex normal a weight
  // equal to its INTERIOR ANGLE at the shared vertex. Compared to
  // area weighting, this produces symmetric results on uniform
  // primitives whose triangulation isn't symmetric — e.g. a cube
  // (whose quad diagonals send some incident faces 2 tris and
  // others 1 to the same vertex) gets the intuitive (1,1,1)/√3 at
  // each corner instead of an asymmetric ratio biased by which
  // diagonal happened to be chosen.
  const faceUnitNormals = new Float32Array(faceCount * 3);
  // cornerAngles[c] = interior angle (radians) at the vertex of the
  // c-th half-edge's corner. Used as the weight in pass 3.
  const cornerAngles = new Float32Array(halfEdgeCount);
  for (let f = 0; f < faceCount; f++) {
    const i0 = mesh.indices[f * 3]!;
    const i1 = mesh.indices[f * 3 + 1]!;
    const i2 = mesh.indices[f * 3 + 2]!;
    const ax = mesh.positions[i0 * 3]!,     ay = mesh.positions[i0 * 3 + 1]!,     az = mesh.positions[i0 * 3 + 2]!;
    const bx = mesh.positions[i1 * 3]!,     by = mesh.positions[i1 * 3 + 1]!,     bz = mesh.positions[i1 * 3 + 2]!;
    const cx = mesh.positions[i2 * 3]!,     cy = mesh.positions[i2 * 3 + 1]!,     cz = mesh.positions[i2 * 3 + 2]!;
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) {
      faceUnitNormals[f * 3]     = nx / len;
      faceUnitNormals[f * 3 + 1] = ny / len;
      faceUnitNormals[f * 3 + 2] = nz / len;
    }
    // Degenerate faces leave faceUnitNormals at (0,0,0); cusp tests
    // below treat them as "always crease" — a degenerate triangle
    // has no defensible dihedral angle, so leaving it isolated keeps
    // it from polluting neighbours' averages.

    // Per-corner interior angle: at corner k (vertex of indices[f*3+k]),
    // the angle is between the edges to the other two corners. Inlined
    // for cache friendliness.
    angleAtCorner(f * 3,     ax, ay, az,  bx, by, bz,  cx, cy, cz, cornerAngles);
    angleAtCorner(f * 3 + 1, bx, by, bz,  cx, cy, cz,  ax, ay, az, cornerAngles);
    angleAtCorner(f * 3 + 2, cx, cy, cz,  ax, ay, az,  bx, by, bz, cornerAngles);
  }

  // ── Pass 2: partition corners into smoothing groups. ─────────────
  // Each (face, corner) is a "corner" — there are `3 * faceCount`
  // of them. Two corners are in the same group iff:
  //   • they're at the same vertex, AND
  //   • there's a chain of faces between them where every traversed
  //     edge has dihedral angle < cuspAngle AND both faces have
  //     non-degenerate (unit-normal nonzero) normals.
  //
  // Implementation: BFS over corners. For each unvisited corner,
  // assign a fresh group id and walk neighbour corners via the two
  // edges incident to that corner (in-edge and out-edge). Each step
  // crosses a twin half-edge: the corresponding corner-at-v in the
  // adjacent face is reachable by composing next/prev on the twin.
  const cornerGroup = new Int32Array(halfEdgeCount);
  cornerGroup.fill(-1);
  // Precompute cos(cuspAngle) once; comparing dot(unit_a, unit_b) >
  // cosThreshold is the same as comparing the angle < cuspAngle, and
  // avoids a per-edge acos() in the inner loop.
  const cosThreshold = Math.cos(cuspAngleRadians);
  let groupCount = 0;
  const queue: number[] = [];
  for (let seedCorner = 0; seedCorner < halfEdgeCount; seedCorner++) {
    if (cornerGroup[seedCorner] !== -1) continue;
    const myGroup = groupCount++;
    cornerGroup[seedCorner] = myGroup;
    queue.length = 0;
    queue.push(seedCorner);
    while (queue.length > 0) {
      const c = queue.pop()!;
      const f = faceOf(c);
      const fux = faceUnitNormals[f * 3]!;
      const fuy = faceUnitNormals[f * 3 + 1]!;
      const fuz = faceUnitNormals[f * 3 + 2]!;
      // Degenerate face: no smoothing edges out.
      if (fux === 0 && fuy === 0 && fuz === 0) continue;
      // The two half-edges incident to v through corner c:
      //   • c itself originates at v and points away (the "outgoing"
      //     edge). Across its twin, v becomes the DESTINATION of the
      //     twin; the corner-at-v in the adjacent face is next(twin).
      //   • prev(c) originates at the previous vertex and points AT v
      //     (the "incoming" edge). Across its twin, v becomes the
      //     ORIGIN of the twin; the corner-at-v in the adjacent face
      //     is the twin itself.
      const outIncident = c;
      const inIncident = prevInFace(c);
      const tOut = half.twin[outIncident]!;
      const tIn = half.twin[inIncident]!;
      const neighbourCorners = [
        tOut < 0 ? -1 : nextInFace(tOut),
        tIn  < 0 ? -1 : tIn,
      ];
      for (const adjCorner of neighbourCorners) {
        if (adjCorner < 0) continue; // boundary / non-manifold — crease.
        if (cornerGroup[adjCorner] === myGroup) continue;
        if (cornerGroup[adjCorner] !== -1) continue; // already taken by another group
        const adjFace = faceOf(adjCorner);
        const aux = faceUnitNormals[adjFace * 3]!;
        const auy = faceUnitNormals[adjFace * 3 + 1]!;
        const auz = faceUnitNormals[adjFace * 3 + 2]!;
        if (aux === 0 && auy === 0 && auz === 0) continue; // degenerate neighbour
        const cosAngle = fux * aux + fuy * auy + fuz * auz;
        // Smooth iff angle < cuspAngle ⇔ cos(angle) > cos(cusp).
        // Equality means "exactly at the threshold" — pick crease
        // so cusp=0 reliably creases every shared edge (cos(0)=1,
        // a perfectly-coplanar pair has cos=1 ≥ 1 → CREASE).
        if (cosAngle <= cosThreshold) continue;
        cornerGroup[adjCorner] = myGroup;
        queue.push(adjCorner);
      }
    }
  }

  // ── Pass 3: per-group angle-weighted normal sum + normalise. ─────
  const groupNormals = new Float32Array(groupCount * 3);
  for (let c = 0; c < halfEdgeCount; c++) {
    const g = cornerGroup[c]!;
    const f = faceOf(c);
    const w = cornerAngles[c]!;
    const fnx = faceUnitNormals[f * 3]!     * w;
    const fny = faceUnitNormals[f * 3 + 1]! * w;
    const fnz = faceUnitNormals[f * 3 + 2]! * w;
    const gi = g * 3;
    groupNormals[gi]     = (groupNormals[gi]     ?? 0) + fnx;
    groupNormals[gi + 1] = (groupNormals[gi + 1] ?? 0) + fny;
    groupNormals[gi + 2] = (groupNormals[gi + 2] ?? 0) + fnz;
  }
  for (let g = 0; g < groupCount; g++) {
    const nx = groupNormals[g * 3]!;
    const ny = groupNormals[g * 3 + 1]!;
    const nz = groupNormals[g * 3 + 2]!;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) {
      groupNormals[g * 3]     = nx / len;
      groupNormals[g * 3 + 1] = ny / len;
      groupNormals[g * 3 + 2] = nz / len;
    } else {
      // Pinch / degenerate group — fall back to +Y so the buffer
      // stays valid. Real shading shouldn't depend on these vertices.
      groupNormals[g * 3]     = 0;
      groupNormals[g * 3 + 1] = 1;
      groupNormals[g * 3 + 2] = 0;
    }
  }

  // ── Pass 4: emit output vertices. ────────────────────────────────
  // One output vertex per UNIQUE (smoothing group, original vertex)
  // pair — NOT per group. When auto-weld is on, a single group can
  // span multiple original vertices (e.g. the cube's three per-face
  // copies of the (+h,+h,+h) corner all live in the same group at
  // cusp=180°). Each original keeps its own output vertex so its
  // UV survives; only the normal is shared across the group. When
  // weld is off (or there's nothing to weld), each group lives at a
  // single original vertex and the rule collapses to "one per group"
  // — identical to the prior behaviour.
  const vCount = mesh.positions.length / 3;
  const outputId = new Map<number, number>();
  const outIndices = new Uint32Array(halfEdgeCount);
  const outPositions: number[] = [];
  const outNormals: number[] = [];
  const outUvs: number[] = [];
  let outCount = 0;
  for (let c = 0; c < halfEdgeCount; c++) {
    const g = cornerGroup[c]!;
    const v = mesh.indices[c]!;
    // Pack (g, v) into one integer key. `g * vCount + v` is a stable
    // bijection given vCount ≥ 1 (we returned early for empty meshes).
    const key = g * vCount + v;
    let id = outputId.get(key);
    if (id === undefined) {
      id = outCount++;
      outputId.set(key, id);
      outPositions.push(
        mesh.positions[v * 3]!,
        mesh.positions[v * 3 + 1]!,
        mesh.positions[v * 3 + 2]!,
      );
      outNormals.push(
        groupNormals[g * 3]!,
        groupNormals[g * 3 + 1]!,
        groupNormals[g * 3 + 2]!,
      );
      outUvs.push(
        mesh.uvs[v * 2]     ?? 0,
        mesh.uvs[v * 2 + 1] ?? 0,
      );
    }
    outIndices[c] = id;
  }

  return {
    positions: new Float32Array(outPositions),
    normals: new Float32Array(outNormals),
    uvs: new Float32Array(outUvs),
    indices: outIndices,
  };
}

/**
 * Map each vertex to the LOWEST-indexed vertex at the same position.
 * Used by `computeNormalsWithCuspAngle` when `weldByPosition` is on:
 * the half-edge layer's connectivity is built against the welded
 * indices, but the original index buffer (and its per-vertex UVs)
 * survives into the output. Position comparison is exact-float: two
 * vertices weld iff their position bytes are identical. Procedurally-
 * generated primitives that emit split-but-coincident vertices (cube,
 * sphere, cylinder, lathe, …) hit this path; meshes whose neighbours
 * are at slightly-different floats (after a noise displacement, say)
 * stay un-welded and the caller can use a separate "merge by
 * distance" node — not implemented here.
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

/**
 * Write the interior angle at corner `cornerIdx` into `out`, given
 * the three vertex positions of the triangle (a = the corner itself,
 * b and c = the other two corners). Returns 0 on degenerate
 * (zero-length) edges — a triangle with a coincident pair of
 * vertices has no defensible angle. Inlined into the per-face loop.
 */
function angleAtCorner(
  cornerIdx: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  out: Float32Array,
): void {
  const ex = bx - ax, ey = by - ay, ez = bz - az;
  const fx = cx - ax, fy = cy - ay, fz = cz - az;
  const elen = Math.hypot(ex, ey, ez);
  const flen = Math.hypot(fx, fy, fz);
  if (elen < 1e-12 || flen < 1e-12) {
    out[cornerIdx] = 0;
    return;
  }
  let cosA = (ex * fx + ey * fy + ez * fz) / (elen * flen);
  if (cosA < -1) cosA = -1;
  else if (cosA > 1) cosA = 1;
  out[cornerIdx] = Math.acos(cosA);
}
