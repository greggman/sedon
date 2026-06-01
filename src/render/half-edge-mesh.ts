// Half-edge connectivity for triangle meshes. Foundation for any node
// that needs adjacency — bevel / chamfer / cusp-angle normals /
// subdivision / loop-cut / edge-split / smooth. Built lazily on
// demand from a CpuMesh's `indices` (positions aren't needed to build
// the topology, only to query angles + offsets later).
//
// Data layout (typed arrays for cache friendliness; everything is
// indexable by half-edge id, vertex id, or face id):
//
//   • Half-edges are numbered 0..3F-1 for F triangle faces. Half-edge
//     `i` belongs to face `i / 3`; `next(i)` and `prev(i)` cycle
//     within its face and don't need storage — they're derivable
//     from the index. So we only store:
//
//       origin[i]  = the vertex this half-edge ORIGINATES at.
//                    Equal to `indices[i]` (we just alias the slice
//                    to keep the API self-contained).
//       twin[i]    = the paired half-edge on the opposite face, or
//                    -1 if this side of the edge is a boundary
//                    (manifold mesh with holes) or non-manifold (3+
//                    incident faces or inconsistent winding).
//
//   • Per-vertex lookup: `vertexFirstEdge[v]` returns ANY outgoing
//     half-edge that originates at v, or -1 if v is isolated (no
//     face references it). Used as the seed for a vertex-fan walk;
//     callers that need the full incident-edge set iterate
//     outgoingFan(v).
//
// Manifold policy: for each undirected edge {a, b}, the builder
// expects exactly two opposite-direction half-edges (the canonical
// manifold case) OR exactly one half-edge (a boundary edge — open
// mesh). Anything else — 3+ faces sharing an edge, two faces with
// the SAME winding (which would imply a klein-bottle-like surface
// or just a modelling error) — gets its twins set to -1 with a
// counter incremented for diagnostics. Downstream ops that hate
// non-manifold input (bevel) can refuse early; ops that don't
// (compute-normals) just treat those edges as boundaries.
//
// Edge case: degenerate triangles (two indices equal) produce a
// zero-length half-edge. We treat those as boundaries — they'd
// match anything in the edge map and confuse the manifold pairing.
// Compute-normals would also produce garbage on zero-area faces, so
// flagging them is fine.

import type { CpuMeshRef } from '../core/resources.js';

export interface HalfEdgeMesh {
  /** Number of vertices addressable by `origin` / `vertexFirstEdge`. */
  vertexCount: number;
  /** Number of triangular faces. `halfEdgeCount === faceCount * 3`. */
  faceCount: number;
  /** Total half-edges (always 3 * faceCount for triangle meshes). */
  halfEdgeCount: number;

  /**
   * For each half-edge `i`, the vertex index it ORIGINATES at. This
   * is conceptually a slice of the source mesh's `indices` but is
   * kept as its own typed array so callers can keep the half-edge
   * mesh alive independent of the source mesh's lifetime. Use
   * `destination(mesh, i)` to get the vertex it points TO.
   */
  origin: Int32Array;
  /**
   * For each half-edge `i`, the paired half-edge across the shared
   * edge — or -1 if `i` sits on a boundary edge / a non-manifold
   * edge / a degenerate face. Boundary callers should always treat
   * `-1` as "no twin," never index `origin[-1]`.
   */
  twin: Int32Array;
  /**
   * For each vertex `v`, ONE outgoing half-edge (`origin[edge] === v`)
   * or -1 when the vertex is referenced by no face. Used as the seed
   * for `outgoingFan` — to enumerate all edges at v, walk via twins
   * + prev (see `outgoingFan` below).
   */
  vertexFirstEdge: Int32Array;

  /**
   * Number of edges that appeared on exactly ONE face (open-mesh
   * boundary). Each such edge contributes one boundary half-edge.
   * Closed manifold meshes have `boundaryEdgeCount === 0`.
   */
  boundaryEdgeCount: number;
  /**
   * Number of edges that appeared on 3+ faces — the "non-manifold"
   * case. Includes inconsistent-winding pairs (two faces sharing
   * an edge with the SAME winding, which means one face is flipped
   * relative to the other). All half-edges on such an edge have
   * `twin === -1`.
   */
  nonManifoldEdgeCount: number;
  /**
   * Number of degenerate faces (any pair of vertex indices equal in
   * the triangle's three corners). Their half-edges all have
   * `twin === -1`.
   */
  degenerateFaceCount: number;
}

