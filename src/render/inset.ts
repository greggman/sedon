// Face inset: shrink a face cluster INWARD along its angle bisector
// at each boundary corner, leaving a "frame ring" of new quads
// between the original boundary and the shrunk inner face. The
// inner face is left SELECTED in the output so the natural chain is
// `inset → extrude` (recess the inset region, or raise it).
//
// The boundary walk + per-corner inset formula are the same as
// `geom/bevel`'s 2-cut corner handling — at a corner V with
// boundary neighbours P (prev) and N (next), the inset position
// is `V + width · (unit(V→P) + unit(V→N))`. For a 90° corner this
// places the inset at PERPENDICULAR distance `width` from each
// adjacent boundary edge — the intuitive "inset by W" semantic for
// rectangular faces. At non-right angles it's a smooth
// approximation (Blender's true-distance fitting is a follow-up).
//
// Per-surface vertex emission convention from extrude/bevel carries
// over: pass-through unselected tris share input verts; the inner
// face and the frame each emit FRESH copies of their corners with
// their own normals (both = cluster normal here, so frame ↔ inner
// is smooth on the cluster plane, while frame ↔ surrounding-mesh
// is a sharp crease at the cluster's outer boundary).

import type { CpuMeshRef, MeshSelection } from '../core/resources.js';
import { buildHalfEdgeMesh, faceOf, nextInFace } from './half-edge-mesh.js';

export interface InsetOptions {
  /**
   * Inset distance. Positive moves the boundary corners INWARD
   * along their angle bisectors; for a 90° corner this is the
   * perpendicular distance from each adjacent boundary edge. Zero
   * is a no-op-shaped degenerate (frame quads collapse to zero
   * area); large enough values can produce self-intersecting
   * geometry — there's no overlap check.
   */
  width: number;
  /**
   * Treat coincident-position vertices as one topological vertex
   * during the cluster + boundary walk. Default true; matches
   * select-by-normal / extrude / bevel.
   */
  weldByPosition?: boolean;
}

