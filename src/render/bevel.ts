// Bevel / chamfer: replace each selected edge with a strip of new
// faces, cutting away material from each affected vertex along the
// face-level OTHER edge. With `segments = 1` this is chamfer (one
// flat quad per edge, one polygon corner cap); `segments ≥ 2` gives
// a rounded arc cross-section + spherical-triangle corner cap.
//
// Outward bevel: the insets sit ON the surrounding faces (not inside
// their interior along the angle bisector — that would carve notches
// inward instead of rounding the corner outward). Specifically, for
// each face F at vertex V where one of F's edges-at-V is the selected
// edge E being bevelled, the inset is V + width × unit(OTHER face-
// level edge direction at V). The "other face-level edge" is found
// by walking past any unselected internal diagonals of the face
// cluster until the next selected (or boundary) edge.
//
// For a cube vertex V with all 3 incident edges selected:
//   • 3 unique inset positions, one per cube edge AT V (along that
//     edge direction by `width`).
//   • Each face's corner gets cut by 2 lines (perpendicular to each
//     adjacent selected edge), producing 2 new vertices in the
//     face's modified polygon — the face's quad becomes an octagon.
//   • Each cube edge becomes a strip whose 4 corners are 2 insets
//     per endpoint (one per adjacent face). For chamfer this is a
//     flat quad; for bevel an arc-subdivided strip.
//   • The 3 unique insets at V form the corner cap — 1 triangle for
//     chamfer, an N² triangular-barycentric grid for bevel.
//
// For non-cube cases the same machinery handles single-edge bevels,
// open meshes, and partial-corner selections. M ≥ 4 corner caps fall
// back to a flat fan-triangulation (a small artefact at the cap
// centre for N ≥ 2) — common-case primitives are all M = 3 corners.

import type { CpuMeshRef } from '../core/resources.js';
import { buildHalfEdgeMesh, faceOf, nextInFace, prevInFace, type HalfEdgeMesh } from './half-edge-mesh.js';

export interface BevelOptions {
  /** Signed distance from each affected vertex to its inset along the OTHER face-level edge. */
  width: number;
  /**
   * Number of subdivisions across each bevel strip. 1 = chamfer
   * (flat strip + flat corner cap). ≥ 2 = bevel (arc strip + N²
   * subdivided corner cap for M = 3 corners; M ≥ 4 corners stay
   * flat-fan even with segments ≥ 2).
   */
  segments?: number;
  /**
   * Treat coincident-position vertices as a single topological
   * vertex when building the half-edge mesh. Default true; matches
   * select-by-angle / compute-normals.
   */
  weldByPosition?: boolean;
}

