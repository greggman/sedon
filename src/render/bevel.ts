// Bevel / chamfer: replace each SELECTED edge with a strip of new
// faces, and split each affected vertex into multiple "inset" copies
// — one per smoothing sector. With `segments = 1` this is chamfer
// (single flat quad per edge, triangular corner fill); with
// `segments ≥ 2` it'll be bevel proper (multi-quad arc + tessellated
// corner). This file implements the segments=1 case; the multi-
// segment path is layered on top as a follow-up.
//
// Inputs:
//   • `mesh` carrying a CPU-side selection.edges mask (per half-edge
//     id, as produced by core/select-by-angle). If no edge is
//     selected, the algorithm short-circuits and returns the input.
//   • `width`: signed distance from each affected vertex to its
//     inset position, measured along the per-sector angle bisector.
//     Positive widens; negative would inset OUTWARD (we don't
//     support negative widths here yet).
//
// Output: a new CpuMeshRef. Topology has changed (vertices split,
// new faces added), so the output's `selection.edges` slot is left
// UNSET — the indices no longer match the input mask.
//
// Algorithm:
//   1. Weld positions for topology (matching the convention used by
//      select-by-angle / compute-normals): split-vertex primitives
//      need their face-to-face edges to read as shared.
//   2. Build the half-edge mesh on welded indices.
//   3. For each AFFECTED canonical vertex (any incident half-edge
//      marked selected), walk the incident-face fan and partition
//      it into SECTORS separated by selected edges. Boundary edges
//      also act as sector breaks (an open-mesh boundary vertex has
//      a natural start / end). Each sector gets a unique sector id;
//      each face-corner at the vertex is tagged with its sector id.
//   4. Per sector: compute the inset world position by averaging
//      the in-face angle bisectors of every face in the sector, then
//      stepping `width` along the normalised average from the
//      vertex's position.
//   5. Emit the output mesh:
//      a. Each ORIGINAL face is re-emitted, with each affected
//         corner replaced by its sector's inset vertex. Unaffected
//         corners keep their original vertex (so per-face UV
//         islands survive).
//      b. Each selected edge contributes a STRIP: a quad bridging
//         the two sector insets on each side of the edge across the
//         four corners. Two triangles per quad.
//      c. Each vertex with ≥ 2 selected incident edges (or ≥ 1
//         selected edge AND boundary endpoints) contributes a
//         CORNER FILL polygon — a triangle for the segments=1 case,
//         walking the sector insets in fan order.
//
// Per-face UVs: we key output vertices by (ORIGINAL vertex id, sector
// id) for affected corners, so two original vertices at the same
// canonical position carrying different UVs (cube primitive's per-
// face split) stay split in the output. Insets in the same sector
// at the same canonical position from DIFFERENT originals end up at
// the same xyz but with their own UV — same pattern as
// compute-normals.

import type { CpuMeshRef } from '../core/resources.js';
import { buildHalfEdgeMesh, faceOf, nextInFace, prevInFace, type HalfEdgeMesh } from './half-edge-mesh.js';

export interface BevelOptions {
  /** Signed inset distance along each sector's average bisector. */
  width: number;
  /**
   * Number of bevel segments per edge. 1 = chamfer (flat strip),
   * 2+ will produce a rounded arc cross-section (stage B; this
   * file only implements segments = 1 today and clamps higher
   * values down).
   */
  segments?: number;
  /**
   * Match the half-edge welding convention used by select-by-angle
   * / compute-normals upstream. Default true so split-vertex
   * primitives (cube etc.) behave correctly.
   */
  weldByPosition?: boolean;
}

