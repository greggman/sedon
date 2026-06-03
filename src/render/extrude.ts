// Face extrude: push a face-selection cluster along its average
// normal, leaving wall quads connecting the offset cap back to the
// surrounding (unchanged) mesh.
//
// Two CONVENTIONS from the bevel work carry over:
//
//   1. Each emission "surface type" (offset-face / wall / unchanged
//      pass-through) emits its OWN vertex copies — no sharing across
//      surfaces. Per-vertex normals stay locally consistent with the
//      triangle they belong to; the rim where a wall meets the
//      offset cap is naturally a sharp crease (two copies of the
//      same position, different normals). Downstream `bevel` rounds
//      that crease when invited.
//
//   2. The output `selection.faces` marks the OFFSET CAP, and
//      `selection.edges` marks the rim edges between the cap and
//      the walls. Both directions of each rim edge are marked
//      (selection mask convention from `CpuMeshRef.selection`).
//      Other selection slots are dropped.
//
// Single-face / multi-face / multi-cluster all share the same path:
// union-find groups adjacent selected triangles, then each cluster
// is duplicated + walled independently.

import type { CpuMeshRef, MeshSelection } from '../core/resources.js';
import { buildHalfEdgeMesh, faceOf, nextInFace, prevInFace } from './half-edge-mesh.js';

export interface ExtrudeOptions {
  /**
   * Signed distance along the cluster's average outward normal.
   * Positive = protrude away from the mesh interior. Negative = recess
   * into the mesh. Zero is allowed and emits degenerate zero-thickness
   * walls — consistent and predictable; downstream nodes that care
   * can detect it.
   */
  offset: number;
  /**
   * Treat coincident-position vertices as a single topological
   * vertex when building the half-edge mesh used for the cluster +
   * boundary walk. Default true; matches select-by-angle /
   * select-by-normal / bevel.
   */
  weldByPosition?: boolean;
}