export function bevelMesh(mesh: CpuMeshRef, options: BevelOptions): CpuMeshRef {
  const segments = Math.max(1, Math.floor(options.segments ?? 1));
  const width = options.width;
  const weldByPosition = options.weldByPosition ?? true;

  const maybeEdges = mesh.selection?.edges;
  if (!maybeEdges || !anySelected(maybeEdges)) return mesh;
  const edges: Uint8Array = maybeEdges;

  // ── Welded topology ─────────────────────────────────────────────
  const canonical = weldByPosition
    ? buildPositionWeldMap(mesh.positions)
    : identityMap((mesh.positions.length / 3) | 0);
  const weldedIndices = remapIndices(mesh.indices, canonical);
  const topoMesh: CpuMeshRef = {
    positions: mesh.positions,
    normals: mesh.normals,
    uvs: mesh.uvs,
    indices: weldedIndices,
  };
  const half = buildHalfEdgeMesh(topoMesh);
  const halfEdgeCount = half.halfEdgeCount;

  // ── Face-level OTHER edge walk ──────────────────────────────────
  // For corner `he` at V whose OUTGOING edge `he` is selected, the
  // OTHER face-level edge sits on the INCOMING side. Walk from
  // prevInFace(he) backward through unselected diagonals until a
  // selected edge is found. Returns the canonical "other endpoint"
  // (the origin of the found incoming edge) plus a flag indicating
  // whether the walk landed on a SELECTED edge (= the corner is
  // 2-cut in this face) or hit a boundary first (= 1-cut, and the
  // returned vertex is the unselected edge's far endpoint, useful
  // as a fallback for cuts).
  function otherEndCanonForIncomingSide(he: number): number {
    return otherEndIncomingDetailed(he).otherCan;
  }
  function otherEndIncomingDetailed(he: number): { otherCan: number; is2Cut: boolean } {
    let cur = prevInFace(he);
    while (edges[cur] !== 1) {
      const t = half.twin[cur]!;
      if (t < 0) return { otherCan: half.origin[cur]!, is2Cut: false };
      cur = prevInFace(t);
      if (cur === prevInFace(he) || cur === he) return { otherCan: half.origin[he]!, is2Cut: false };
    }
    return { otherCan: half.origin[cur]!, is2Cut: true };
  }

  // For corner `he` at V whose INCOMING edge (`prevInFace(he)`) is
  // selected, the OTHER face-level edge sits on the OUTGOING side.
  // Walk from `he` forward through unselected diagonals.
  function otherEndCanonForOutgoingSide(he: number): number {
    return otherEndOutgoingDetailed(he).otherCan;
  }
  function otherEndOutgoingDetailed(he: number): { otherCan: number; is2Cut: boolean } {
    let cur = he;
    while (edges[cur] !== 1) {
      const t = half.twin[cur]!;
      if (t < 0) return { otherCan: half.origin[nextInFace(cur)]!, is2Cut: false };
      cur = nextInFace(t);
      if (cur === he) return { otherCan: half.origin[nextInFace(he)]!, is2Cut: false };
    }
    return { otherCan: half.origin[nextInFace(cur)]!, is2Cut: true };
  }

  // ── Output accumulators ─────────────────────────────────────────
  const outPositions: number[] = [];
  const outNormals: number[] = [];
  const outUvs: number[] = [];
  const outIndices: number[] = [];

  // Output vertex deduper.
  //   key "u:<orig>"             = unaffected original vertex
  //   key "i:<orig>:<otherCan>"  = inset at original vertex going
  //                                toward canonical other endpoint
  //   key "a:<vCan>:<lo>:<hi>:<i>" = arc intermediate (shared between
  //                                  strip and cap)
  const outVertexByKey = new Map<string, number>();

  // Per-emission context: each face polygon, strip, and corner cap
  // gets its OWN context string so the inner-insets / outer cuts
  // they share by position don't dedup to a single output vertex.
  // Different faces / strips / caps need DIFFERENT vertex copies
  // because they want DIFFERENT per-vertex normals (the face's
  // normal vs the chamfer's 45° normal vs the cap's body-diagonal
  // normal). Within a single emission, the context stays constant
  // so repeated references to the same position dedup correctly.
  //
  // When emitContext is empty (legacy path used by the partial-
  // bevel arc subdivision code), behaviour matches the old global
  // dedup. New face/strip/cap emission code sets it explicitly.
  let emitContext = '';
  let emitNormal: [number, number, number] = [0, 1, 0];
  const setEmitContext = (ctx: string, normal: [number, number, number]): void => {
    emitContext = ctx;
    emitNormal = normal;
  };

  const getUnaffectedVertex = (origV: number): number => {
    const key = `u:${emitContext}:${origV}`;
    const existing = outVertexByKey.get(key);
    if (existing !== undefined) return existing;
    const idx = outPositions.length / 3;
    outPositions.push(mesh.positions[origV * 3]!, mesh.positions[origV * 3 + 1]!, mesh.positions[origV * 3 + 2]!);
    outUvs.push(mesh.uvs[origV * 2] ?? 0, mesh.uvs[origV * 2 + 1] ?? 0);
    // Unaffected vertices on partial bevels preserve their original
    // normal — the user's mesh authored a specific (possibly smooth)
    // normal at V, and the bevel didn't modify anything around V.
    // If the input has no normal (length 0), fall back to the
    // emission's face normal.
    const inx = mesh.normals[origV * 3] ?? 0;
    const iny = mesh.normals[origV * 3 + 1] ?? 0;
    const inz = mesh.normals[origV * 3 + 2] ?? 0;
    const ilen = Math.hypot(inx, iny, inz);
    if (ilen > 1e-6) outNormals.push(inx / ilen, iny / ilen, inz / ilen);
    else outNormals.push(emitNormal[0], emitNormal[1], emitNormal[2]);
    outVertexByKey.set(key, idx);
    return idx;
  };

  const getInsetVertex = (origV: number, vCan: number, otherCan: number): number => {
    const key = `i:${emitContext}:${origV}:${otherCan}`;
    const existing = outVertexByKey.get(key);
    if (existing !== undefined) return existing;
    const idx = outPositions.length / 3;
    const vx = mesh.positions[vCan * 3]!,    vy = mesh.positions[vCan * 3 + 1]!,    vz = mesh.positions[vCan * 3 + 2]!;
    const ox = mesh.positions[otherCan * 3]!, oy = mesh.positions[otherCan * 3 + 1]!, oz = mesh.positions[otherCan * 3 + 2]!;
    const dx = ox - vx, dy = oy - vy, dz = oz - vz;
    const len = Math.hypot(dx, dy, dz) || 1;
    outPositions.push(vx + width * dx / len, vy + width * dy / len, vz + width * dz / len);
    outUvs.push(mesh.uvs[origV * 2] ?? 0, mesh.uvs[origV * 2 + 1] ?? 0);
    outNormals.push(emitNormal[0], emitNormal[1], emitNormal[2]);
    outVertexByKey.set(key, idx);
    return idx;
  };

  const getInnerInsetVertex = (origV: number, vCan: number, other1: number, other2: number): number => {
    const lo = Math.min(other1, other2), hi = Math.max(other1, other2);
    const key = `n:${emitContext}:${origV}:${lo}:${hi}`;
    const existing = outVertexByKey.get(key);
    if (existing !== undefined) return existing;
    const idx = outPositions.length / 3;
    const vx = mesh.positions[vCan * 3]!,    vy = mesh.positions[vCan * 3 + 1]!,    vz = mesh.positions[vCan * 3 + 2]!;
    const o1x = mesh.positions[other1 * 3]! - vx, o1y = mesh.positions[other1 * 3 + 1]! - vy, o1z = mesh.positions[other1 * 3 + 2]! - vz;
    const o2x = mesh.positions[other2 * 3]! - vx, o2y = mesh.positions[other2 * 3 + 1]! - vy, o2z = mesh.positions[other2 * 3 + 2]! - vz;
    const l1 = Math.hypot(o1x, o1y, o1z) || 1;
    const l2 = Math.hypot(o2x, o2y, o2z) || 1;
    const dx = (o1x / l1 + o2x / l2);
    const dy = (o1y / l1 + o2y / l2);
    const dz = (o1z / l1 + o2z / l2);
    outPositions.push(vx + width * dx, vy + width * dy, vz + width * dz);
    outUvs.push(mesh.uvs[origV * 2] ?? 0, mesh.uvs[origV * 2 + 1] ?? 0);
    outNormals.push(emitNormal[0], emitNormal[1], emitNormal[2]);
    outVertexByKey.set(key, idx);
    return idx;
  };

  // Arc intermediate vertex at canonical V on the arc between two
  // inset positions identified by their "other end" canonical ids
  // (lo and hi, sorted). Ring index i ∈ (0, segments); ring 0 = lo
  // inset, ring N = hi inset, both of those reuse getInsetVertex.
  // Cache by (vCan, lo, hi, i) so the strip and cap share these.
  const getArcVertex = (
    vCan: number, otherLo: number, otherHi: number, i: number,
    posX: number, posY: number, posZ: number,
    uvU: number, uvV: number,
  ): number => {
    const key = `a:${vCan}:${otherLo}:${otherHi}:${i}`;
    const existing = outVertexByKey.get(key);
    if (existing !== undefined) return existing;
    const idx = outPositions.length / 3;
    outPositions.push(posX, posY, posZ);
    outUvs.push(uvU, uvV);
    outNormals.push(0, 1, 0);
    outVertexByKey.set(key, idx);
    return idx;
  };

  // Face normal of triangle `f` from its winding. Cube clusters
  // are coplanar so any tri in the cluster gives the right result.
  function triFaceNormal(f: number): [number, number, number] {
    const i0 = mesh.indices[f * 3]!;
    const i1 = mesh.indices[f * 3 + 1]!;
    const i2 = mesh.indices[f * 3 + 2]!;
    const ax = mesh.positions[i0 * 3]!, ay = mesh.positions[i0 * 3 + 1]!, az = mesh.positions[i0 * 3 + 2]!;
    const bx = mesh.positions[i1 * 3]!, by = mesh.positions[i1 * 3 + 1]!, bz = mesh.positions[i1 * 3 + 2]!;
    const cx = mesh.positions[i2 * 3]!, cy = mesh.positions[i2 * 3 + 1]!, cz = mesh.positions[i2 * 3 + 2]!;
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz) || 1;
    return [nx / len, ny / len, nz / len];
  }
  function normalize3(x: number, y: number, z: number): [number, number, number] {
    const len = Math.hypot(x, y, z) || 1;
    return [x / len, y / len, z / len];
  }

  // ── (a) Face-CLUSTER polygon emission ──────────────────────────
  // Per-triangle emission would produce overlapping polygons on
  // multi-tri faces — two coplanar tris of a cube face don't agree
  // on where to put the "shortened diagonal" between them, so their
  // modified polygons criss-cross each other. Fix: union-find tris
  // joined by UNSELECTED interior edges (= internal diagonals of
  // a logical face), then emit one polygon per cluster whose
  // boundary is a clean cycle of selected + open-mesh-boundary
  // half-edges. The cube's +X quad face becomes one cluster, one
  // octagonal polygon, six fan-triangulated sub-tris.
  const faceCount = (mesh.indices.length / 3) | 0;
  const clusterParent = new Int32Array(faceCount);
  for (let f = 0; f < faceCount; f++) clusterParent[f] = f;
  function findCluster(f: number): number {
    while (clusterParent[f]! !== f) {
      clusterParent[f] = clusterParent[clusterParent[f]!]!;
      f = clusterParent[f]!;
    }
    return f;
  }
  function unionCluster(a: number, b: number): void {
    const ra = findCluster(a), rb = findCluster(b);
    if (ra !== rb) clusterParent[ra] = rb;
  }
  // Join faces across every UNSELECTED interior (non-boundary)
  // half-edge: those are the diagonals we want to absorb into a
  // single cluster.
  for (let he = 0; he < halfEdgeCount; he++) {
    if (edges[he] === 1) continue;
    const t = half.twin[he]!;
    if (t < 0) continue;
    unionCluster(faceOf(he), faceOf(t));
  }

  // Pick ONE boundary half-edge per cluster as the walk seed. A
  // boundary half-edge is one where the edge is selected OR the
  // twin doesn't exist (open mesh).
  const clusterSeen = new Set<number>();
  // Helper: walk forward along the cluster's boundary from `he`.
  // Returns the next boundary half-edge whose origin = destination
  // of `he`. Skips over interior diagonals by stepping
  // nextInFace(twin(...)) through them.
  function nextBoundaryHe(he: number): number {
    let cur = nextInFace(he);
    while (true) {
      if (edges[cur] === 1) return cur;        // selected boundary
      const t = half.twin[cur]!;
      if (t < 0) return cur;                    // open-mesh boundary
      cur = nextInFace(t);                      // hop to next face in cluster
    }
  }

  for (let he = 0; he < halfEdgeCount; he++) {
    // Only start a walk from a boundary half-edge (selected or
    // open-mesh) — interior half-edges are skipped over anyway.
    const tHere = half.twin[he]!;
    const isBoundary = edges[he] === 1 || tHere < 0;
    if (!isBoundary) continue;
    const cluster = findCluster(faceOf(he));
    if (clusterSeen.has(cluster)) continue;
    clusterSeen.add(cluster);

    // Walk the boundary cycle starting at `he`.
    const boundary: number[] = [];
    let cur = he;
    do {
      boundary.push(cur);
      cur = nextBoundaryHe(cur);
    } while (cur !== he);

    // Per-corner records along the boundary walk. Each corner emits
    // 0, 1, or 2 cut vertices depending on its incoming / outgoing
    // boundary edge selection state. A 2-cut corner ALSO gets an
    // inner inset vertex computed at the corner of the shrunk
    // inset region — that's the "A3" point from the user's mental
    // model: where the two shrunk-inward boundary edges meet
    // inside the face.
    // Record per-corner state. cutCount tells how many adjacent edges
    // at this corner are selected (0, 1, or 2). otherEnds[] records
    // the canonical OTHER endpoints of those selected edges (needed
    // by getInnerInsetVertex). The actual outer-cut output vertices
    // are emitted LAZILY — only the 1-cut polygon path uses them,
    // and emitting them eagerly added spurious verts to the output
    // (e.g., a fully-bevelled cube would emit 48 unused outer cuts
    // alongside its 24 inner insets, bloating the mesh 3×).
    interface CornerRec {
      cutCount: 0 | 1 | 2;
      otherEnds: number[];
      // For 1-cut corners: the canonical other-end of the unselected
      // edge whose face direction the lone cut sits along. The other
      // (selected) edge's other-end is in otherEnds[0]. We need both
      // to identify the cut for emission below.
      cutOtherCan: number;  // unused when cutCount !== 1
      cutIncomingSide: boolean; // 1-cut: is the cut on the incoming side?
      origV: number;
      vCan: number;
    }
    const corners: CornerRec[] = [];
    for (let i = 0; i < boundary.length; i++) {
      const cHe = boundary[i]!;
      const prevHe = boundary[(i - 1 + boundary.length) % boundary.length]!;
      const origV = mesh.indices[cHe]!;
      const vCan = half.origin[cHe]!;
      const incomingSelected = edges[prevHe] === 1;
      const outgoingSelected = edges[cHe] === 1;
      const rec: CornerRec = {
        cutCount: 0,
        otherEnds: [],
        cutOtherCan: -1,
        cutIncomingSide: false,
        origV,
        vCan,
      };
      if (incomingSelected) {
        // Cut perpendicular to incoming, along outgoing direction.
        const otherCan = half.origin[nextInFace(cHe)]!;
        rec.otherEnds.push(otherCan);
        rec.cutOtherCan = otherCan;
        rec.cutIncomingSide = true;
        rec.cutCount = 1;
      }
      if (outgoingSelected) {
        // Cut perpendicular to outgoing, along incoming direction.
        const otherCan = half.origin[prevHe]!;
        rec.otherEnds.push(otherCan);
        if (rec.cutCount === 0) {
          rec.cutOtherCan = otherCan;
          rec.cutIncomingSide = false;
        }
        rec.cutCount = (rec.cutCount + 1) as 0 | 1 | 2;
      }
      corners.push(rec);
    }

    // Build the face polygon's boundary cycle. The face polygon is
    // the original face cluster shrunk inward by `width` along every
    // selected boundary edge. Per corner:
    //   • 2-cut → 1 boundary vertex = inner inset (corner of the
    //     shrunk region; the two adjacent selected edges meet here
    //     in inset-space). NOT the outer cuts — those would put the
    //     polygon boundary on the original cube edges, leaving the
    //     chamfer strips with nowhere to go.
    //   • 1-cut → 2 boundary vertices = V itself + the single outer
    //     cut. The polygon goes from V (preserved on the unselected
    //     side) across to the cut (where the chamfer begins). Order
    //     in CCW depends on which side is selected.
    //   • 0-cut → 1 boundary vertex = V itself (unaffected).
    //
    // For a cube face with all 12 edges selected (every corner is
    // 2-cut), this collapses to a 4-vertex quad of inner insets,
    // not the 8-outer-cut-plus-4-inner-Steiner octagon earlier
    // versions emitted. The new topology matches what Blender's
    // bevel produces — each cube face becomes a smaller quad, each
    // cube edge becomes a 45° chamfer rectangle, each cube corner
    // a 3-vertex cap triangle. Outer cuts only appear at 1-cut
    // corners (partial bevels).
    // Face-cluster normal: any tri in the cluster gives the same
    // answer (the cluster is, by construction, the maximal coplanar
    // set of tris joined by unselected diagonals). Use it for all
    // verts emitted by this face polygon so the shaded preview
    // sees flat shading on the face — without needing a downstream
    // compute-normals pass.
    setEmitContext(`f:${cluster}`, triFaceNormal(faceOf(he)));

    const polygonVerts: number[] = [];
    for (const c of corners) {
      if (c.cutCount === 2) {
        // 2-cut corner → V is absorbed by the bevel; the polygon
        // bends inward through the inner-inset vertex (corner of the
        // shrunk face region).
        polygonVerts.push(getInnerInsetVertex(c.origV, c.vCan, c.otherEnds[0]!, c.otherEnds[1]!));
      } else if (c.cutCount === 1) {
        // 1-cut corner → V is absorbed by the bevel on the selected
        // side; only the single cut survives on the polygon boundary
        // (the cut sits on the UNSELECTED face edge, perpendicular
        // to the selected one).
        polygonVerts.push(getInsetVertex(c.origV, c.vCan, c.cutOtherCan));
      } else {
        // 0-cut corner → V is preserved verbatim.
        polygonVerts.push(getUnaffectedVertex(c.origV));
      }
    }
    // Fan-triangulate from polygonVerts[0]. For a cube face (4
    // inner insets), this emits 2 tris.
    for (let i = 1; i < polygonVerts.length - 1; i++) {
      outIndices.push(polygonVerts[0]!, polygonVerts[i]!, polygonVerts[i + 1]!);
    }
  }

  // ── Inset direction helpers (for arc strips) ────────────────────
  // Unit direction from V (canonical) toward another canonical end.
  function unitDir(vCan: number, otherCan: number): { x: number; y: number; z: number } {
    const dx = mesh.positions[otherCan * 3]!     - mesh.positions[vCan * 3]!;
    const dy = mesh.positions[otherCan * 3 + 1]! - mesh.positions[vCan * 3 + 1]!;
    const dz = mesh.positions[otherCan * 3 + 2]! - mesh.positions[vCan * 3 + 2]!;
    const len = Math.hypot(dx, dy, dz) || 1;
    return { x: dx / len, y: dy / len, z: dz / len };
  }

  // ── (b) Strip emission for selected edges ───────────────────────
  // Each logical edge gets one strip. We canonicalise the pair by
  // emitting on the lower-id half-edge of each twin pair.
  for (let he = 0; he < halfEdgeCount; he++) {
    if (edges[he] !== 1) continue;
    const t = half.twin[he]!;
    if (t < 0 || he > t) continue;
    emitStrip(he, t);
  }

  function emitStrip(he: number, t: number): void {
    // V0 = origin(he) (= destination(t)); V1 = origin(t) (= destination(he)).
    // Corner of V0 in F_A (face containing he) = `he` itself.
    // Corner of V1 in F_A = nextInFace(he).
    // Corner of V0 in F_B (face containing t) = nextInFace(t).
    // Corner of V1 in F_B = `t` itself.
    const cornerV0_A = he;
    const cornerV1_A = nextInFace(he);
    const cornerV0_B = nextInFace(t);
    const cornerV1_B = t;
    const V0_canon = half.origin[cornerV0_A]!;
    const V1_canon = half.origin[cornerV1_A]!;
    const V0_orig_A = mesh.indices[cornerV0_A]!;
    const V0_orig_B = mesh.indices[cornerV0_B]!;
    const V1_orig_A = mesh.indices[cornerV1_A]!;
    const V1_orig_B = mesh.indices[cornerV1_B]!;

    // Strip face normal = midway between the two adjacent face
    // normals. For a 90°-dihedral cube edge between +X and -Y this
    // works out to (+X + -Y)/√2 = (1,-1,0)/√2 — the chamfer's
    // outward direction. Using a normalised sum (not a slerp) is
    // fine for segments=1, where every strip triangle is coplanar
    // and gets this normal; for segments≥2 each subdivision ring
    // would want its own slerped normal, which the arc-rewrite
    // task will handle.
    const nA = triFaceNormal(faceOf(he));
    const nB = triFaceNormal(faceOf(t));
    const stripNormal = normalize3(nA[0] + nB[0], nA[1] + nB[1], nA[2] + nB[2]);
    setEmitContext(`s:${he}`, stripNormal);
    // F_A "other-end" at V0 / V1 = canonical vertex at the far end
    // of the F_A face's OTHER selected edge at that corner. The
    // detailed walker also tells us whether the corner is 2-cut in
    // this face (= the walk found ANOTHER selected face-level edge)
    // or 1-cut (= the walk ran off a boundary first, no other
    // selected edge in this face — the returned otherCan is then
    // the far end of the UNSELECTED face-level edge, suitable as
    // the outer-cut direction). prevInFace alone isn't a reliable
    // 2-cut test on face clusters with interior diagonals (e.g. a
    // cube face cluster of 2 tris has its diagonal as prevInFace at
    // half the corners, and the diagonal is always unselected).
    const v0A = otherEndIncomingDetailed(cornerV0_A);
    const v0B = otherEndOutgoingDetailed(cornerV0_B);
    const v1A = otherEndOutgoingDetailed(cornerV1_A);
    const v1B = otherEndIncomingDetailed(cornerV1_B);
    const V0_A_otherEnd = v0A.otherCan;
    const V0_B_otherEnd = v0B.otherCan;
    const V1_A_otherEnd = v1A.otherCan;
    const V1_B_otherEnd = v1B.otherCan;
    const V0_A_is2Cut = v0A.is2Cut;
    const V0_B_is2Cut = v0B.is2Cut;
    const V1_A_is2Cut = v1A.is2Cut;
    const V1_B_is2Cut = v1B.is2Cut;

    // Strip corners. 2-cut → INNER INSET (corner of the shrunk
    // adjacent face region; on the cube FACE plane, inset from the
    // cube edges). 1-cut → OUTER CUT (on the UNSELECTED face edge
    // perpendicular to the bevelled edge; on the cube EDGE).
    // Previous version used outer cuts unconditionally, which gave
    // the cube case Blender-incompatible topology — the corner cap
    // ended up rotated 60° because its 3 verts each lay on cube
    // edges instead of cube faces.
    const v0a = V0_A_is2Cut
      ? getInnerInsetVertex(V0_orig_A, V0_canon, V1_canon, V0_A_otherEnd)
      : getInsetVertex(V0_orig_A, V0_canon, V0_A_otherEnd);
    const v0b = V0_B_is2Cut
      ? getInnerInsetVertex(V0_orig_B, V0_canon, V1_canon, V0_B_otherEnd)
      : getInsetVertex(V0_orig_B, V0_canon, V0_B_otherEnd);
    const v1a = V1_A_is2Cut
      ? getInnerInsetVertex(V1_orig_A, V1_canon, V0_canon, V1_A_otherEnd)
      : getInsetVertex(V1_orig_A, V1_canon, V1_A_otherEnd);
    const v1b = V1_B_is2Cut
      ? getInnerInsetVertex(V1_orig_B, V1_canon, V0_canon, V1_B_otherEnd)
      : getInsetVertex(V1_orig_B, V1_canon, V1_B_otherEnd);

    if (segments === 1) {
      // Chamfer quad. Winding: looking from OUTSIDE the cube along
      // the strip's outward normal (between F_A's and F_B's outward
      // normals), CCW = (v0a, v0b, v1b, v1a). Split into 2 tris.
      // (The other winding produces the strip with normals facing
      // INTO the cube, making the chamfer look like a carved groove.)
      outIndices.push(v0a, v0b, v1b);
      outIndices.push(v0a, v1b, v1a);
      return;
    }

    // Arc subdivision: slerp ring points at each endpoint between
    // the F_A and F_B direction. Endpoints (ring 0 = F_A inset,
    // ring N = F_B inset) reuse the existing inset vertices.
    const dirA0 = unitDir(V0_canon, V0_A_otherEnd);
    const dirB0 = unitDir(V0_canon, V0_B_otherEnd);
    const dirA1 = unitDir(V1_canon, V1_A_otherEnd);
    const dirB1 = unitDir(V1_canon, V1_B_otherEnd);

    // UV interpolation: A side at t=0, B side at t=1. Lerp.
    const uvA0u = mesh.uvs[V0_orig_A * 2]     ?? 0, uvA0v = mesh.uvs[V0_orig_A * 2 + 1] ?? 0;
    const uvB0u = mesh.uvs[V0_orig_B * 2]     ?? 0, uvB0v = mesh.uvs[V0_orig_B * 2 + 1] ?? 0;
    const uvA1u = mesh.uvs[V1_orig_A * 2]     ?? 0, uvA1v = mesh.uvs[V1_orig_A * 2 + 1] ?? 0;
    const uvB1u = mesh.uvs[V1_orig_B * 2]     ?? 0, uvB1v = mesh.uvs[V1_orig_B * 2 + 1] ?? 0;

    const vx0 = mesh.positions[V0_canon * 3]!, vy0 = mesh.positions[V0_canon * 3 + 1]!, vz0 = mesh.positions[V0_canon * 3 + 2]!;
    const vx1 = mesh.positions[V1_canon * 3]!, vy1 = mesh.positions[V1_canon * 3 + 1]!, vz1 = mesh.positions[V1_canon * 3 + 2]!;

    // Cache-key canonicalisation: arc at V is cached with the lower
    // "other end" canonical id at ring 0. If A's other-end > B's,
    // swap the ring index when looking up.
    const v0LoIsA = V0_A_otherEnd < V0_B_otherEnd;
    const v0Lo = v0LoIsA ? V0_A_otherEnd : V0_B_otherEnd;
    const v0Hi = v0LoIsA ? V0_B_otherEnd : V0_A_otherEnd;
    const v1LoIsA = V1_A_otherEnd < V1_B_otherEnd;
    const v1Lo = v1LoIsA ? V1_A_otherEnd : V1_B_otherEnd;
    const v1Hi = v1LoIsA ? V1_B_otherEnd : V1_A_otherEnd;

    const ringV0: number[] = [v0a];
    const ringV1: number[] = [v1a];
    for (let i = 1; i < segments; i++) {
      const tt = i / segments;
      const d0 = slerpUnit(dirA0, dirB0, tt);
      const p0x = vx0 + width * d0.x;
      const p0y = vy0 + width * d0.y;
      const p0z = vz0 + width * d0.z;
      const uv0u = uvA0u + (uvB0u - uvA0u) * tt;
      const uv0v = uvA0v + (uvB0v - uvA0v) * tt;
      ringV0.push(getArcVertex(V0_canon, v0Lo, v0Hi, v0LoIsA ? i : (segments - i), p0x, p0y, p0z, uv0u, uv0v));

      const d1 = slerpUnit(dirA1, dirB1, tt);
      const p1x = vx1 + width * d1.x;
      const p1y = vy1 + width * d1.y;
      const p1z = vz1 + width * d1.z;
      const uv1u = uvA1u + (uvB1u - uvA1u) * tt;
      const uv1v = uvA1v + (uvB1v - uvA1v) * tt;
      ringV1.push(getArcVertex(V1_canon, v1Lo, v1Hi, v1LoIsA ? i : (segments - i), p1x, p1y, p1z, uv1u, uv1v));
    }
    ringV0.push(v0b);
    ringV1.push(v1b);

    for (let i = 0; i < segments; i++) {
      // Same outward-CCW winding as the chamfer quad: at each segment,
      // (V0_i, V0_(i+1), V1_(i+1)) + (V0_i, V1_(i+1), V1_i) — going
      // ACROSS (F_A → F_B) before going ALONG (V0 → V1).
      outIndices.push(ringV0[i]!, ringV0[i + 1]!, ringV1[i + 1]!);
      outIndices.push(ringV0[i]!, ringV1[i + 1]!, ringV1[i]!);
    }
  }

  // ── (c) Corner caps ─────────────────────────────────────────────
  // For each canonical vertex V with ≥ 2 selected incident edges,
  // emit a cap polygon at V's corner. The cap is bounded by ONE
  // inset per selected incident edge (the insets sit ON the cube
  // edges at distance width from V, not on the face bisectors).
  // Walk the half-edge fan at V to enumerate the selected edges in
  // CCW order; each edge contributes one cap corner.
  emitCornerCaps(
    half, edges, mesh.indices, segments, width,
    mesh.positions, canonical,
    otherEndCanonForIncomingSide, otherEndCanonForOutgoingSide,
    getInsetVertex, getInnerInsetVertex, getArcVertex,
    outPositions, outUvs, outNormals, outIndices,
    unitDir, mesh.uvs,
    setEmitContext,
  );

  return {
    positions: new Float32Array(outPositions),
    normals: new Float32Array(outNormals),
    uvs: new Float32Array(outUvs),
    indices: new Uint32Array(outIndices),
  };
}