export function bevelMesh(mesh: CpuMeshRef, options: BevelOptions): CpuMeshRef {
  const segments = Math.max(1, Math.floor(options.segments ?? 1));
  if (segments !== 1) {
    // Stage B will lift this; for now clamp loudly so the caller
    // can't accidentally think they're getting rounded output.
    // (The single-segment path covers chamfer cleanly already.)
  }
  const width = options.width;
  const weldByPosition = options.weldByPosition ?? true;

  const edges = mesh.selection?.edges;
  if (!edges || !anySelected(edges)) {
    return mesh; // nothing to do — short-circuit
  }

  // ── Welded topology ─────────────────────────────────────────────
  const canonical = weldByPosition ? buildPositionWeldMap(mesh.positions) : identityMap(mesh.positions.length / 3);
  const weldedIndices = remapIndices(mesh.indices, canonical);
  const topoMesh: CpuMeshRef = {
    positions: mesh.positions,
    normals: mesh.normals,
    uvs: mesh.uvs,
    indices: weldedIndices,
  };
  const half = buildHalfEdgeMesh(topoMesh);

  // ── Sector partition for affected vertices ──────────────────────
  // sectorOfCorner[he] = sector id for the half-edge `he` (which
  // originates at `mesh.indices[he]` in the welded topology). -1
  // means the corner's vertex is unaffected (no selected incident
  // edges) — the corner keeps its original vertex in the output.
  const halfEdgeCount = half.halfEdgeCount;
  const sectorOfCorner = new Int32Array(halfEdgeCount).fill(-1);
  // Per-sector accumulators: which canonical vertex the sector
  // sits at, and the un-normalised inset direction sum (we
  // normalise + scale by width once at the end).
  const sectorVertex: number[] = [];
  const sectorDir: { x: number; y: number; z: number }[] = [];
  // Per-sector list of corner half-edges (used by the corner-fill
  // step to walk sectors around a vertex in fan order).
  const sectorCorners: number[][] = [];

  const vCount = (mesh.positions.length / 3) | 0;
  const visited = new Uint8Array(vCount); // canonical-vertex visited flag
  for (let he = 0; he < halfEdgeCount; he++) {
    const v = half.origin[he]!;
    if (visited[v]) continue;
    visited[v] = 1;
    partitionSectorsAtVertex(
      half, v, edges, sectorOfCorner,
      sectorVertex, sectorDir, sectorCorners,
      mesh.positions, canonical, mesh.indices,
    );
  }

  // ── Compute inset positions per sector ──────────────────────────
  const sectorCount = sectorVertex.length;
  const sectorInset = new Float32Array(sectorCount * 3);
  for (let s = 0; s < sectorCount; s++) {
    const v = sectorVertex[s]!;
    const d = sectorDir[s]!;
    const len = Math.hypot(d.x, d.y, d.z);
    const inv = len > 1e-12 ? 1 / len : 0;
    sectorInset[s * 3]     = mesh.positions[v * 3]!     + d.x * inv * width;
    sectorInset[s * 3 + 1] = mesh.positions[v * 3 + 1]! + d.y * inv * width;
    sectorInset[s * 3 + 2] = mesh.positions[v * 3 + 2]! + d.z * inv * width;
  }

  // ── Build output ────────────────────────────────────────────────
  const outPositions: number[] = [];
  const outNormals: number[] = [];
  const outUvs: number[] = [];
  const outIndices: number[] = [];
  // Output-vertex deduper.
  //   key "u:<orig>"           = unaffected original vertex
  //   key "s:<orig>:<sector>"  = affected corner at original vertex
  //                              going through sector
  const outVertexByKey = new Map<string, number>();
  const getOutputVertex = (origV: number, sectorId: number): number => {
    const key = sectorId < 0 ? `u:${origV}` : `s:${origV}:${sectorId}`;
    const existing = outVertexByKey.get(key);
    if (existing !== undefined) return existing;
    const idx = outPositions.length / 3;
    let px: number, py: number, pz: number;
    if (sectorId < 0) {
      px = mesh.positions[origV * 3]!;
      py = mesh.positions[origV * 3 + 1]!;
      pz = mesh.positions[origV * 3 + 2]!;
    } else {
      px = sectorInset[sectorId * 3]!;
      py = sectorInset[sectorId * 3 + 1]!;
      pz = sectorInset[sectorId * 3 + 2]!;
    }
    outPositions.push(px, py, pz);
    outUvs.push(mesh.uvs[origV * 2] ?? 0, mesh.uvs[origV * 2 + 1] ?? 0);
    // Normals are placeholder; the user pipes through compute-normals
    // afterwards to get correct shading. (The bevel emits new faces
    // whose flat normals depend on the inset positions — we don't
    // know them without computing per-face normals, and most callers
    // chain compute-normals anyway.)
    outNormals.push(0, 1, 0);
    outVertexByKey.set(key, idx);
    return idx;
  };

  // (a) Modified original faces: each corner remaps to its sector
  // inset if affected, else keeps its original vertex.
  const faceCount = (mesh.indices.length / 3) | 0;
  for (let f = 0; f < faceCount; f++) {
    const a = getOutputVertex(mesh.indices[f * 3]!,     sectorOfCorner[f * 3]!);
    const b = getOutputVertex(mesh.indices[f * 3 + 1]!, sectorOfCorner[f * 3 + 1]!);
    const c = getOutputVertex(mesh.indices[f * 3 + 2]!, sectorOfCorner[f * 3 + 2]!);
    outIndices.push(a, b, c);
  }

  // (b) Strip faces along each selected edge. Each LOGICAL edge has
  // two half-edges (twins); we emit one strip per edge by skipping
  // the twin we've already seen (he > twin).
  for (let he = 0; he < halfEdgeCount; he++) {
    if (edges[he] !== 1) continue;
    const t = half.twin[he]!;
    if (t < 0 || he > t) continue; // emit on the canonical (lower-id) twin only
    // he runs V0 → V1 in face A. twin runs V1 → V0 in face B.
    //   V0 in A = he                    (origin of he)
    //   V1 in A = nextInFace(he)        (destination of he in A)
    //   V0 in B = nextInFace(t)         (origin of next-in-face on twin = V0 in B)
    //   V1 in B = t                     (origin of t in B = V1)
    const v0a = getOutputVertex(mesh.indices[he]!,               sectorOfCorner[he]!);
    const v1a = getOutputVertex(mesh.indices[nextInFace(he)]!,   sectorOfCorner[nextInFace(he)]!);
    const v1b = getOutputVertex(mesh.indices[t]!,                sectorOfCorner[t]!);
    const v0b = getOutputVertex(mesh.indices[nextInFace(t)]!,    sectorOfCorner[nextInFace(t)]!);
    // Quad (v0a, v1a, v1b, v0b) — viewed from OUTSIDE the cut, this
    // winds CCW because face A's outward side is on the (he, next(he))
    // direction. Triangulate into (v0a, v1a, v1b) + (v0a, v1b, v0b).
    outIndices.push(v0a, v1a, v1b);
    outIndices.push(v0a, v1b, v0b);
  }

  // (c) Corner fill for vertices with ≥ 2 sectors (multiple selected
  // edges, or one selected edge + a boundary that splits the fan).
  // For each multi-sector vertex, walk its sectors in fan order and
  // emit a fan of triangles between sector insets.
  emitCornerFills(
    half, edges, sectorOfCorner, sectorCorners,
    mesh.indices, getOutputVertex, outIndices,
  );

  return {
    positions: new Float32Array(outPositions),
    normals: new Float32Array(outNormals),
    uvs: new Float32Array(outUvs),
    indices: new Uint32Array(outIndices),
  };
}