/** Face index containing half-edge `he`. */
export function faceOf(he: number): number {
  return (he / 3) | 0;
}

/** Next half-edge within the same face (cycles 3 → 4 → 5 → 3 within face 1). */
export function nextInFace(he: number): number {
  return he % 3 === 2 ? he - 2 : he + 1;
}

/** Previous half-edge within the same face. */
export function prevInFace(he: number): number {
  return he % 3 === 0 ? he + 2 : he - 1;
}

/**
 * Destination vertex of half-edge `he`. For a triangle face, this is
 * the origin of the NEXT half-edge in that face. Returns -1 if `he`
 * is out of range (defensive — callers should already be passing
 * valid ids).
 */
export function destination(mesh: HalfEdgeMesh, he: number): number {
  if (he < 0 || he >= mesh.halfEdgeCount) return -1;
  return mesh.origin[nextInFace(he)]!;
}

/**
 * Iterate all OUTGOING half-edges at vertex `v` in CCW order around
 * v (for a manifold neighbourhood). For closed manifolds this
 * enumerates every incident edge exactly once. For OPEN meshes
 * (vertices on a boundary) it only yields the outgoing direction
 * of each incident edge — a boundary edge whose only half-edge is
 * INCOMING to v (i.e. v is the destination, not the origin) is NOT
 * yielded. That's intentional: "iterate every edge once" is best
 * done by walking the global half-edge array and emitting one of
 * each {min,max} pair, not by gluing every per-vertex fan back
 * together. Use this fan when you actually need v-centric data
 * (one-ring neighbour positions, cusp-angle weighting, …).
 *
 * Implementation: start at `vertexFirstEdge[v]`. The next outgoing
 * edge from v is `twin(prev(current))` — `prev` walks backward in
 * the current face to the edge POINTING AT v, and `twin` jumps to
 * the adjacent face where that edge now ORIGINATES at v. Loops
 * back to the seed in the closed-manifold case; for open-mesh
 * boundary vertices the forward walk stops at the boundary then a
 * backward walk picks up the CW half of the fan from the seed.
 */
export function* outgoingFan(mesh: HalfEdgeMesh, v: number): Generator<number> {
  if (v < 0 || v >= mesh.vertexCount) return;
  const seed = mesh.vertexFirstEdge[v]!;
  if (seed < 0) return;
  let cur = seed;
  // Forward walk: keep yielding while we can hop via twin(prev(cur)).
  while (true) {
    yield cur;
    const inEdge = prevInFace(cur);     // edge pointing AT v
    const t = mesh.twin[inEdge]!;        // jump to adjacent face
    if (t < 0) break;                   // boundary — break to backward walk
    if (t === seed) return;             // closed manifold — fan is complete
    cur = t;
  }
  // Reach here only via boundary break. The forward walk captured
  // only the CCW half of the fan from the seed; the CW half lives
  // on the other side, reached by stepping twin(seed)→next. Walk
  // backward until we hit the other boundary (open mesh) or, for
  // safety, the seed again (shouldn't happen given the forward walk
  // already broke at a boundary, but the explicit check keeps us
  // out of infinite loops if the input topology is corrupt).
  let back = seed;
  while (true) {
    const t = mesh.twin[back]!;
    if (t < 0) return;                  // boundary on the other side too
    back = nextInFace(t);
    if (back === seed) return;          // safety stop
    yield back;
  }
}

/**
 * Build a half-edge connectivity layer from a `CpuMeshRef`. The
 * source mesh must be triangulated: `indices.length` must be a
 * multiple of 3 (we treat it as such; any tail is silently
 * truncated). Vertex count is inferred from `positions.length / 3`
 * so isolated vertices (no face references them) are still
 * addressable — they get `vertexFirstEdge[v] === -1`.
 */