// ── Helpers ────────────────────────────────────────────────────────

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

function slerpUnit(
  u: { x: number; y: number; z: number },
  v: { x: number; y: number; z: number },
  t: number,
): { x: number; y: number; z: number } {
  let dot = u.x * v.x + u.y * v.y + u.z * v.z;
  if (dot < -1) dot = -1;
  else if (dot > 1) dot = 1;
  if (dot > 0.9999) {
    const x = u.x + (v.x - u.x) * t;
    const y = u.y + (v.y - u.y) * t;
    const z = u.z + (v.z - u.z) * t;
    const len = Math.hypot(x, y, z) || 1;
    return { x: x / len, y: y / len, z: z / len };
  }
  const theta = Math.acos(dot);
  const s = Math.sin(theta);
  const a = Math.sin((1 - t) * theta) / s;
  const b = Math.sin(t * theta) / s;
  return { x: a * u.x + b * v.x, y: a * u.y + b * v.y, z: a * u.z + b * v.z };
}

/**
 * Enumerate corner caps. For each canonical vertex V with ≥ 2
 * selected incident edges, the cap is bounded by ONE inset per
 * selected edge — each inset sits ON one cube edge at distance
 * width from V (NOT on a face bisector). The selected edges around
 * V form a cyclic fan (interior vertices) or a linear fan (open-
 * mesh boundary vertices); we walk in CCW order via the half-edge
 * twins.
 */