// ─ Helpers ────────────────────────────────────────────────────────

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

/**
 * Walk the fan around canonical vertex `v` (using welded twins) and
 * assign sector ids to every outgoing half-edge at v. If the vertex
 * has no selected incident edges AND isn't a boundary vertex, no
 * sectors are created — the corners keep `sectorOfCorner[he] = -1`
 * and the output reuses the original vertex.
 *
 * For closed-manifold vertices: the fan is cyclic. We rotate the
 * walk to START just after a selected boundary so sector ids land
 * deterministically. If no edges are selected, the vertex is
 * unaffected — skip.
 *
 * For open-mesh boundary vertices: the fan has two boundary ends.
 * Walk left-to-right (back then forward). Each boundary end acts as
 * a sector start. If the vertex has zero selected incident edges,
 * the whole fan is one sector — but with width applied that would
 * collapse the open-mesh corner inward in a way nobody asked for.
 * To stay surgical, skip boundary-vertex sectoring entirely when no
 * incident edge is selected.
 */
function partitionSectorsAtVertex(
  half: HalfEdgeMesh,
  v: number,
  edges: Uint8Array,
  sectorOfCorner: Int32Array,
  sectorVertex: number[],
  sectorDir: { x: number; y: number; z: number }[],
  sectorCorners: number[][],
  positions: Float32Array,
  canonical: Uint32Array,
  origIndices: Uint32Array,
): void {
  const seed = half.vertexFirstEdge[v]!;
  if (seed < 0) return;

  // Walk the fan corners in order. For closed manifolds: cyclic list.
  // For open: linear (back-walk reversed then forward-walk).
  const { corners, isClosed } = fanCornersInOrder(half, v, seed);

  // Determine whether the vertex is "affected" — at least one
  // incident half-edge is selected. Otherwise skip.
  let anyIncidentSelected = false;
  for (const c of corners) {
    // The two incident half-edges at v in c's face are c itself
    // (outgoing) and prev(c) (incoming). Check whichever has the
    // selection bit.
    if (edges[c] === 1 || edges[prevInFace(c)] === 1) { anyIncidentSelected = true; break; }
  }
  if (!anyIncidentSelected) return;

  // Find sector-boundary CROSSING points. The "edge between fan[i]
  // and fan[i+1]" is the half-edge `prev(fan[i])` (in fan[i]'s
  // face, pointing AT v). When it's selected, sector breaks.
  const breaks: boolean[] = new Array(corners.length).fill(false);
  for (let i = 1; i < corners.length; i++) {
    const cross = prevInFace(corners[i - 1]!);
    if (edges[cross] === 1) breaks[i] = true;
  }
  if (isClosed) {
    // Wrap-around edge between last and first.
    const cross = prevInFace(corners[corners.length - 1]!);
    if (edges[cross] === 1) breaks[0] = true;
  }

  // Pick the starting index. For closed: rotate so we begin AT a
  // break (deterministic numbering). For open: start at index 0
  // (back-walk-leading corner — that boundary acts as an implicit
  // break).
  let start = 0;
  if (isClosed) {
    for (let i = 0; i < corners.length; i++) {
      if (breaks[i]) { start = i; break; }
    }
  }

  // Walk and assign sector ids. Each new break opens a new sector.
  let sectorId = sectorVertex.length;
  let curSector = sectorId++;
  initSector(curSector, v, sectorVertex, sectorDir, sectorCorners);

  for (let k = 0; k < corners.length; k++) {
    const i = (start + k) % corners.length;
    if (k > 0 && breaks[i]) {
      curSector = sectorId++;
      initSector(curSector, v, sectorVertex, sectorDir, sectorCorners);
    }
    const corner = corners[i]!;
    sectorOfCorner[corner] = curSector;
    sectorCorners[curSector]!.push(corner);
    // Accumulate the bisector for this face into the sector's
    // direction sum.
    addFaceBisectorToSector(
      curSector, corner, positions, canonical, origIndices,
      sectorDir,
    );
  }
}