export function insetMesh(mesh: CpuMeshRef, options: InsetOptions): CpuMeshRef {
  const faceMask = mesh.selection?.faces;
  if (!faceMask || !anySelected(faceMask)) return mesh;
  const width = options.width;
  const weldByPosition = options.weldByPosition ?? true;

  // Welded topology so split-vertex primitives (cube/sphere/lathe)
  // see the cluster as a connected region.
  const canonical = weldByPosition
    ? buildPositionWeldMap(mesh.positions)
    : identityMap((mesh.positions.length / 3) | 0);
  const weldedIndices = remapIndices(mesh.indices, canonical);
  const topo = { positions: mesh.positions, normals: mesh.normals, uvs: mesh.uvs, indices: weldedIndices };
  const half = buildHalfEdgeMesh(topo);

  // Cluster selected tris by shared edge — same union-find as
  // extrude. Adjacent selected tris merge into one logical face;
  // their shared edge is interior and gets no frame quad.
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
    if (he < t) union(f, f2);
  }
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
  // Per-output-face flag: 1 = inner face (mark in selection.faces).
  // Frame and pass-through faces stay 0.
  const outFaceIsInner: number[] = [];
  // Output-vert pairs flagged as rim edges (inner ↔ frame). Stored
  // sorted so a single Set lookup matches both directions when we
  // rebuild the output half-edge mesh later.
  const rimPairs = new Set<string>();

  function emitTri(i0: number, i1: number, i2: number, isInner: boolean): void {
    outIndices.push(i0, i1, i2);
    outFaceIsInner.push(isInner ? 1 : 0);
  }

  // 1. Pass-through (unselected) tris referencing the base verts
  // copied verbatim below.
  for (let f = 0; f < faceCount; f++) {
    if (faceMask[f] === 1) continue;
    const i0 = mesh.indices[f * 3]!, i1 = mesh.indices[f * 3 + 1]!, i2 = mesh.indices[f * 3 + 2]!;
    emitTri(i0, i1, i2, false);
  }
  for (let i = 0; i < mesh.positions.length; i++) outPositions.push(mesh.positions[i]!);
  for (let i = 0; i < mesh.normals.length; i++) outNormals.push(mesh.normals[i]!);
  for (let i = 0; i < mesh.uvs.length; i++) outUvs.push(mesh.uvs[i]!);

  // 2. Per-cluster: inset, inner-face emission, frame-quad emission.
  for (const [, members] of clusterMembers) {
    const clusterRoot = find(members[0]!);

    // Cluster normal (area-weighted average; falls back to +Y on
    // degenerate input).
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

    // Cluster boundary walker. A half-edge is on the boundary iff
    // its face is in THIS cluster AND its twin's face isn't (open
    // mesh boundary counts too).
    function isBoundaryHe(he: number): boolean {
      const f = faceOf(he);
      if (find(f) !== clusterRoot) return false;
      const t = half.twin[he]!;
      if (t < 0) return true;
      return find(faceOf(t)) !== clusterRoot;
    }
    // Step from one boundary HE to the next, hopping past INTERIOR
    // half-edges (whose twins are also in the cluster — typically
    // diagonals of the quad clusters from cube faces).
    function nextBoundaryHe(he: number): number {
      let cur = nextInFace(he);
      while (true) {
        if (isBoundaryHe(cur)) return cur;
        const t = half.twin[cur]!;
        cur = nextInFace(t);
      }
    }

    // Find a starting boundary half-edge; if the cluster has none
    // (e.g. the entire closed mesh selected), skip — there's no
    // boundary to inset against.
    let startHe = -1;
    for (const f of members) {
      for (let k = 0; k < 3; k++) {
        const he = f * 3 + k;
        if (isBoundaryHe(he)) { startHe = he; break; }
      }
      if (startHe >= 0) break;
    }
    if (startHe < 0) continue;

    // Walk the cycle to collect the boundary CORNERS in CCW order
    // (from outside the cluster, which is the cluster-normal side).
    const cornerHes: number[] = [];
    let cur = startHe;
    do {
      cornerHes.push(cur);
      cur = nextBoundaryHe(cur);
    } while (cur !== startHe);
    const N = cornerHes.length;

    // Per-boundary-corner inset position. Map welded-canonical
    // vertex id → 3D inset position.
    const insetPosOf = new Map<number, [number, number, number]>();
    for (let i = 0; i < N; i++) {
      const heV = cornerHes[i]!;
      const vCan = half.origin[heV]!;
      const prevV = half.origin[cornerHes[(i - 1 + N) % N]!]!;
      const nextV = half.origin[cornerHes[(i + 1) % N]!]!;
      const px = mesh.positions[vCan * 3]!, py = mesh.positions[vCan * 3 + 1]!, pz = mesh.positions[vCan * 3 + 2]!;
      const prevX = mesh.positions[prevV * 3]!, prevY = mesh.positions[prevV * 3 + 1]!, prevZ = mesh.positions[prevV * 3 + 2]!;
      const nextX = mesh.positions[nextV * 3]!, nextY = mesh.positions[nextV * 3 + 1]!, nextZ = mesh.positions[nextV * 3 + 2]!;
      const dpx = prevX - px, dpy = prevY - py, dpz = prevZ - pz;
      const dpLen = Math.hypot(dpx, dpy, dpz) || 1;
      const dnx = nextX - px, dny = nextY - py, dnz = nextZ - pz;
      const dnLen = Math.hypot(dnx, dny, dnz) || 1;
      const sumX = dpx / dpLen + dnx / dnLen;
      const sumY = dpy / dpLen + dny / dnLen;
      const sumZ = dpz / dpLen + dnz / dnLen;
      insetPosOf.set(vCan, [px + width * sumX, py + width * sumY, pz + width * sumZ]);
    }

    // Pick an arbitrary origV per canonical vertex (for UV lookup).
    // Cluster members give us per-face UV islands on split-vert
    // primitives — first-occurrence picks the one belonging to the
    // cluster's owning face, which is what we want.
    const origVOf = new Map<number, number>();
    for (const f of members) {
      for (let k = 0; k < 3; k++) {
        const oV = mesh.indices[f * 3 + k]!;
        const cV = canonical[oV]!;
        if (!origVOf.has(cV)) origVOf.set(cV, oV);
      }
    }

    // 2a. Emit INNER FACE verts (one per cluster canonical vertex).
    // Boundary verts move to their inset position; interior verts
    // (none on cube faces; present on richer clusters) stay put —
    // it's a topology-preserving partial shrink, intuitive for the
    // cube + grid cases, somewhat distorted on irregular clusters.
    const clusterVerts = new Set<number>();
    for (const f of members) {
      for (let k = 0; k < 3; k++) clusterVerts.add(canonical[mesh.indices[f * 3 + k]!]!);
    }
    const innerVertOf = new Map<number, number>();
    for (const vCan of clusterVerts) {
      const inset = insetPosOf.get(vCan);
      const px = inset ? inset[0] : mesh.positions[vCan * 3]!;
      const py = inset ? inset[1] : mesh.positions[vCan * 3 + 1]!;
      const pz = inset ? inset[2] : mesh.positions[vCan * 3 + 2]!;
      const oV = origVOf.get(vCan)!;
      const idx = outPositions.length / 3;
      outPositions.push(px, py, pz);
      outNormals.push(cnx, cny, cnz);
      outUvs.push(mesh.uvs[oV * 2] ?? 0, mesh.uvs[oV * 2 + 1] ?? 0);
      innerVertOf.set(vCan, idx);
    }

    // 2b. Emit inner face tris (cluster triangulation, remapped).
    for (const f of members) {
      const c0 = canonical[mesh.indices[f * 3]!]!;
      const c1 = canonical[mesh.indices[f * 3 + 1]!]!;
      const c2 = canonical[mesh.indices[f * 3 + 2]!]!;
      emitTri(innerVertOf.get(c0)!, innerVertOf.get(c1)!, innerVertOf.get(c2)!, true);
    }

    // 2c. Frame quads — one per boundary corner i → next corner
    // (i+1). Fresh verts (aOuter, bOuter, bInner, aInner) so the
    // frame ↔ surrounding-mesh boundary at the cluster's outer
    // edge is a sharp crease (frame carries cluster normal; the
    // outside has whatever input normals it had).
    for (let i = 0; i < N; i++) {
      const heA = cornerHes[i]!;
      const heB = cornerHes[(i + 1) % N]!;
      const aCan = half.origin[heA]!;
      const bCan = half.origin[heB]!;
      // Outer base positions = canonical V. UVs come from the
      // cluster's per-canonical origV (which carries the face's
      // own UV island on split-vert inputs).
      const aoV = origVOf.get(aCan)!;
      const boV = origVOf.get(bCan)!;
      const ax = mesh.positions[aCan * 3]!, ay = mesh.positions[aCan * 3 + 1]!, az = mesh.positions[aCan * 3 + 2]!;
      const bx = mesh.positions[bCan * 3]!, by = mesh.positions[bCan * 3 + 1]!, bz = mesh.positions[bCan * 3 + 2]!;
      const apx = insetPosOf.get(aCan)![0], apy = insetPosOf.get(aCan)![1], apz = insetPosOf.get(aCan)![2];
      const bpx = insetPosOf.get(bCan)![0], bpy = insetPosOf.get(bCan)![1], bpz = insetPosOf.get(bCan)![2];

      const aOuter = outPositions.length / 3;
      outPositions.push(ax, ay, az);
      outNormals.push(cnx, cny, cnz);
      outUvs.push(mesh.uvs[aoV * 2] ?? 0, mesh.uvs[aoV * 2 + 1] ?? 0);

      const bOuter = outPositions.length / 3;
      outPositions.push(bx, by, bz);
      outNormals.push(cnx, cny, cnz);
      outUvs.push(mesh.uvs[boV * 2] ?? 0, mesh.uvs[boV * 2 + 1] ?? 0);

      const bInner = outPositions.length / 3;
      outPositions.push(bpx, bpy, bpz);
      outNormals.push(cnx, cny, cnz);
      outUvs.push(mesh.uvs[boV * 2] ?? 0, mesh.uvs[boV * 2 + 1] ?? 0);

      const aInner = outPositions.length / 3;
      outPositions.push(apx, apy, apz);
      outNormals.push(cnx, cny, cnz);
      outUvs.push(mesh.uvs[aoV * 2] ?? 0, mesh.uvs[aoV * 2 + 1] ?? 0);

      // Winding (aOuter, bOuter, bInner, aInner) is CCW from
      // OUTSIDE the cluster (= cluster_normal direction): the cross
      // of (bOuter−aOuter) with (bInner−aOuter) equals
      // cluster_normal × (boundary_segment · width), which points
      // along cluster_normal for positive width.
      emitTri(aOuter, bOuter, bInner, false);
      emitTri(aOuter, bInner, aInner, false);

      // Rim edge between the inner face and the frame at this
      // segment. Record BOTH copies' pairs so the post-pass marks
      // every half-edge (frame side + inner side, both directions).
      rimPairs.add(pairKey(aInner, bInner));
      const aInnerFace = innerVertOf.get(aCan)!;
      const bInnerFace = innerVertOf.get(bCan)!;
      rimPairs.add(pairKey(aInnerFace, bInnerFace));
    }
  }

  // ── Build the output selection masks ───────────────────────────
  const outFaces = new Uint8Array(outIndices.length / 3);
  for (let i = 0; i < outFaceIsInner.length; i++) outFaces[i] = outFaceIsInner[i]!;

  // selection.edges: rebuild output half-edge mesh (welded by
  // position so the inner-face's boundary half-edges pair up with
  // the frame's matching half-edges), then mark any half-edge
  // whose endpoint pair is a rim. Half-edge ids are stable across
  // welding (count = 3·triCount either way), so the mask is keyed
  // consistently with downstream nodes that may rebuild without
  // welding.
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