function emitCornerCaps(
  half: HalfEdgeMesh,
  edges: Uint8Array,
  origIndices: Uint32Array,
  segments: number,
  width: number,
  positions: Float32Array,
  canonical: Uint32Array,
  otherEndForIn: (he: number) => number,
  otherEndForOut: (he: number) => number,
  getInsetVertex: (origV: number, vCan: number, otherCan: number) => number,
  getInnerInsetVertex: (origV: number, vCan: number, other1: number, other2: number) => number,
  getArcVertex: (vCan: number, lo: number, hi: number, i: number, x: number, y: number, z: number, u: number, v: number) => number,
  outPositions: number[],
  outUvs: number[],
  outNormals: number[],
  outIndices: number[],
  unitDir: (vCan: number, otherCan: number) => { x: number; y: number; z: number },
  uvs: Float32Array,
  setEmitContext: (ctx: string, normal: [number, number, number]) => void,
): void {
  const vertexCount = half.vertexCount;
  const visited = new Uint8Array(vertexCount);

  // For each canonical vertex with selected incident edges, find
  // the cap corners. Each corner is (origV, V_canon, otherEnd_canon)
  // identifying an inset vertex. The fan walk gives them in CCW
  // order around V.
  for (let v = 0; v < vertexCount; v++) {
    if (visited[v]) continue;
    visited[v] = 1;
    const seed = half.vertexFirstEdge[v]!;
    if (seed < 0) continue;
    const capCorners = collectCapCorners(half, edges, v, seed, origIndices, otherEndForIn, otherEndForOut);
    if (capCorners.length < 3) continue; // need at least 3 selected incident edges for a triangular cap
    if (segments === 1 || capCorners.length !== 3) {
      // Flat fan triangulation. For M = 3 chamfer: 1 triangle.
      // For M ≥ 4 chamfer or any M with segments ≥ 2: fan from
      // capCorners[0] — slightly faceted for the bevel case but
      // it's the rare M ≥ 4 path.
      //
      // Cap corners use INNER INSETS (corner of the shrunk adjacent
      // face region) — same vertex the face polygon and strip use
      // at this (corner, face) pair. Both "other ends" of the F_A
      // face's selected edges at V identify the inset uniquely.
      //
      // Per-cap emit context with a placeholder normal so the
      // 3 cap-corner verts get their OWN copies (not shared with
      // the face polygon's or the chamfer strip's at the same
      // position). We patch the real normal in after emission from
      // the cross product of two cap-corner edges (body-diagonal
      // for cube corners; correct outward direction for any cap).
      setEmitContext(`c:${v}`, [0, 1, 0]);
      const idxs = capCorners.map((c) => getInnerInsetVertex(c.origV, c.vCan, c.otherCan, c.bevelEnd));
      if (idxs.length >= 3) {
        const a0 = idxs[0]! * 3, a1 = idxs[1]! * 3, a2 = idxs[2]! * 3;
        const ax = outPositions[a0]!,     ay = outPositions[a0 + 1]!, az = outPositions[a0 + 2]!;
        const bx = outPositions[a1]!,     by = outPositions[a1 + 1]!, bz = outPositions[a1 + 2]!;
        const cx = outPositions[a2]!,     cy = outPositions[a2 + 1]!, cz = outPositions[a2 + 2]!;
        const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
        const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
        const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        const len = Math.hypot(nx, ny, nz) || 1;
        const cnx = nx / len, cny = ny / len, cnz = nz / len;
        for (const idx of idxs) {
          outNormals[idx * 3]     = cnx;
          outNormals[idx * 3 + 1] = cny;
          outNormals[idx * 3 + 2] = cnz;
        }
      }
      for (let i = 1; i < idxs.length - 1; i++) {
        outIndices.push(idxs[0]!, idxs[i]!, idxs[i + 1]!);
      }
      continue;
    }

    // M = 3 with segments ≥ 2 — subdivided spherical triangle.
    emitTriangleCap(
      v, capCorners[0]!, capCorners[1]!, capCorners[2]!, segments, width,
      positions, uvs, origIndices,
      getInsetVertex, getArcVertex, unitDir,
      outPositions, outUvs, outNormals, outIndices,
    );
  }
  void canonical;
}