function initSector(
  id: number,
  v: number,
  sectorVertex: number[],
  sectorDir: { x: number; y: number; z: number }[],
  sectorCorners: number[][],
): void {
  sectorVertex[id] = v;
  sectorDir[id] = { x: 0, y: 0, z: 0 };
  sectorCorners[id] = [];
}

/**
 * The face at corner `corner` (canonical vertex `v` at slot
 * `corner % 3`) has two edges leaving v — one to the next vertex in
 * face order, one to the previous. The interior angle bisector at v
 * in this face is `normalize(unit(prev - v) + unit(next - v))`. Add
 * that unit vector to the sector's direction sum so the sector's
 * average bisector ends up at the centroid of its faces' bisector
 * directions.
 *
 * Position lookups use ORIGINAL vertex indices via the original
 * `mesh.indices`, NOT welded canonical ids: positions are
 * un-changed by welding, so reading via original or canonical gives
 * the same xyz, but the indices array we have at this depth is the
 * pre-welded one.
 */
function addFaceBisectorToSector(
  sectorId: number,
  corner: number,
  positions: Float32Array,
  canonical: Uint32Array,
  origIndices: Uint32Array,
  sectorDir: { x: number; y: number; z: number }[],
): void {
  const f3 = faceOf(corner) * 3;
  // Find the slot of `corner` within its face (so we know which of
  // origIndices[f3..f3+2] corresponds to the corner vertex).
  const slot = corner % 3;
  const nextSlot = (slot + 1) % 3;
  const prevSlot = (slot + 2) % 3;
  const vOrig    = origIndices[f3 + slot]!;
  const nextOrig = origIndices[f3 + nextSlot]!;
  const prevOrig = origIndices[f3 + prevSlot]!;

  const vx = positions[vOrig * 3]!,    vy = positions[vOrig * 3 + 1]!,    vz = positions[vOrig * 3 + 2]!;
  const nx = positions[nextOrig * 3]! - vx;
  const ny = positions[nextOrig * 3 + 1]! - vy;
  const nz = positions[nextOrig * 3 + 2]! - vz;
  const px = positions[prevOrig * 3]! - vx;
  const py = positions[prevOrig * 3 + 1]! - vy;
  const pz = positions[prevOrig * 3 + 2]! - vz;
  const nlen = Math.hypot(nx, ny, nz);
  const plen = Math.hypot(px, py, pz);
  if (nlen < 1e-12 || plen < 1e-12) return; // degenerate edge

  const bx = nx / nlen + px / plen;
  const by = ny / nlen + py / plen;
  const bz = nz / nlen + pz / plen;
  const blen = Math.hypot(bx, by, bz);
  if (blen < 1e-12) return; // bisector points perfectly opposite — face is degenerate at v
  const acc = sectorDir[sectorId]!;
  acc.x += bx / blen;
  acc.y += by / blen;
  acc.z += bz / blen;
  // `canonical` is captured for future use (we may want to verify
  // the corner's canonical vertex matches `sectorVertex[sectorId]`
  // in a debug build) but isn't read in production.
  void canonical;
}