export function extrudeMesh(mesh: CpuMeshRef, options: ExtrudeOptions): CpuMeshRef {
  const faceMask = mesh.selection?.faces;
  if (!faceMask || !anySelected(faceMask)) return mesh;
  const offset = options.offset;
  const weldByPosition = options.weldByPosition ?? true;

  // Welded topology — same trick as bevel.ts. Lets `buildHalfEdgeMesh`
  // see split-vertex primitives (cube/sphere/lathe) as a closed mesh.
  const canonical = weldByPosition
    ? buildPositionWeldMap(mesh.positions)
    : identityMap((mesh.positions.length / 3) | 0);
  const weldedIndices = remapIndices(mesh.indices, canonical);
  const topo = { positions: mesh.positions, normals: mesh.normals, uvs: mesh.uvs, indices: weldedIndices };
  const half = buildHalfEdgeMesh(topo);

  // ── Cluster selected tris by shared edges ──────────────────────
  // Adjacent selected tris merge — their shared edge is INTERIOR to
  // the cluster and gets no wall. Non-shared selected edges are the
  // cluster BOUNDARY and get walled.
  const faceCount = (mesh.indices.length / 3) | 0;
  const parent = new Int32Array(faceCount);
  for (let f = 0; f < faceCount; f++) parent[f] = f;
  function find(f: number): number {
    while (parent[f]! !== f) { parent[f] = parent[parent[f]!]!; f = parent[f]!; }
    return f;
  }
  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (let he = 0; he < half.halfEdgeCount; he++) {
    const f = faceOf(he);
    if (faceMask[f] !== 1) continue;
    const t = half.twin[he]!;
    if (t < 0) continue;
    const f2 = faceOf(t);
    if (faceMask[f2] !== 1) continue;
    if (he < t) union(f, f2); // skip duplicate work; pair visited once
  }

  // Bucket selected tris by cluster root.
  const clusterMembers = new Map<number, number[]>();
  for (let f = 0; f < faceCount; f++) {
    if (faceMask[f] !== 1) continue;
    const root = find(f);
    const arr = clusterMembers.get(root);
    if (arr) arr.push(f);
    else clusterMembers.set(root, [f]);
  }

  // ── Output accumulators ────────────────────────────────────────
  const outPositions: number[] = [];
  const outNormals: number[] = [];
  const outUvs: number[] = [];
  const outIndices: number[] = [];
  // Per-output-face flag: 1 = offset cap (mark in selection.faces).
  // Wall faces and pass-through faces stay 0.
  const outFaceIsOffset: number[] = [];
  // Pairs of OUTPUT vertex indices for rim half-edges (cap ↔ wall
  // boundary). Stored sorted (min, max) so a single Set lookup
  // matches both directions after the half-edge mesh is rebuilt.
  const rimPairs = new Set<string>();

  function emitTri(i0: number, i1: number, i2: number, isOffset: boolean): void {
    outIndices.push(i0, i1, i2);
    outFaceIsOffset.push(isOffset ? 1 : 0);
  }

  // 1. Pass-through tris (unselected). Keep their indices into the
  // ORIGINAL vertex buffer; pass-through verts will get copied
  // verbatim below so input normals/UVs survive on unaffected
  // geometry.
  for (let f = 0; f < faceCount; f++) {
    if (faceMask[f] === 1) continue;
    const i0 = mesh.indices[f * 3]!, i1 = mesh.indices[f * 3 + 1]!, i2 = mesh.indices[f * 3 + 2]!;
    emitTri(i0, i1, i2, false);
  }
  // Copy ALL input verts verbatim into output. Pass-through tris
  // reference them directly. New clusters allocate fresh output
  // verts past this base block.
  for (let i = 0; i < mesh.positions.length; i++) outPositions.push(mesh.positions[i]!);
  for (let i = 0; i < mesh.normals.length; i++) outNormals.push(mesh.normals[i]!);
  for (let i = 0; i < mesh.uvs.length; i++) outUvs.push(mesh.uvs[i]!);

  // 2. Per-cluster: emit offset cap + walls.
  for (const [, members] of clusterMembers) {
    // Cluster normal = area-weighted sum of member tri normals,
    // then normalized. Falls back to (0, 1, 0) if the cluster has
    // zero area (degenerate input; nothing reasonable to do).
    let cnx = 0, cny = 0, cnz = 0;
    for (const f of members) {
      const i0 = mesh.indices[f * 3]!, i1 = mesh.indices[f * 3 + 1]!, i2 = mesh.indices[f * 3 + 2]!;
      const ax = mesh.positions[i0 * 3]!, ay = mesh.positions[i0 * 3 + 1]!, az = mesh.positions[i0 * 3 + 2]!;
      const bx = mesh.positions[i1 * 3]!, by = mesh.positions[i1 * 3 + 1]!, bz = mesh.positions[i1 * 3 + 2]!;
      const cx = mesh.positions[i2 * 3]!, cy = mesh.positions[i2 * 3 + 1]!, cz = mesh.positions[i2 * 3 + 2]!;
      const ex = bx - ax, ey = by - ay, ez = bz - az;
      const fx = cx - ax, fy = cy - ay, fz = cz - az;
      cnx += ey * fz - ez * fy;
      cny += ez * fx - ex * fz;
      cnz += ex * fy - ey * fx;
    }
    {
      const len = Math.hypot(cnx, cny, cnz);
      if (len > 1e-12) { cnx /= len; cny /= len; cnz /= len; }
      else { cnx = 0; cny = 1; cnz = 0; }
    }
    const ox = offset * cnx, oy = offset * cny, oz = offset * cnz;

    // Emit fresh OFFSET verts — one per unique ORIGINAL vertex used
    // by the cluster. Position = orig + cluster_normal·offset.
    // Normal = cluster_normal (flat shading on the offset cap).
    // UV = original vertex's UV (preserves the source face's UV
    // mapping into the cap).
    const offsetVertOf = new Map<number, number>();
    for (const f of members) {
      for (let k = 0; k < 3; k++) {
        const origV = mesh.indices[f * 3 + k]!;
        if (offsetVertOf.has(origV)) continue;
        const idx = outPositions.length / 3;
        outPositions.push(
          mesh.positions[origV * 3]!     + ox,
          mesh.positions[origV * 3 + 1]! + oy,
          mesh.positions[origV * 3 + 2]! + oz,
        );
        outNormals.push(cnx, cny, cnz);
        outUvs.push(mesh.uvs[origV * 2] ?? 0, mesh.uvs[origV * 2 + 1] ?? 0);
        offsetVertOf.set(origV, idx);
      }
    }

    // Offset cap tris (same winding as originals — the cluster
    // normal is the cross of the originals' winding, so duplicating
    // verts at the same indices produces a triangle facing the same
    // way as the source).
    for (const f of members) {
      const i0 = mesh.indices[f * 3]!, i1 = mesh.indices[f * 3 + 1]!, i2 = mesh.indices[f * 3 + 2]!;
      emitTri(offsetVertOf.get(i0)!, offsetVertOf.get(i1)!, offsetVertOf.get(i2)!, true);
    }

    // ── Walls: walk THIS cluster's boundary half-edges and emit
    // one quad (2 tris) per boundary edge. For each boundary edge
    // a→b in WELDED indices (cluster CCW from outside =
    // cluster_normal side), the wall quad has corners {a, b, b', a'}
    // where ' is the offset copy. CCW order from OUTSIDE the wall
    // (cross of boundary direction with cluster_normal) is
    // (a, b, b', a'), split into tris (a, b, b') and (a, b', a').
    //
    // Iterate THIS cluster's members directly — iterating all
    // half-edges would re-emit walls for OTHER clusters during
    // every cluster's loop body (single-cluster cases hid the bug).
    const clusterRoot = find(members[0]!);
    for (const f of members) {
      for (let k = 0; k < 3; k++) {
        const he = f * 3 + k;
      const t = half.twin[he]!;
      // Boundary half-edge: twin is missing (open mesh) OR twin's
      // face isn't in THIS cluster (interior diagonals to another
      // selected tri of the same cluster get no wall; another
      // cluster's tri across an open seam still counts as
      // boundary because each cluster is offset independently).
      if (t >= 0 && faceMask[faceOf(t)] === 1 && find(faceOf(t)) === clusterRoot) continue;

      // ORIGINAL indices for the boundary edge endpoints — we want
      // ORIG (not welded) here so wall-base UVs match the source
      // face's per-corner UVs. Welded indices may differ on split-
      // vertex primitives.
      const aOrig = mesh.indices[he]!;
      const bOrig = mesh.indices[nextInFace(he)]!;
      const ax = mesh.positions[aOrig * 3]!, ay = mesh.positions[aOrig * 3 + 1]!, az = mesh.positions[aOrig * 3 + 2]!;
      const bx = mesh.positions[bOrig * 3]!, by = mesh.positions[bOrig * 3 + 1]!, bz = mesh.positions[bOrig * 3 + 2]!;

      // Wall outward normal = (b - a) × cluster_normal, normalised.
      // For a CCW cluster boundary walked in CCW order, this points
      // away from the cluster interior.
      const ex = bx - ax, ey = by - ay, ez = bz - az;
      let wnx = ey * cnz - ez * cny;
      let wny = ez * cnx - ex * cnz;
      let wnz = ex * cny - ey * cnx;
      const wlen = Math.hypot(wnx, wny, wnz);
      if (wlen > 1e-12) { wnx /= wlen; wny /= wlen; wnz /= wlen; }
      else { wnx = 0; wny = 1; wnz = 0; }

      // Emit 4 fresh wall verts (a_base, b_base, b_top, a_top).
      // Bases share position with `aOrig`/`bOrig` but carry the
      // wall normal (which differs from input normals at the same
      // position — by design, the wall meets the unchanged
      // surrounding face at a sharp crease). UVs are quick-and-
      // dirty: u inherited from boundary edge endpoint, v = 0 at
      // base / 1 at top.
      const auU = mesh.uvs[aOrig * 2]     ?? 0;
      const buU = mesh.uvs[bOrig * 2]     ?? 0;
      const aBaseIdx = outPositions.length / 3;
      outPositions.push(ax, ay, az);
      outNormals.push(wnx, wny, wnz);
      outUvs.push(auU, 0);
      const bBaseIdx = outPositions.length / 3;
      outPositions.push(bx, by, bz);
      outNormals.push(wnx, wny, wnz);
      outUvs.push(buU, 0);
      const bTopIdx = outPositions.length / 3;
      outPositions.push(bx + ox, by + oy, bz + oz);
      outNormals.push(wnx, wny, wnz);
      outUvs.push(buU, 1);
      const aTopIdx = outPositions.length / 3;
      outPositions.push(ax + ox, ay + oy, az + oz);
      outNormals.push(wnx, wny, wnz);
      outUvs.push(auU, 1);

      emitTri(aBaseIdx, bBaseIdx, bTopIdx, false);
      emitTri(aBaseIdx, bTopIdx, aTopIdx, false);

      // Rim edge = (bTop, aTop) — shared with the offset cap. The
      // cap's matching half-edge sits between the same two POSITIONS
      // but on different vertex copies (offsetVertOf[aOrig] and
      // offsetVertOf[bOrig]). Record BOTH pairs so the post-pass
      // marks all four half-edges (wall side + cap side, both
      // directions of each).
      const apIdx = offsetVertOf.get(aOrig)!;
      const bpIdx = offsetVertOf.get(bOrig)!;
      rimPairs.add(pairKey(aTopIdx, bTopIdx));
      rimPairs.add(pairKey(apIdx, bpIdx));
      }
    }
  }

  // ── Build the selection masks ──────────────────────────────────
  const outFaces = new Uint8Array(outIndices.length / 3);
  for (let i = 0; i < outFaceIsOffset.length; i++) outFaces[i] = outFaceIsOffset[i]!;

  // selection.edges: rebuild the output half-edge mesh, walk every
  // half-edge, mark the ones whose endpoint pair sits in `rimPairs`.
  // Iterating all half-edges (O(F)) is cheap relative to the
  // mesh-level work above.
  const outMesh: CpuMeshRef = {
    positions: new Float32Array(outPositions),
    normals: new Float32Array(outNormals),
    uvs: new Float32Array(outUvs),
    indices: new Uint32Array(outIndices),
  };
  const outHalf = buildHalfEdgeMesh({
    positions: outMesh.positions,
    normals: outMesh.normals,
    uvs: outMesh.uvs,
    indices: remapIndices(outMesh.indices, buildPositionWeldMap(outMesh.positions)),
  });
  const outEdges = new Uint8Array(outHalf.halfEdgeCount);
  for (let he = 0; he < outHalf.halfEdgeCount; he++) {
    const o = outHalf.origin[he]!;
    const d = outHalf.origin[nextInFace(he)]!;
    if (rimPairs.has(pairKey(o, d))) outEdges[he] = 1;
  }
  // prevInFace stays imported so a future stride-by-stride walk
  // doesn't need to re-derive it; reference it once so eslint
  // doesn't complain about an unused import.
  void prevInFace;

  const selection: MeshSelection = { faces: outFaces, edges: outEdges };

  return {
    positions: outMesh.positions,
    normals: outMesh.normals,
    uvs: outMesh.uvs,
    indices: outMesh.indices,
    selection,
  };
}

// ── helpers ───────────────────────────────────────────────────────

function anySelected(mask: Uint8Array): boolean {
  for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) return true;
  return false;
}

function identityMap(n: number): Uint32Array {
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

function buildPositionWeldMap(positions: Float32Array): Uint32Array {
  const n = (positions.length / 3) | 0;
  const map = new Uint32Array(n);
  const seen = new Map<string, number>();
  for (let v = 0; v < n; v++) {
    const k = `${positions[v * 3]!},${positions[v * 3 + 1]!},${positions[v * 3 + 2]!}`;
    const existing = seen.get(k);
    if (existing === undefined) { seen.set(k, v); map[v] = v; }
    else map[v] = existing;
  }
  return map;
}

function remapIndices(indices: Uint32Array, canonical: Uint32Array): Uint32Array {
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) out[i] = canonical[indices[i]!]!;
  return out;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