interface CapCorner {
  origV: number;    // original vertex of the corner inset (carries UV)
  vCan: number;     // canonical vertex (the cap centre)
  otherCan: number; // canonical "other end" of the F_A face's OTHER selected edge at V
  bevelEnd: number; // canonical destination of the OUTGOING selected edge (the bevelled edge `he`)
}

/**
 * Walk the fan around vertex V (canonical) and collect ONE cap
 * corner per selected incident edge, in CCW fan order. For a cube
 * vertex this returns 3 corners (one per cube edge in the OPPOSITE
 * direction).
 */
function collectCapCorners(
  half: HalfEdgeMesh,
  edges: Uint8Array,
  v: number,
  seed: number,
  origIndices: Uint32Array,
  otherEndForIn: (he: number) => number,
  otherEndForOut: (he: number) => number,
): CapCorner[] {
  // Visit each outgoing half-edge from V in fan order. For each:
  //   • If `he` (outgoing) is selected: contributes the inset on the
  //     INCOMING-OTHER side (using `otherEndForIn(he)`). This is the
  //     "F_A side" of the bevelled edge.
  //   • If `prevInFace(he)` (incoming) is selected at this corner:
  //     contributes the inset on the OUTGOING-OTHER side. But we'll
  //     get this same corner when visiting the FAN CONTRIBUTION from
  //     the adjacent face — to avoid double-counting we attribute
  //     each selected edge to ONE corner only (the corner where it's
  //     outgoing).
  //
  // For each outgoing half-edge `he` from V with `edges[he] === 1`:
  //   • The strip across `he` contributes 2 corners at V (F_A and
  //     F_B insets). The F_A inset (incoming side) is collected
  //     here. The F_B inset comes from the SAME selected edge's
  //     other corner — the twin's `nextInFace`. But that twin's
  //     `nextInFace` has outgoing edge = nextInFace(twin(he)),
  //     which may or may not be selected.
  //   • Actually: each cube edge at V contributes ONE inset (along
  //     the OTHER cube edge direction, as I derived in the planning
  //     doc). The cap walks UNIQUE insets, not the strip endpoints.
  //
  // So we enumerate selected outgoing edges. Each contributes 1
  // inset = the (vCan, otherEndForIn(he)) pair.
  const corners: CapCorner[] = [];
  // Walk fan starting from seed.
  const { fan, isClosed } = fanCornersInOrder(half, v, seed);
  // For each fan corner that has a selected OUTGOING edge, record
  // its inset. This gives one corner per selected outgoing edge at
  // V — which equals the number of selected incident edges (each
  // selected logical edge has one outgoing half-edge at V).
  for (const he of fan) {
    if (edges[he] !== 1) continue;
    const otherCan = otherEndForIn(he);
    // `he` originates at v and points along the bevelled edge. Its
    // destination = origin of next half-edge in the face.
    const bevelEnd = half.origin[nextInFace(he)]!;
    corners.push({ origV: origIndices[he]!, vCan: v, otherCan, bevelEnd });
  }
  void otherEndForOut;
  void isClosed;
  return corners;
}