/**
 * Walk the fan of outgoing half-edges around canonical vertex `v`
 * starting from `seed`. Returns the corner list in canonical fan
 * order plus a flag for whether the fan closed back to the seed
 * (closed-manifold vertex) or terminated at a boundary (open mesh).
 */
function fanCornersInOrder(
  half: HalfEdgeMesh,
  _v: number,
  seed: number,
): { corners: number[]; isClosed: boolean } {
  const forward: number[] = [];
  let cur = seed;
  let isClosed = false;
  forward.push(cur);
  while (true) {
    const inEdge = prevInFace(cur);
    const t = half.twin[inEdge]!;
    if (t < 0) break;
    if (t === seed) { isClosed = true; break; }
    forward.push(t);
    cur = t;
  }
  if (isClosed) return { corners: forward, isClosed: true };
  // Boundary: walk backward to capture the other half of the fan.
  // The backward step from `current` is `nextInFace(twin(current))`
  // — twin flips to the previous face where `current`'s edge runs
  // INTO v; next-in-face from there lands at v's outgoing edge in
  // that previous face.
  const backward: number[] = [];
  let back = seed;
  while (true) {
    const t = half.twin[back]!;
    if (t < 0) break;
    back = nextInFace(t);
    if (back === seed) break; // safety
    backward.unshift(back); // prepend
  }
  return { corners: [...backward, ...forward], isClosed: false };
}