export function buildHalfEdgeMesh(mesh: CpuMeshRef): HalfEdgeMesh {
  const vertexCount = (mesh.positions.length / 3) | 0;
  const faceCount = (mesh.indices.length / 3) | 0;
  const halfEdgeCount = faceCount * 3;

  // origin[i] is the vertex this half-edge starts at. For face f and
  // corner k in {0,1,2}, half-edge id = f*3 + k, and the directed
  // edge runs from indices[f*3+k] to indices[f*3+(k+1)%3]. So
  // origin is literally indices truncated to halfEdgeCount.
  const origin = new Int32Array(halfEdgeCount);
  for (let i = 0; i < halfEdgeCount; i++) origin[i] = mesh.indices[i]!;

  const twin = new Int32Array(halfEdgeCount);
  twin.fill(-1);

  // Pass 1: detect degenerate faces (any two corners equal). Their
  // half-edges stay twin = -1 so they can never accidentally pair
  // with anything else. Count them for diagnostics.
  let degenerateFaceCount = 0;
  const degenerate = new Uint8Array(faceCount);
  for (let f = 0; f < faceCount; f++) {
    const a = mesh.indices[f * 3]!;
    const b = mesh.indices[f * 3 + 1]!;
    const c = mesh.indices[f * 3 + 2]!;
    if (a === b || b === c || a === c) {
      degenerate[f] = 1;
      degenerateFaceCount++;
    }
  }

  // Pass 2: group half-edges by their UNDIRECTED endpoint pair so we
  // can pair up twins. The key is `min*vertexCount + max` (a stable
  // bijection between {a,b} pairs and integers, given a vertexCount
  // upper bound). We push half-edge ids into per-key lists.
  const buckets = new Map<number, number[]>();
  for (let he = 0; he < halfEdgeCount; he++) {
    if (degenerate[faceOf(he)]) continue;
    const v0 = origin[he]!;
    const v1 = origin[nextInFace(he)]!;
    const lo = v0 < v1 ? v0 : v1;
    const hi = v0 < v1 ? v1 : v0;
    const key = lo * vertexCount + hi;
    const list = buckets.get(key);
    if (list) list.push(he);
    else buckets.set(key, [he]);
  }

  // Pass 3: resolve each bucket into either a manifold pair, a
  // boundary edge, or a non-manifold edge. Bump counters for
  // downstream diagnostics.
  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  for (const list of buckets.values()) {
    if (list.length === 1) {
      // Boundary edge — only one face touches it. Half-edge keeps
      // twin = -1 (already initialised), no work to do.
      boundaryEdgeCount++;
      continue;
    }
    if (list.length === 2) {
      const a = list[0]!;
      const b = list[1]!;
      // Manifold pair requires the two half-edges to run in
      // OPPOSITE directions across the shared edge (one a→b, the
      // other b→a). If they run the SAME direction, the two faces
      // are inconsistently wound — flag as non-manifold so
      // downstream code doesn't compute a normal off a flipped
      // neighbour and produce shading artefacts.
      const aFrom = origin[a]!;
      const bFrom = origin[b]!;
      // Opposite-direction: aFrom == bTo AND aTo == bFrom. Since
      // we know they share an undirected edge, it's equivalent to
      // aFrom !== bFrom.
      if (aFrom !== bFrom) {
        twin[a] = b;
        twin[b] = a;
      } else {
        // Inconsistent winding — leave twins at -1 and count.
        nonManifoldEdgeCount++;
      }
      continue;
    }
    // 3+ half-edges sharing an edge — genuinely non-manifold (T
    // junctions, fan-of-fins, etc.). No defensible pairing; leave
    // every half-edge in the bucket with twin = -1.
    nonManifoldEdgeCount++;
  }

  // Pass 4: pick a seed outgoing half-edge per vertex. We prefer an
  // INTERIOR (twin != -1) seed when one exists — the outgoingFan
  // walk is cheaper to terminate from the manifold side. For
  // boundary vertices the only available seed IS a boundary
  // half-edge, which is also fine (the fan walks one direction and
  // bails).
  const vertexFirstEdge = new Int32Array(vertexCount);
  vertexFirstEdge.fill(-1);
  for (let he = 0; he < halfEdgeCount; he++) {
    const v = origin[he]!;
    const cur = vertexFirstEdge[v]!;
    if (cur < 0) {
      vertexFirstEdge[v] = he;
    } else if (twin[cur]! < 0 && twin[he]! >= 0) {
      // Upgrade: prefer an interior seed over a boundary one we
      // already picked.
      vertexFirstEdge[v] = he;
    }
  }

  return {
    vertexCount,
    faceCount,
    halfEdgeCount,
    origin,
    twin,
    vertexFirstEdge,
    boundaryEdgeCount,
    nonManifoldEdgeCount,
    degenerateFaceCount,
  };
}