function fanCornersInOrder(
  half: HalfEdgeMesh,
  v: number,
  seed: number,
): { fan: number[]; isClosed: boolean } {
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
  if (isClosed) return { fan: forward, isClosed: true };
  const backward: number[] = [];
  let back = seed;
  while (true) {
    const t = half.twin[back]!;
    if (t < 0) break;
    back = nextInFace(t);
    if (back === seed) break;
    backward.unshift(back);
  }
  void v;
  return { fan: [...backward, ...forward], isClosed: false };
}

/**
 * Emit a triangular barycentric-grid corner cap. The 3 cap corners
 * (A, B, C in CCW fan order) sit at distance `width` from V along
 * their respective "other end" directions; intermediate grid points
 * spherical-barycentric blend the 3 unit directions. Arc-edge
 * vertices share with the strip arcs through the arcVertex cache.
 */
function emitTriangleCap(
  vCan: number,
  capA: CapCorner, capB: CapCorner, capC: CapCorner,
  N: number, width: number,
  positions: Float32Array, uvs: Float32Array, origIndices: Uint32Array,
  getInsetVertex: (origV: number, vCan: number, otherCan: number) => number,
  getArcVertex: (vCan: number, lo: number, hi: number, i: number, x: number, y: number, z: number, u: number, v: number) => number,
  unitDir: (vCan: number, otherCan: number) => { x: number; y: number; z: number },
  outPositions: number[], outUvs: number[], outNormals: number[],
  outIndices: number[],
): void {
  const vx = positions[vCan * 3]!,    vy = positions[vCan * 3 + 1]!,    vz = positions[vCan * 3 + 2]!;
  const dA = unitDir(vCan, capA.otherCan);
  const dB = unitDir(vCan, capB.otherCan);
  const dC = unitDir(vCan, capC.otherCan);
  const uvAu = uvs[capA.origV * 2] ?? 0, uvAv = uvs[capA.origV * 2 + 1] ?? 0;
  const uvBu = uvs[capB.origV * 2] ?? 0, uvBv = uvs[capB.origV * 2 + 1] ?? 0;
  const uvCu = uvs[capC.origV * 2] ?? 0, uvCv = uvs[capC.origV * 2 + 1] ?? 0;

  // Helper: look up (or recompute) the arc-boundary vertex on the
  // cap's edge between two sector corners at ring index i (i = 0 at
  // s1, i = N at s2).
  const arcBoundary = (s1: CapCorner, s2: CapCorner, i: number): number => {
    const lo = Math.min(s1.otherCan, s2.otherCan);
    const hi = Math.max(s1.otherCan, s2.otherCan);
    const idxRing = s1.otherCan < s2.otherCan ? i : (N - i);
    // Compute position via slerp from s1.dir to s2.dir at t = i/N.
    const t = i / N;
    const dStart = s1.otherCan === capA.otherCan ? dA : (s1.otherCan === capB.otherCan ? dB : dC);
    const dEnd   = s2.otherCan === capA.otherCan ? dA : (s2.otherCan === capB.otherCan ? dB : dC);
    const d = slerpUnit(dStart, dEnd, t);
    const px = vx + width * d.x;
    const py = vy + width * d.y;
    const pz = vz + width * d.z;
    const uvS = s1.otherCan === capA.otherCan ? { u: uvAu, v: uvAv } : (s1.otherCan === capB.otherCan ? { u: uvBu, v: uvBv } : { u: uvCu, v: uvCv });
    const uvE = s2.otherCan === capA.otherCan ? { u: uvAu, v: uvAv } : (s2.otherCan === capB.otherCan ? { u: uvBu, v: uvBv } : { u: uvCu, v: uvCv });
    const u = uvS.u + (uvE.u - uvS.u) * t;
    const vUv = uvS.v + (uvE.v - uvS.v) * t;
    return getArcVertex(vCan, lo, hi, idxRing, px, py, pz, u, vUv);
  };

  // Grid: row i in [0, N], col j in [0, i].
  //   bary_A = (N - i) / N
  //   bary_B = (i - j) / N
  //   bary_C = j / N
  const grid: number[][] = [];
  for (let i = 0; i <= N; i++) {
    const row: number[] = [];
    for (let j = 0; j <= i; j++) {
      const ba = (N - i) / N;
      const bb = (i - j) / N;
      const bc = j / N;
      let idx: number;
      if (i === 0 && j === 0) idx = getInsetVertex(capA.origV, vCan, capA.otherCan);
      else if (i === N && j === 0) idx = getInsetVertex(capB.origV, vCan, capB.otherCan);
      else if (i === N && j === N) idx = getInsetVertex(capC.origV, vCan, capC.otherCan);
      else if (j === 0) idx = arcBoundary(capA, capB, i);
      else if (j === i) idx = arcBoundary(capA, capC, i);
      else if (i === N) idx = arcBoundary(capB, capC, j);
      else {
        // Interior — fresh vertex via barycentric slerp.
        const dx = ba * dA.x + bb * dB.x + bc * dC.x;
        const dy = ba * dA.y + bb * dB.y + bc * dC.y;
        const dz = ba * dA.z + bb * dB.z + bc * dC.z;
        const len = Math.hypot(dx, dy, dz) || 1;
        const px = vx + width * dx / len;
        const py = vy + width * dy / len;
        const pz = vz + width * dz / len;
        const u = ba * uvAu + bb * uvBu + bc * uvCu;
        const vUv = ba * uvAv + bb * uvBv + bc * uvCv;
        idx = outPositions.length / 3;
        outPositions.push(px, py, pz);
        outUvs.push(u, vUv);
        outNormals.push(0, 1, 0);
      }
      row.push(idx);
    }
    grid.push(row);
  }
  // Triangulate: row i contributes (i+1) up-triangles and i down-
  // triangles. Total per cap: N². Winding: CCW from outside the cap.
  for (let i = 0; i < N; i++) {
    const rowI = grid[i]!;
    const rowI1 = grid[i + 1]!;
    for (let j = 0; j <= i; j++) {
      outIndices.push(rowI[j]!, rowI1[j]!, rowI1[j + 1]!);
    }
    for (let j = 0; j < i; j++) {
      outIndices.push(rowI[j]!, rowI1[j + 1]!, rowI[j + 1]!);
    }
  }
  void origIndices;
}