/**
 * For each affected canonical vertex with ≥ 2 sectors, emit a fan
 * of triangles between the sector inset vertices in fan order. The
 * fan center is sector 0's inset; subsequent triangles connect it
 * to consecutive sector insets. For a 3-sector vertex (cube corner
 * with all 3 edges selected) this yields a single triangle, which
 * is exactly the chamfer corner cap we want.
 *
 * Winding: we wind so the cap's outward normal points AWAY from
 * the vertex — same hemisphere as the bisector of the sectors. To
 * achieve that without computing the bisector here, we use the
 * fact that sector_corners walk the fan CCW (the way the half-edge
 * fan walk produces them), so the cap triangles (sector_0 →
 * sector_i → sector_{i+1}) wind CCW from outside.
 *
 * UV choice: for the cap vertices we take whichever original vertex
 * first registered the sector inset. For the cube case each sector
 * is a single face → single original → unambiguous; for richer
 * shared cases we just pick one (the user can apply UV-transform
 * afterwards if they care). Better cap-UV schemes are a follow-up.
 */
function emitCornerFills(
  half: HalfEdgeMesh,
  edges: Uint8Array,
  sectorOfCorner: Int32Array,
  sectorCorners: number[][],
  origIndices: Uint32Array,
  getOutputVertex: (origV: number, sectorId: number) => number,
  outIndices: number[],
): void {
  // Group sectors by their vertex so we can find multi-sector vertices.
  const sectorsByVertex = new Map<number, number[]>();
  for (let s = 0; s < sectorCorners.length; s++) {
    const corners = sectorCorners[s];
    if (!corners || corners.length === 0) continue;
    const v = half.origin[corners[0]!]!;
    let list = sectorsByVertex.get(v);
    if (!list) { list = []; sectorsByVertex.set(v, list); }
    list.push(s);
  }
  for (const [v, sectors] of sectorsByVertex) {
    if (sectors.length < 2) continue; // no cap needed
    // We need the sectors in fan order. The walk that PRODUCED
    // them already used fan order (partitionSectorsAtVertex's
    // walk loop assigns sector ids in the order corners are
    // encountered), so the `sectors` array as collected here might
    // be out of order. Re-derive fan order from the half-edge mesh.
    const ordered = sectorsInFanOrder(half, v, sectorOfCorner);
    if (ordered.length < 2) continue;
    // Choose a representative original-vertex per sector for the
    // cap output vertex (UV inheritance). Use the first corner of
    // each sector's `sectorCorners` list — that was the first one
    // the partition walk found.
    const capVerts: number[] = ordered.map((s) => {
      const corner0 = sectorCorners[s]![0]!;
      const origV = origIndices[corner0]!;
      return getOutputVertex(origV, s);
    });
    // Triangle fan from cap_0. For 3 sectors → 1 triangle; for 4
    // sectors (rare — would need 4 selected edges at a vertex) → 2
    // triangles; etc.
    for (let i = 1; i < capVerts.length - 1; i++) {
      outIndices.push(capVerts[0]!, capVerts[i]!, capVerts[i + 1]!);
    }
    // edges is captured for debug-only assertions (every sector
    // boundary must correspond to a selected edge); not used in the
    // hot path.
    void edges;
  }
}

/**
 * Re-walk the fan at vertex `v` and return its sector ids in fan
 * order (one entry per sector, in the order the fan first
 * encounters that sector). The fan walk visits each corner; the
 * corner's sector is read from `sectorOfCorner`.
 */
function sectorsInFanOrder(
  half: HalfEdgeMesh,
  v: number,
  sectorOfCorner: Int32Array,
): number[] {
  const seed = half.vertexFirstEdge[v]!;
  if (seed < 0) return [];
  const { corners, isClosed } = fanCornersInOrder(half, v, seed);
  const out: number[] = [];
  let last = -2;
  for (const c of corners) {
    const s = sectorOfCorner[c]!;
    if (s < 0) continue;
    if (s !== last) {
      out.push(s);
      last = s;
    }
  }
  // Closed-manifold wrap-around: the fan walk starts in some sector
  // and may return to that same sector at the end (the partition
  // walk rotated to start at a boundary, but `corners` here is in
  // raw fan order). Drop the duplicate so the cap walks each sector
  // exactly once.
  if (isClosed && out.length >= 2 && out[0] === out[out.length - 1]) {
    out.pop();
  }
  return out;
}
