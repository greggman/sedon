// BranchGraph — a tree of branch curves with per-vertex radius. Output of
// branch/recursive (and future branch/whorled-pine, branch/palm, etc.).
// Consumed by branch/tube to build a swept-tube mesh, by branch/sample-points
// to emit a PointCloud of leaf placements, and by branch/tropism to bend the
// curves under gravity / sun.
//
// Storage: required fields are first-class struct members (so consumers can
// say `g.positions` and stay readable). `extraBranch` and `extraVertex` are
// optional named-attribute dictionaries for future additive attributes
// (age, branchPhase, materialId, …) without breaking existing consumers.

import type { PointCloudValue } from '../core/resources.js';
import type { CpuMesh } from './mesh.js';

export type BranchAttribute = Float32Array | Int32Array | Uint32Array;

export interface BranchGraphValue {
  branchCount: number;
  vertexCount: number;
  // Per-branch (length = branchCount).
  parentIndex: Int32Array;     // -1 for root branches
  parentT: Float32Array;        // 0..1 attach point along parent
  branchDepth: Int32Array;      // 0 = trunk
  vertexStart: Uint32Array;     // first vertex index in per-vertex arrays
  vertexLength: Uint32Array;    // vertex count in per-vertex arrays
  // Per-vertex (positions: vertexCount*3; radii, arcLength: vertexCount).
  positions: Float32Array;
  radii: Float32Array;
  arcLength: Float32Array;      // distance along this branch from its base
  // Forward-compat extension slots — additive attributes that future nodes
  // can attach without breaking existing consumers. Untouched by Phase 1.
  extraBranch?: Record<string, BranchAttribute>;
  extraVertex?: Record<string, BranchAttribute>;
}

export function emptyBranchGraph(): BranchGraphValue {
  return {
    branchCount: 0,
    vertexCount: 0,
    parentIndex: new Int32Array(0),
    parentT: new Float32Array(0),
    branchDepth: new Int32Array(0),
    vertexStart: new Uint32Array(0),
    vertexLength: new Uint32Array(0),
    positions: new Float32Array(0),
    radii: new Float32Array(0),
    arcLength: new Float32Array(0),
  };
}

// ===== PRNG + tiny vec3 helpers =========================================

// Mulberry32 — deterministic 32-bit PRNG, matches the convention used
// elsewhere in the renderer (mesh.ts, grid-distribute.ts, random-*-cloud.ts).
function mulberry32(seed: number): () => number {
  let state = (seed | 0) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Vec3 = readonly [number, number, number];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v: Vec3): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

// Rotate v around unit-length axis k by `angle` radians — Rodrigues' formula.
function rotateAxisAngle(v: Vec3, k: Vec3, angle: number): [number, number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kxv = cross(k, v);
  const kdv = dot(k, v);
  return [
    v[0] * c + kxv[0] * s + k[0] * kdv * (1 - c),
    v[1] * c + kxv[1] * s + k[1] * kdv * (1 - c),
    v[2] * c + kxv[2] * s + k[2] * kdv * (1 - c),
  ];
}

// Pick *some* unit vector perpendicular to t (which is assumed unit-length).
// Uses world-X if t isn't near-parallel, else world-Y.
function pickPerpendicular(t: Vec3): [number, number, number] {
  const ref: Vec3 = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = dot(t, ref);
  return normalize([ref[0] - d * t[0], ref[1] - d * t[1], ref[2] - d * t[2]]);
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

// Polyline position at fractional length t in [0..1].
function polylineLookup(
  polyline: ReadonlyArray<readonly [number, number, number]>,
  t: number,
): [number, number, number] {
  if (polyline.length === 0) return [0, 0, 0];
  if (polyline.length === 1) {
    const p = polyline[0]!;
    return [p[0], p[1], p[2]];
  }
  const exact = Math.max(0, Math.min(polyline.length - 1, t * (polyline.length - 1)));
  const i0 = Math.floor(exact);
  const i1 = Math.min(polyline.length - 1, i0 + 1);
  const f = exact - i0;
  const a = polyline[i0]!;
  const b = polyline[i1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// Polyline unit-tangent at fractional length t in [0..1].
function polylineTangent(
  polyline: ReadonlyArray<readonly [number, number, number]>,
  t: number,
): [number, number, number] {
  if (polyline.length < 2) return [0, 1, 0];
  const segs = polyline.length - 1;
  const exact = Math.max(0, Math.min(segs - 1, Math.floor(t * segs)));
  const a = polyline[exact]!;
  const b = polyline[exact + 1]!;
  return normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
}

// ===== Recursive parametric branching =====================================

export interface RecursiveBranchOpts {
  trunkHeight: number;
  trunkRadius: number;
  trunkSegments: number;
  maxDepth: number;
  branchesPerSegment: number;
  /** Fraction of branch length below which no children spawn (0..1). */
  branchStart: number;
  branchAngleDeg: number;
  branchAngleJitterDeg: number;
  /** Child branch length = parent branch length * lengthRatio. */
  lengthRatio: number;
  /** Child root radius = parent root radius * radiusRatio. */
  radiusRatio: number;
  /** Degrees per segment of in-plane bend along each branch. */
  branchCurvatureDeg: number;
  /** Rotation around parent tangent between consecutive children. */
  phyllotaxisDeg: number;
  /** Child segment count = round(parent segment count * segmentRatio). */
  segmentRatio: number;
  /** Lower bound on segments per branch (otherwise tubes degenerate). */
  minSegmentsPerBranch: number;
  /** Tip radius = root radius * tipRadiusFraction (linear taper across branch). */
  tipRadiusFraction: number;
  seed: number;
}

interface RawBranch {
  parentIndex: number;
  parentT: number;
  depth: number;
  polyline: Array<[number, number, number]>;
  radii: number[];
}

export function generateRecursiveBranchGraph(opts: RecursiveBranchOpts): BranchGraphValue {
  const rand = mulberry32(Math.floor(opts.seed * 1_000_000) || 1);
  const branches: RawBranch[] = [];

  // Trunk.
  const trunkCurveAxis = pickPerpendicular([0, 1, 0]);
  branches.push(
    growBranch({
      base: [0, 0, 0],
      direction: [0, 1, 0],
      length: opts.trunkHeight,
      rootRadius: opts.trunkRadius,
      tipRadius: opts.trunkRadius * opts.tipRadiusFraction,
      segments: Math.max(opts.minSegmentsPerBranch, Math.floor(opts.trunkSegments)),
      curvatureRad: degToRad(opts.branchCurvatureDeg) * 0.25, // trunk bends less
      curvatureAxis: trunkCurveAxis,
      parentIndex: -1,
      parentT: 0,
      depth: 0,
    }),
  );

  // Pre-order grow: iterate the worklist; appending children keeps the loop
  // condition live so we process every newly-added branch.
  for (let bi = 0; bi < branches.length; bi++) {
    const parent = branches[bi]!;
    if (parent.depth >= opts.maxDepth) continue;

    const segCount = parent.polyline.length - 1;
    if (segCount < 1) continue;
    const startSeg = Math.max(0, Math.min(segCount - 1, Math.floor(opts.branchStart * segCount)));

    // Phyllotaxis: rotate around parent tangent between children. Per-parent
    // counter so siblings on the SAME parent stagger their azimuths, then
    // each subsequent parent restarts — keeps the spiral reading instead of
    // every branch landing at the same world angle.
    let phyllo = rand() * 2 * Math.PI;

    const parentLength = arcLength(parent.polyline);
    const parentRootRadius = parent.radii[0]!;

    for (let s = startSeg; s < segCount; s++) {
      for (let k = 0; k < opts.branchesPerSegment; k++) {
        const t = (s + 0.5) / segCount;
        const pa = parent.polyline[s]!;
        const pb = parent.polyline[s + 1]!;
        const base: [number, number, number] = [
          (pa[0] + pb[0]) * 0.5,
          (pa[1] + pb[1]) * 0.5,
          (pa[2] + pb[2]) * 0.5,
        ];
        const parentTangent = normalize([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]);

        // Build a tilt axis in the plane perpendicular to the parent tangent
        // — start with any perp, then rotate it by the phyllotaxis angle so
        // successive children spawn at staggered azimuths around the parent.
        const tiltAxisBase = pickPerpendicular(parentTangent);
        const tiltAxis = rotateAxisAngle(tiltAxisBase, parentTangent, phyllo);
        phyllo += degToRad(opts.phyllotaxisDeg);

        const tiltAngle = degToRad(
          opts.branchAngleDeg + (rand() * 2 - 1) * opts.branchAngleJitterDeg,
        );
        const childDir = normalize(rotateAxisAngle(parentTangent, tiltAxis, tiltAngle));

        // Per-branch curve axis: perpendicular to child direction, randomized
        // around the child direction so every branch curls a different way.
        const curveBase = pickPerpendicular(childDir);
        const curveAxis = rotateAxisAngle(curveBase, childDir, rand() * 2 * Math.PI);

        const childLength = parentLength * opts.lengthRatio;
        const childRootRadius = parentRootRadius * opts.radiusRatio;
        const childSegs = Math.max(
          opts.minSegmentsPerBranch,
          Math.round(parent.polyline.length * opts.segmentRatio),
        );

        branches.push(
          growBranch({
            base,
            direction: childDir,
            length: childLength,
            rootRadius: childRootRadius,
            tipRadius: childRootRadius * opts.tipRadiusFraction,
            segments: childSegs,
            curvatureRad: degToRad(opts.branchCurvatureDeg),
            curvatureAxis: curveAxis,
            parentIndex: bi,
            parentT: t,
            depth: parent.depth + 1,
          }),
        );
      }
    }
  }

  return finalizeBranches(branches);
}

interface GrowBranchOpts {
  base: Vec3;
  direction: Vec3;
  length: number;
  rootRadius: number;
  tipRadius: number;
  segments: number;
  curvatureRad: number;
  curvatureAxis: Vec3;
  parentIndex: number;
  parentT: number;
  depth: number;
}

function growBranch(o: GrowBranchOpts): RawBranch {
  const segs = Math.max(1, Math.floor(o.segments));
  const stepLen = o.length / segs;
  const polyline: Array<[number, number, number]> = [];
  const radii: number[] = [];

  let pos: [number, number, number] = [o.base[0], o.base[1], o.base[2]];
  let dir: [number, number, number] = normalize(o.direction);

  polyline.push([pos[0], pos[1], pos[2]]);
  radii.push(o.rootRadius);

  for (let i = 1; i <= segs; i++) {
    pos = [pos[0] + dir[0] * stepLen, pos[1] + dir[1] * stepLen, pos[2] + dir[2] * stepLen];
    polyline.push([pos[0], pos[1], pos[2]]);
    const t = i / segs;
    radii.push(o.rootRadius + (o.tipRadius - o.rootRadius) * t);
    dir = normalize(rotateAxisAngle(dir, o.curvatureAxis, o.curvatureRad));
  }

  return {
    parentIndex: o.parentIndex,
    parentT: o.parentT,
    depth: o.depth,
    polyline,
    radii,
  };
}

function arcLength(p: readonly Vec3[]): number {
  let s = 0;
  for (let i = 1; i < p.length; i++) {
    s += Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![1] - p[i - 1]![1], p[i]![2] - p[i - 1]![2]);
  }
  return s;
}

function finalizeBranches(raws: RawBranch[]): BranchGraphValue {
  const branchCount = raws.length;
  let vertexCount = 0;
  for (const b of raws) vertexCount += b.polyline.length;

  const parentIndex = new Int32Array(branchCount);
  const parentT = new Float32Array(branchCount);
  const branchDepth = new Int32Array(branchCount);
  const vertexStart = new Uint32Array(branchCount);
  const vertexLength = new Uint32Array(branchCount);
  const positions = new Float32Array(vertexCount * 3);
  const radii = new Float32Array(vertexCount);
  const arcLengthArr = new Float32Array(vertexCount);

  let v = 0;
  for (let bi = 0; bi < branchCount; bi++) {
    const r = raws[bi]!;
    parentIndex[bi] = r.parentIndex;
    parentT[bi] = r.parentT;
    branchDepth[bi] = r.depth;
    vertexStart[bi] = v;
    vertexLength[bi] = r.polyline.length;
    let arc = 0;
    for (let i = 0; i < r.polyline.length; i++) {
      const p = r.polyline[i]!;
      positions[v * 3] = p[0];
      positions[v * 3 + 1] = p[1];
      positions[v * 3 + 2] = p[2];
      radii[v] = r.radii[i]!;
      if (i > 0) {
        const prev = r.polyline[i - 1]!;
        arc += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
      }
      arcLengthArr[v] = arc;
      v++;
    }
  }

  return {
    branchCount,
    vertexCount,
    parentIndex,
    parentT,
    branchDepth,
    vertexStart,
    vertexLength,
    positions,
    radii,
    arcLength: arcLengthArr,
  };
}

// ===== Parallel-transport frames ========================================
// Used by tube sweep + sample-points. Computed per-branch on demand rather
// than stored on BranchGraph — keeps the datatype small and means tropism
// passes never have to maintain orientation invariants.

interface Frame {
  n1x: number; n1y: number; n1z: number;
  n2x: number; n2y: number; n2z: number;
}

function computePolylineFrames(positions: Float32Array, vs: number, vc: number): Frame[] {
  const frames: Frame[] = new Array(vc);

  // Per-vertex tangents (central diff in the interior; forward/backward at endpoints).
  const tangents: Array<[number, number, number]> = new Array(vc);
  for (let i = 0; i < vc; i++) {
    let tx: number, ty: number, tz: number;
    if (i === 0) {
      tx = positions[(vs + 1) * 3]! - positions[vs * 3]!;
      ty = positions[(vs + 1) * 3 + 1]! - positions[vs * 3 + 1]!;
      tz = positions[(vs + 1) * 3 + 2]! - positions[vs * 3 + 2]!;
    } else if (i === vc - 1) {
      tx = positions[(vs + i) * 3]! - positions[(vs + i - 1) * 3]!;
      ty = positions[(vs + i) * 3 + 1]! - positions[(vs + i - 1) * 3 + 1]!;
      tz = positions[(vs + i) * 3 + 2]! - positions[(vs + i - 1) * 3 + 2]!;
    } else {
      tx = positions[(vs + i + 1) * 3]! - positions[(vs + i - 1) * 3]!;
      ty = positions[(vs + i + 1) * 3 + 1]! - positions[(vs + i - 1) * 3 + 1]!;
      tz = positions[(vs + i + 1) * 3 + 2]! - positions[(vs + i - 1) * 3 + 2]!;
    }
    const len = Math.hypot(tx, ty, tz) || 1;
    tangents[i] = [tx / len, ty / len, tz / len];
  }

  // Seed frame at vertex 0. n2 = cross(n1, t0) (NOT cross(t0, n1)): walking θ
  // from 0 to 2π in the (n1, n2) plane must go CCW *viewed from the tangent
  // tip*, so the ring strip winds the same way as core/cylinder. The opposite
  // order produces a left-handed basis and the tube renders inside-out.
  const t0 = tangents[0]!;
  let n1: [number, number, number] = pickPerpendicular(t0);
  let n2: [number, number, number] = normalize(cross(n1, t0));
  frames[0] = { n1x: n1[0], n1y: n1[1], n1z: n1[2], n2x: n2[0], n2y: n2[1], n2z: n2[2] };

  // Parallel-transport: rotate the frame by the same rotation that takes the
  // previous tangent onto the current one.
  for (let i = 1; i < vc; i++) {
    const prev = tangents[i - 1]!;
    const curr = tangents[i]!;
    const ax = cross(prev, curr);
    const axisLen = Math.hypot(ax[0], ax[1], ax[2]);
    if (axisLen < 1e-6) {
      frames[i] = { ...frames[i - 1]! };
      continue;
    }
    const axisU: [number, number, number] = [ax[0] / axisLen, ax[1] / axisLen, ax[2] / axisLen];
    const cosA = Math.max(-1, Math.min(1, dot(prev, curr)));
    const angle = Math.acos(cosA);
    const prev1: [number, number, number] = [frames[i - 1]!.n1x, frames[i - 1]!.n1y, frames[i - 1]!.n1z];
    const prev2: [number, number, number] = [frames[i - 1]!.n2x, frames[i - 1]!.n2y, frames[i - 1]!.n2z];
    n1 = rotateAxisAngle(prev1, axisU, angle);
    n2 = rotateAxisAngle(prev2, axisU, angle);
    frames[i] = { n1x: n1[0], n1y: n1[1], n1z: n1[2], n2x: n2[0], n2y: n2[1], n2z: n2[2] };
  }

  return frames;
}

// ===== Tube sweep ========================================================

export interface TubeOpts {
  sides: number;
  uvTilingV: number;
}

/**
 * Parent-attach state at a child branch's parentT. Used by Y-joint
 * blending: the child's first ring snaps onto the parent's cylinder
 * surface using `pivot` (point on parent's centerline) + `tangent`
 * (parent's local direction) + `radius` (parent's local radius).
 */
interface ParentAttachState {
  pivotX: number; pivotY: number; pivotZ: number;
  tangentX: number; tangentY: number; tangentZ: number;
  radius: number;
}

function computeParentAttachState(
  graph: BranchGraphValue,
  branchIdx: number,
): ParentAttachState | null {
  const parentIdx = graph.parentIndex[branchIdx]!;
  if (parentIdx < 0) return null;
  const pVs = graph.vertexStart[parentIdx]!;
  const pVc = graph.vertexLength[parentIdx]!;
  if (pVc < 2) return null;
  const tRaw = graph.parentT[branchIdx]! * (pVc - 1);
  const tClamped = Math.max(0, Math.min(pVc - 1, tRaw));
  const i0 = Math.max(0, Math.min(pVc - 2, Math.floor(tClamped)));
  const i1 = i0 + 1;
  const f = tClamped - i0;
  const ax = graph.positions[(pVs + i0) * 3]!;
  const ay = graph.positions[(pVs + i0) * 3 + 1]!;
  const az = graph.positions[(pVs + i0) * 3 + 2]!;
  const bx = graph.positions[(pVs + i1) * 3]!;
  const by = graph.positions[(pVs + i1) * 3 + 1]!;
  const bz = graph.positions[(pVs + i1) * 3 + 2]!;
  const pivotX = ax + (bx - ax) * f;
  const pivotY = ay + (by - ay) * f;
  const pivotZ = az + (bz - az) * f;
  let tx = bx - ax;
  let ty = by - ay;
  let tz = bz - az;
  const tlen = Math.hypot(tx, ty, tz) || 1;
  tx /= tlen; ty /= tlen; tz /= tlen;
  const r0 = graph.radii[pVs + i0]!;
  const r1 = graph.radii[pVs + i1]!;
  const radius = r0 + (r1 - r0) * f;
  return {
    pivotX, pivotY, pivotZ,
    tangentX: tx, tangentY: ty, tangentZ: tz,
    radius,
  };
}

/**
 * Push the snapped ring this far OUTSIDE the parent's surface, so the
 * child's first ring lies just above the parent rather than coinciding
 * with it (which would z-fight along the boundary curve).
 */
const Y_JOINT_EPSILON = 1e-3;

export function sweepBranchGraphToMesh(graph: BranchGraphValue, opts: TubeOpts): CpuMesh {
  const sides = Math.max(3, Math.floor(opts.sides));

  // Each branch gets its own ring-strip section. +1 ring vertex per row
  // for UV-seam continuity. For child branches, the first ring is
  // SNAPPED onto the parent's cylinder surface (Y-joint blending) — see
  // `computeParentAttachState` + the `attach != null && i === 0` path
  // below. The natural side effect is a flare at the joint: the
  // snapped ring sits at the parent's radius, the next ring at the
  // child's radius, and the quad strip between them tapers.
  //
  // Every branch also gets a TIP CAP (a small fan of triangles closing
  // the open end of the tube), and every ROOT branch gets a BASE CAP too
  // — without these the renderer's backface culling reveals the hollow
  // interior of any tube end the viewer can see down. The caps share
  // positions with the existing side-ring vertices but get their own
  // vertex slots so the cap's normal can point along the branch axis
  // instead of radially.
  let totalV = 0;
  let totalI = 0;
  for (let b = 0; b < graph.branchCount; b++) {
    const vc = graph.vertexLength[b]!;
    if (vc < 2) continue;
    // Side strip + tip cap (always present).
    totalV += vc * (sides + 1) + sides + 1;
    totalI += (vc - 1) * sides * 6 + sides * 3;
    // Root branches additionally get a base cap.
    if (graph.parentIndex[b]! < 0) {
      totalV += sides + 1;
      totalI += sides * 3;
    }
  }

  const positions = new Float32Array(totalV * 3);
  const normals = new Float32Array(totalV * 3);
  const uvs = new Float32Array(totalV * 2);
  const indices = new Uint32Array(totalI);

  let vCursor = 0;
  let iCursor = 0;

  for (let b = 0; b < graph.branchCount; b++) {
    const vs = graph.vertexStart[b]!;
    const vc = graph.vertexLength[b]!;
    if (vc < 2) continue;

    const frames = computePolylineFrames(graph.positions, vs, vc);
    const branchBaseV = vCursor;
    const attach = computeParentAttachState(graph, b);

    // Y-joint mode selection for child branches' first ring:
    //   • SNAP — project ring 0 onto the parent's cylinder. Produces a
    //     nice tilted-ellipse flare. Requires the child to be reasonably
    //     non-perpendicular to the parent; otherwise the projection
    //     U-turns through the parent's centerline and quads twist.
    //   • ENLARGE — keep ring 0 in the natural plane (perpendicular to
    //     child tangent) but blow its radius up to the parent's radius.
    //     Half of the ring sits inside the parent's volume (occluded);
    //     the rest emerges. No degenerate projection, no twist.
    //
    // Heuristic: use snap when |child_t · parent_t| > 0.3 (branch angle
    // < ~72°); enlarge otherwise. The threshold is empirical — picked
    // so the canopy tree's near-perpendicular siblings stop tearing.
    let yJointMode: 'snap' | 'enlarge' | 'none' = 'none';
    if (attach !== null && vc >= 2) {
      const ct0x = graph.positions[(vs + 1) * 3]! - graph.positions[vs * 3]!;
      const ct0y = graph.positions[(vs + 1) * 3 + 1]! - graph.positions[vs * 3 + 1]!;
      const ct0z = graph.positions[(vs + 1) * 3 + 2]! - graph.positions[vs * 3 + 2]!;
      const ct0Len = Math.hypot(ct0x, ct0y, ct0z) || 1;
      const align = Math.abs(
        (ct0x * attach.tangentX + ct0y * attach.tangentY + ct0z * attach.tangentZ) / ct0Len,
      );
      yJointMode = align > 0.3 ? 'snap' : 'enlarge';
    }

    for (let i = 0; i < vc; i++) {
      const px = graph.positions[(vs + i) * 3]!;
      const py = graph.positions[(vs + i) * 3 + 1]!;
      const pz = graph.positions[(vs + i) * 3 + 2]!;
      const r = graph.radii[vs + i]!;
      const arc = graph.arcLength[vs + i]!;
      const f = frames[i]!;

      const snapToParent = i === 0 && yJointMode === 'snap' && attach !== null;
      const enlargeAtJoint = i === 0 && yJointMode === 'enlarge' && attach !== null;

      for (let s = 0; s <= sides; s++) {
        const theta = (s / sides) * 2 * Math.PI;
        const c = Math.cos(theta);
        const sn = Math.sin(theta);
        const idx = vCursor + i * (sides + 1) + s;

        // Direction from this ring vertex's CENTER (the polyline vertex)
        // outward, in the child's local frame.
        const dirX = c * f.n1x + sn * f.n2x;
        const dirY = c * f.n1y + sn * f.n2y;
        const dirZ = c * f.n1z + sn * f.n2z;

        if (snapToParent) {
          // Snap to the parent's cylinder. The un-snapped vertex offset
          // from pivot is `r * dir`; decompose into the parent's local
          // basis (tangent + perpendicular-to-tangent), then scale the
          // perpendicular component out to the parent's radius.
          const dpx = dirX * r;
          const dpy = dirY * r;
          const dpz = dirZ * r;
          const dAlong = dpx * attach.tangentX + dpy * attach.tangentY + dpz * attach.tangentZ;
          let perpX = dpx - dAlong * attach.tangentX;
          let perpY = dpy - dAlong * attach.tangentY;
          let perpZ = dpz - dAlong * attach.tangentZ;
          const perpLen = Math.hypot(perpX, perpY, perpZ);
          if (perpLen < 1e-9) {
            // Degenerate: ring vertex points along the parent's tangent
            // (child is collinear with parent — shouldn't happen with
            // the dominant-child structure, but fall back to a
            // pickPerpendicular direction so we never NaN).
            const fallback = pickPerpendicular([attach.tangentX, attach.tangentY, attach.tangentZ]);
            perpX = fallback[0];
            perpY = fallback[1];
            perpZ = fallback[2];
          } else {
            perpX /= perpLen;
            perpY /= perpLen;
            perpZ /= perpLen;
          }
          const rOut = attach.radius + Y_JOINT_EPSILON;
          positions[idx * 3] = attach.pivotX + dAlong * attach.tangentX + rOut * perpX;
          positions[idx * 3 + 1] = attach.pivotY + dAlong * attach.tangentY + rOut * perpY;
          positions[idx * 3 + 2] = attach.pivotZ + dAlong * attach.tangentZ + rOut * perpZ;
          // Normal points outward from the parent's centerline so
          // lighting flows continuously from the parent's bark across
          // the joint into the child's bark.
          normals[idx * 3] = perpX;
          normals[idx * 3 + 1] = perpY;
          normals[idx * 3 + 2] = perpZ;
        } else if (enlargeAtJoint && attach !== null) {
          // Enlarge ring 0's radius to the parent's so it overlaps the
          // parent's volume and the child's tube emerges through the
          // parent's intact surface. No projection — keeps the ring's
          // plane perpendicular to the child's tangent.
          const rOut = Math.max(r, attach.radius + Y_JOINT_EPSILON);
          positions[idx * 3] = px + dirX * rOut;
          positions[idx * 3 + 1] = py + dirY * rOut;
          positions[idx * 3 + 2] = pz + dirZ * rOut;
          normals[idx * 3] = dirX;
          normals[idx * 3 + 1] = dirY;
          normals[idx * 3 + 2] = dirZ;
        } else {
          positions[idx * 3] = px + dirX * r;
          positions[idx * 3 + 1] = py + dirY * r;
          positions[idx * 3 + 2] = pz + dirZ * r;
          normals[idx * 3] = dirX;
          normals[idx * 3 + 1] = dirY;
          normals[idx * 3 + 2] = dirZ;
        }

        uvs[idx * 2] = s / sides;
        uvs[idx * 2 + 1] = arc * opts.uvTilingV;
      }
    }
    vCursor += vc * (sides + 1);

    // Quad strip per segment row. Winding matches cylinder.ts.
    for (let i = 0; i < vc - 1; i++) {
      for (let s = 0; s < sides; s++) {
        const a = branchBaseV + i * (sides + 1) + s;
        const b1 = branchBaseV + i * (sides + 1) + s + 1;
        const c1 = branchBaseV + (i + 1) * (sides + 1) + s;
        const d = branchBaseV + (i + 1) * (sides + 1) + s + 1;
        indices[iCursor++] = a;
        indices[iCursor++] = d;
        indices[iCursor++] = b1;
        indices[iCursor++] = a;
        indices[iCursor++] = c1;
        indices[iCursor++] = d;
      }
    }

    // ----- Tip cap -----
    // Fan of `sides` triangles closing the tube's tip. Cap-ring vertices
    // share positions with the existing tip ring but get axis-aligned
    // normals so lighting reads the cap as a flat disc rather than a
    // continuation of the curved side. UV maps the cap to a unit disc
    // around (0.5, 0.5).
    const tipIdx = vc - 1;
    const tipX = graph.positions[(vs + tipIdx) * 3]!;
    const tipY = graph.positions[(vs + tipIdx) * 3 + 1]!;
    const tipZ = graph.positions[(vs + tipIdx) * 3 + 2]!;
    let ttx = tipX - graph.positions[(vs + tipIdx - 1) * 3]!;
    let tty = tipY - graph.positions[(vs + tipIdx - 1) * 3 + 1]!;
    let ttz = tipZ - graph.positions[(vs + tipIdx - 1) * 3 + 2]!;
    const ttLen = Math.hypot(ttx, tty, ttz) || 1;
    ttx /= ttLen; tty /= ttLen; ttz /= ttLen;

    const tipCapRingBase = vCursor;
    for (let s = 0; s < sides; s++) {
      const srcIdx = branchBaseV + tipIdx * (sides + 1) + s;
      positions[(tipCapRingBase + s) * 3] = positions[srcIdx * 3]!;
      positions[(tipCapRingBase + s) * 3 + 1] = positions[srcIdx * 3 + 1]!;
      positions[(tipCapRingBase + s) * 3 + 2] = positions[srcIdx * 3 + 2]!;
      normals[(tipCapRingBase + s) * 3] = ttx;
      normals[(tipCapRingBase + s) * 3 + 1] = tty;
      normals[(tipCapRingBase + s) * 3 + 2] = ttz;
      const theta = (s / sides) * 2 * Math.PI;
      uvs[(tipCapRingBase + s) * 2] = 0.5 + 0.5 * Math.cos(theta);
      uvs[(tipCapRingBase + s) * 2 + 1] = 0.5 + 0.5 * Math.sin(theta);
    }
    const tipCapCenter = tipCapRingBase + sides;
    positions[tipCapCenter * 3] = tipX;
    positions[tipCapCenter * 3 + 1] = tipY;
    positions[tipCapCenter * 3 + 2] = tipZ;
    normals[tipCapCenter * 3] = ttx;
    normals[tipCapCenter * 3 + 1] = tty;
    normals[tipCapCenter * 3 + 2] = ttz;
    uvs[tipCapCenter * 2] = 0.5;
    uvs[tipCapCenter * 2 + 1] = 0.5;
    vCursor = tipCapCenter + 1;
    // Winding: side rings walk CW viewed from +tangent (n1 × n2 = -tangent
    // in our frame convention), so a fan center→r[s]→r[s+1] is also CW
    // from +tangent — which gives the cap an OUTWARD normal facing the
    // viewer looking down the branch.
    for (let s = 0; s < sides; s++) {
      indices[iCursor++] = tipCapCenter;
      indices[iCursor++] = tipCapRingBase + s;
      indices[iCursor++] = tipCapRingBase + ((s + 1) % sides);
    }

    // ----- Base cap (root branches only) -----
    if (graph.parentIndex[b]! < 0) {
      const baseX = graph.positions[vs * 3]!;
      const baseY = graph.positions[vs * 3 + 1]!;
      const baseZ = graph.positions[vs * 3 + 2]!;
      // Outward direction at the base is the reverse of the first segment.
      let btx = baseX - graph.positions[(vs + 1) * 3]!;
      let bty = baseY - graph.positions[(vs + 1) * 3 + 1]!;
      let btz = baseZ - graph.positions[(vs + 1) * 3 + 2]!;
      const btLen = Math.hypot(btx, bty, btz) || 1;
      btx /= btLen; bty /= btLen; btz /= btLen;

      const baseCapRingBase = vCursor;
      for (let s = 0; s < sides; s++) {
        const srcIdx = branchBaseV + 0 * (sides + 1) + s;
        positions[(baseCapRingBase + s) * 3] = positions[srcIdx * 3]!;
        positions[(baseCapRingBase + s) * 3 + 1] = positions[srcIdx * 3 + 1]!;
        positions[(baseCapRingBase + s) * 3 + 2] = positions[srcIdx * 3 + 2]!;
        normals[(baseCapRingBase + s) * 3] = btx;
        normals[(baseCapRingBase + s) * 3 + 1] = bty;
        normals[(baseCapRingBase + s) * 3 + 2] = btz;
        const theta = (s / sides) * 2 * Math.PI;
        uvs[(baseCapRingBase + s) * 2] = 0.5 + 0.5 * Math.cos(theta);
        uvs[(baseCapRingBase + s) * 2 + 1] = 0.5 + 0.5 * Math.sin(theta);
      }
      const baseCapCenter = baseCapRingBase + sides;
      positions[baseCapCenter * 3] = baseX;
      positions[baseCapCenter * 3 + 1] = baseY;
      positions[baseCapCenter * 3 + 2] = baseZ;
      normals[baseCapCenter * 3] = btx;
      normals[baseCapCenter * 3 + 1] = bty;
      normals[baseCapCenter * 3 + 2] = btz;
      uvs[baseCapCenter * 2] = 0.5;
      uvs[baseCapCenter * 2 + 1] = 0.5;
      vCursor = baseCapCenter + 1;
      // Reverse winding so the cap normal faces -tangent (down/out at base).
      for (let s = 0; s < sides; s++) {
        indices[iCursor++] = baseCapCenter;
        indices[iCursor++] = baseCapRingBase + ((s + 1) % sides);
        indices[iCursor++] = baseCapRingBase + s;
      }
    }
  }

  return { positions, normals, uvs, indices };
}

// ===== Sample points ====================================================

export interface SamplePointsOpts {
  depthMin: number;
  depthMax: number;
  radiusMin: number;
  radiusMax: number;
  onlyTips: boolean;
  /** Points per unit arc length. Ignored when onlyTips is true. */
  density: number;
  /**
   * Points emitted per qualifying tip when onlyTips is true. >=1.
   * 1 = one point at the tip oriented along the branch tangent (default).
   * N>1 = N points at the tip with normals fanned around the tangent in
   * the (n1, n2) plane — drives palm-frond / cluster-of-needles placement.
   * Ignored when onlyTips is false.
   */
  tipCount: number;
  seed: number;
}

export function sampleBranchGraphPoints(
  graph: BranchGraphValue,
  opts: SamplePointsOpts,
): PointCloudValue {
  const rand = mulberry32(Math.floor(opts.seed * 1_000_000) || 1);
  const outPos: number[] = [];
  const outNorm: number[] = [];

  for (let b = 0; b < graph.branchCount; b++) {
    const depth = graph.branchDepth[b]!;
    if (depth < opts.depthMin || depth > opts.depthMax) continue;

    const vs = graph.vertexStart[b]!;
    const vc = graph.vertexLength[b]!;
    if (vc < 2) continue;

    if (opts.onlyTips) {
      const tipIdx = vs + vc - 1;
      const r = graph.radii[tipIdx]!;
      if (r < opts.radiusMin || r > opts.radiusMax) continue;
      const tipX = graph.positions[tipIdx * 3]!;
      const tipY = graph.positions[tipIdx * 3 + 1]!;
      const tipZ = graph.positions[tipIdx * 3 + 2]!;
      const prevIdx = vs + vc - 2;
      let tx = tipX - graph.positions[prevIdx * 3]!;
      let ty = tipY - graph.positions[prevIdx * 3 + 1]!;
      let tz = tipZ - graph.positions[prevIdx * 3 + 2]!;
      const tlen = Math.hypot(tx, ty, tz) || 1;
      tx /= tlen; ty /= tlen; tz /= tlen;

      const tipCount = Math.max(1, Math.floor(opts.tipCount));
      if (tipCount === 1) {
        // One point at the tip oriented along the branch tangent — good for
        // single flowers / fruit on a twig.
        outPos.push(tipX, tipY, tipZ);
        outNorm.push(tx, ty, tz);
      } else {
        // N points at the tip, normals fanned radially around the tangent.
        // Palm fronds, pine-needle clusters, anything that radiates from a
        // single attachment ring.
        const frames = computePolylineFrames(graph.positions, vs, vc);
        const tipFrame = frames[vc - 1]!;
        const baseAngle = rand() * 2 * Math.PI;
        for (let k = 0; k < tipCount; k++) {
          const phi = baseAngle + (k / tipCount) * 2 * Math.PI;
          const c = Math.cos(phi);
          const sn = Math.sin(phi);
          const dx = c * tipFrame.n1x + sn * tipFrame.n2x;
          const dy = c * tipFrame.n1y + sn * tipFrame.n2y;
          const dz = c * tipFrame.n1z + sn * tipFrame.n2z;
          outPos.push(tipX, tipY, tipZ);
          outNorm.push(dx, dy, dz);
        }
      }
      continue;
    }

    const frames = computePolylineFrames(graph.positions, vs, vc);

    for (let i = 0; i < vc - 1; i++) {
      const idx0 = vs + i;
      const idx1 = vs + i + 1;
      const r0 = graph.radii[idx0]!;
      const r1 = graph.radii[idx1]!;
      const rAvg = (r0 + r1) * 0.5;
      if (rAvg < opts.radiusMin || rAvg > opts.radiusMax) continue;

      const segLen = graph.arcLength[idx1]! - graph.arcLength[idx0]!;
      const exact = segLen * opts.density;
      let count = Math.floor(exact);
      if (rand() < exact - count) count++;
      if (count === 0) continue;

      const p0x = graph.positions[idx0 * 3]!;
      const p0y = graph.positions[idx0 * 3 + 1]!;
      const p0z = graph.positions[idx0 * 3 + 2]!;
      const p1x = graph.positions[idx1 * 3]!;
      const p1y = graph.positions[idx1 * 3 + 1]!;
      const p1z = graph.positions[idx1 * 3 + 2]!;
      const f0 = frames[i]!;

      for (let k = 0; k < count; k++) {
        const t = rand();
        const x = p0x + (p1x - p0x) * t;
        const y = p0y + (p1y - p0y) * t;
        const z = p0z + (p1z - p0z) * t;
        const r = r0 + (r1 - r0) * t;

        // Radial direction in the n1-n2 plane at a random azimuth. Position
        // sits ON the branch surface; the normal points outward — leaves
        // attached at these points face away from the branch.
        const phi = rand() * 2 * Math.PI;
        const c = Math.cos(phi);
        const sn = Math.sin(phi);
        const dx = c * f0.n1x + sn * f0.n2x;
        const dy = c * f0.n1y + sn * f0.n2y;
        const dz = c * f0.n1z + sn * f0.n2z;

        outPos.push(x + dx * r, y + dy * r, z + dz * r);
        outNorm.push(dx, dy, dz);
      }
    }
  }

  return {
    positions: new Float32Array(outPos),
    normals: new Float32Array(outNorm),
    count: outPos.length / 3,
  };
}

// ===== Tropism ===========================================================

export interface TropismOpts {
  /** Per-depth gravity sag strength. 0 = no sag. */
  gravity: number;
  /** Vec3 direction × strength; bends branches toward this world vector. */
  phototropism: readonly [number, number, number];
  /** Per-vertex random jitter magnitude (scales with branch depth). */
  wobble: number;
  wobbleSeed: number;
}

export function applyTropismToBranchGraph(
  graph: BranchGraphValue,
  opts: TropismOpts,
): BranchGraphValue {
  if (graph.branchCount === 0) return graph;
  const rand = mulberry32(Math.floor(opts.wobbleSeed * 1_000_000) || 1);

  // Per-vertex offset (additive over the original positions). Computed in
  // topological order — parents come before children by construction.
  // Children inherit their parent's vertex offset at the attach point,
  // then apply their own local sag on top.
  const vOff = new Float32Array(graph.vertexCount * 3);

  for (let b = 0; b < graph.branchCount; b++) {
    const vs = graph.vertexStart[b]!;
    const vc = graph.vertexLength[b]!;
    const parentIdx = graph.parentIndex[b]!;

    // Base offset inherited from parent at attach point (linear-interp the
    // two parent vertices straddling parentT). Keeps children glued to
    // their bent parents.
    let bx = 0, by = 0, bz = 0;
    if (parentIdx >= 0) {
      const pVs = graph.vertexStart[parentIdx]!;
      const pVc = graph.vertexLength[parentIdx]!;
      const tExact = graph.parentT[b]! * (pVc - 1);
      const i0 = Math.max(0, Math.min(pVc - 1, Math.floor(tExact)));
      const i1 = Math.min(pVc - 1, i0 + 1);
      const f = tExact - i0;
      const o0x = vOff[(pVs + i0) * 3]!;
      const o0y = vOff[(pVs + i0) * 3 + 1]!;
      const o0z = vOff[(pVs + i0) * 3 + 2]!;
      const o1x = vOff[(pVs + i1) * 3]!;
      const o1y = vOff[(pVs + i1) * 3 + 1]!;
      const o1z = vOff[(pVs + i1) * 3 + 2]!;
      bx = o0x + (o1x - o0x) * f;
      by = o0y + (o1y - o0y) * f;
      bz = o0z + (o1z - o0z) * f;
    }

    const depth = graph.branchDepth[b]!;
    const baseArc = graph.arcLength[vs]!;
    const tipArc = graph.arcLength[vs + vc - 1]!;
    const branchLen = tipArc - baseArc;

    for (let i = 0; i < vc; i++) {
      const idx = vs + i;
      let sagX = 0, sagY = 0, sagZ = 0;
      // Trunk (depth 0) stays straight; bending scales with depth so the
      // outer twigs sag most.
      if (depth > 0 && branchLen > 1e-6) {
        const localT = (graph.arcLength[idx]! - baseArc) / branchLen;
        const localTSq = localT * localT;
        const mag = depth * localTSq * branchLen;
        sagX = opts.phototropism[0] * mag;
        sagY = -opts.gravity * mag + opts.phototropism[1] * mag;
        sagZ = opts.phototropism[2] * mag;
      }
      const wobbleScale = opts.wobble * depth;
      const wx = (rand() * 2 - 1) * wobbleScale;
      const wy = (rand() * 2 - 1) * wobbleScale;
      const wz = (rand() * 2 - 1) * wobbleScale;

      vOff[idx * 3] = bx + sagX + wx;
      vOff[idx * 3 + 1] = by + sagY + wy;
      vOff[idx * 3 + 2] = bz + sagZ + wz;
    }
  }

  const newPositions = new Float32Array(graph.vertexCount * 3);
  for (let i = 0; i < graph.vertexCount * 3; i++) {
    newPositions[i] = graph.positions[i]! + vOff[i]!;
  }

  return { ...graph, positions: newPositions };
}

// ===== Palm =============================================================
// Single unbranched trunk. No children. Fronds are placed downstream by
// `branch/sample-points` with onlyTips=true and tipCount=N, then instanced
// via `instance-geometry-on-points`. Variants (banana, tree fern, agave)
// fall out from parameter tuning.

export interface PalmOpts {
  height: number;
  trunkRadiusBase: number;
  trunkRadiusTip: number;
  trunkSegments: number;
  /** Initial tilt from vertical at the trunk base, in degrees. */
  leanAngleDeg: number;
  /** Additional degrees of bend per trunk segment (positive = continues
   * tilting in lean direction; negative = bends back). */
  leanCurvatureDeg: number;
  /** Direction in the XZ plane (degrees, 0 = +X) the trunk leans toward. */
  leanAzimuthDeg: number;
  seed: number;
}

export function generatePalmBranchGraph(opts: PalmOpts): BranchGraphValue {
  // The lean tilt axis is the horizontal direction perpendicular to the
  // azimuth — rotating (0,1,0) around this axis tilts the top toward the
  // azimuth direction.
  const azimuth = degToRad(opts.leanAzimuthDeg);
  const tiltAxis: [number, number, number] = [-Math.sin(azimuth), 0, Math.cos(azimuth)];
  const initialDir = normalize(rotateAxisAngle([0, 1, 0], tiltAxis, degToRad(opts.leanAngleDeg)));

  const trunk = growBranch({
    base: [0, 0, 0],
    direction: initialDir,
    length: opts.height,
    rootRadius: opts.trunkRadiusBase,
    tipRadius: opts.trunkRadiusTip,
    segments: opts.trunkSegments,
    curvatureRad: degToRad(opts.leanCurvatureDeg),
    curvatureAxis: tiltAxis,
    parentIndex: -1,
    parentT: 0,
    depth: 0,
  });
  // seed is unused for now — kept in the signature so future trunk-wobble
  // variation has somewhere to plug in.
  void opts.seed;
  return finalizeBranches([trunk]);
}

// ===== Whorled pine =====================================================
// Monopodial: a single dominant trunk with lateral branches in WHORLS
// (rings) at regular intervals. Branches don't bend in the generator —
// pipe `branch/tropism` downstream to get the characteristic pine droop.

export interface WhorledPineOpts {
  trunkHeight: number;
  trunkRadiusBase: number;
  trunkRadiusTip: number;
  trunkSegments: number;
  trunkLeanDeg: number;
  whorlCount: number;
  /** Fraction of trunk height (0..1) where the lowest whorl sits. */
  whorlStart: number;
  /** Fraction of trunk height (0..1) where the topmost whorl sits. */
  whorlEnd: number;
  branchesPerWhorl: number;
  /** Rotation (degrees) of each whorl's azimuth relative to the previous. */
  whorlPhaseOffsetDeg: number;
  /** Whorl-branch length at the lowest whorl. */
  branchLengthAtBase: number;
  /** Whorl-branch length at the topmost whorl (shorter than base → cone). */
  branchLengthAtTop: number;
  /** Tilt of whorl branches from the trunk tangent, degrees. 90 = horizontal. */
  branchAngleDeg: number;
  branchSegments: number;
  /** Whorl-branch root radius = trunk radius at attach × branchRadiusFraction. */
  branchRadiusFraction: number;
  /** Whorl-branch tip radius = root radius × this. */
  branchTipRadiusFraction: number;
  /** Sub-branches per whorl branch (0 = none — most species). */
  subBranchCount: number;
  /** Sub-branch length as a fraction of the parent whorl branch length. */
  subBranchLengthRatio: number;
  subBranchAngleDeg: number;
  seed: number;
}

export function generateWhorledPineBranchGraph(opts: WhorledPineOpts): BranchGraphValue {
  const rand = mulberry32(Math.floor(opts.seed * 1_000_000) || 1);
  const branches: RawBranch[] = [];

  // Trunk: optional lean in a random azimuth.
  const trunkAzimuth = rand() * 2 * Math.PI;
  const trunkTiltAxis: [number, number, number] = [
    -Math.sin(trunkAzimuth),
    0,
    Math.cos(trunkAzimuth),
  ];
  const trunkDir = normalize(rotateAxisAngle([0, 1, 0], trunkTiltAxis, degToRad(opts.trunkLeanDeg)));

  const trunk = growBranch({
    base: [0, 0, 0],
    direction: trunkDir,
    length: opts.trunkHeight,
    rootRadius: opts.trunkRadiusBase,
    tipRadius: opts.trunkRadiusTip,
    segments: opts.trunkSegments,
    curvatureRad: 0,
    curvatureAxis: trunkTiltAxis,
    parentIndex: -1,
    parentT: 0,
    depth: 0,
  });
  branches.push(trunk);

  const whorlCount = Math.max(1, Math.floor(opts.whorlCount));
  let phase = rand() * 2 * Math.PI;

  for (let w = 0; w < whorlCount; w++) {
    const whorlFrac =
      whorlCount === 1
        ? (opts.whorlStart + opts.whorlEnd) * 0.5
        : opts.whorlStart + (opts.whorlEnd - opts.whorlStart) * (w / (whorlCount - 1));

    const whorlPos = polylineLookup(trunk.polyline, whorlFrac);
    const trunkTangentHere = polylineTangent(trunk.polyline, whorlFrac);

    // Trunk radius at this height (linear taper assumed).
    const trunkR = opts.trunkRadiusBase + (opts.trunkRadiusTip - opts.trunkRadiusBase) * whorlFrac;
    const whorlBranchRoot = trunkR * opts.branchRadiusFraction;

    // Length tapers from base whorl to top whorl.
    const lengthFrac = whorlCount === 1 ? 0 : w / (whorlCount - 1);
    const branchLen =
      opts.branchLengthAtBase + (opts.branchLengthAtTop - opts.branchLengthAtBase) * lengthFrac;

    // A reference perpendicular to the trunk tangent, used as the
    // "outward" anchor for each branch's azimuth around the trunk.
    const trunkPerp = pickPerpendicular(trunkTangentHere);

    for (let k = 0; k < opts.branchesPerWhorl; k++) {
      const angleAround = phase + (k / opts.branchesPerWhorl) * 2 * Math.PI;
      const outward = normalize(rotateAxisAngle(trunkPerp, trunkTangentHere, angleAround));
      // Branch direction: rotate trunk tangent toward `outward` by branchAngleDeg.
      const tiltAxis = normalize(cross(trunkTangentHere, outward));
      const branchDir = normalize(
        rotateAxisAngle(trunkTangentHere, tiltAxis, degToRad(opts.branchAngleDeg)),
      );

      const whorlBranch = growBranch({
        base: whorlPos,
        direction: branchDir,
        length: branchLen,
        rootRadius: whorlBranchRoot,
        tipRadius: whorlBranchRoot * opts.branchTipRadiusFraction,
        segments: Math.max(2, Math.floor(opts.branchSegments)),
        curvatureRad: 0,
        curvatureAxis: tiltAxis,
        parentIndex: 0,
        parentT: whorlFrac,
        depth: 1,
      });
      const whorlIdx = branches.length;
      branches.push(whorlBranch);

      // Sub-branches: evenly along the parent's upper portion. Alternate
      // sides so they don't all stack vertically.
      if (opts.subBranchCount > 0) {
        const subN = Math.floor(opts.subBranchCount);
        for (let s = 0; s < subN; s++) {
          const tSub = 0.35 + (0.55 * (s + 0.5)) / subN;
          const subBase = polylineLookup(whorlBranch.polyline, tSub);
          const subTangent = polylineTangent(whorlBranch.polyline, tSub);
          const subPerp = pickPerpendicular(subTangent);
          const subAngleAround = (s % 2 === 0 ? 1 : -1) * (Math.PI * 0.5) + rand() * 0.4;
          const subOutward = normalize(rotateAxisAngle(subPerp, subTangent, subAngleAround));
          const subTiltAxis = normalize(cross(subTangent, subOutward));
          const subDir = normalize(
            rotateAxisAngle(subTangent, subTiltAxis, degToRad(opts.subBranchAngleDeg)),
          );

          const subRootRadius = whorlBranchRoot * 0.55;
          branches.push(
            growBranch({
              base: subBase,
              direction: subDir,
              length: branchLen * opts.subBranchLengthRatio,
              rootRadius: subRootRadius,
              tipRadius: subRootRadius * opts.branchTipRadiusFraction,
              segments: Math.max(2, Math.floor(opts.branchSegments * 0.6)),
              curvatureRad: 0,
              curvatureAxis: subTiltAxis,
              parentIndex: whorlIdx,
              parentT: tSub,
              depth: 2,
            }),
          );
        }
      }
    }

    phase += degToRad(opts.whorlPhaseOffsetDeg);
  }

  return finalizeBranches(branches);
}

// ===== Merge ============================================================
// Concatenate two BranchGraphs into one. `b`'s branches are appended after
// `a`'s — parentIndex values are shifted by a.branchCount, vertexStart
// offsets are shifted by a.vertexCount, and root branches in `b` stay
// rootful (parentIndex = -1). The resulting graph can have multiple roots;
// every downstream consumer iterates branches and handles that fine.

export function mergeBranchGraphs(
  a: BranchGraphValue,
  b: BranchGraphValue,
): BranchGraphValue {
  if (a.branchCount === 0) return b;
  if (b.branchCount === 0) return a;

  const branchCount = a.branchCount + b.branchCount;
  const vertexCount = a.vertexCount + b.vertexCount;

  const parentIndex = new Int32Array(branchCount);
  const parentT = new Float32Array(branchCount);
  const branchDepth = new Int32Array(branchCount);
  const vertexStart = new Uint32Array(branchCount);
  const vertexLength = new Uint32Array(branchCount);

  parentIndex.set(a.parentIndex, 0);
  parentT.set(a.parentT, 0);
  branchDepth.set(a.branchDepth, 0);
  vertexStart.set(a.vertexStart, 0);
  vertexLength.set(a.vertexLength, 0);

  for (let i = 0; i < b.branchCount; i++) {
    const p = b.parentIndex[i]!;
    parentIndex[a.branchCount + i] = p === -1 ? -1 : p + a.branchCount;
    parentT[a.branchCount + i] = b.parentT[i]!;
    branchDepth[a.branchCount + i] = b.branchDepth[i]!;
    vertexStart[a.branchCount + i] = b.vertexStart[i]! + a.vertexCount;
    vertexLength[a.branchCount + i] = b.vertexLength[i]!;
  }

  const positions = new Float32Array(vertexCount * 3);
  positions.set(a.positions, 0);
  positions.set(b.positions, a.vertexCount * 3);

  const radii = new Float32Array(vertexCount);
  radii.set(a.radii, 0);
  radii.set(b.radii, a.vertexCount);

  const arcLengthArr = new Float32Array(vertexCount);
  arcLengthArr.set(a.arcLength, 0);
  arcLengthArr.set(b.arcLength, a.vertexCount);

  return {
    branchCount,
    vertexCount,
    parentIndex,
    parentT,
    branchDepth,
    vertexStart,
    vertexLength,
    positions,
    radii,
    arcLength: arcLengthArr,
  };
}

// ===== Space colonization (Runions et al.) ==============================
// Attractor-driven canopy growth. Given a cloud of attractor points
// (typically scattered inside the desired crown volume), grow a tree
// from a single root toward the attractors. Each iteration:
//
//   1. Each attractor pulls its nearest tree node toward it (if within
//      `attractorRadius`).
//   2. Each pulled node grows a new child node one `segmentLength` step
//      in the average direction of its attractors (optionally biased
//      upward to discourage horizontal sprawl).
//   3. Attractors within `killRadius` of any tree node are consumed.
//
// Branch radii are assigned via Murray's law (R^p = sum c_i^p) bottom-up
// from leaves, then rescaled so the root matches `rootRadius`. Produces
// natural deciduous topology — irregular forking, varied lengths, canopy-
// conforming shape.

export interface SpaceColonizationOpts {
  /** Attractor positions (Float32Array, length = count*3). */
  attractors: Float32Array;
  attractorCount: number;
  trunkStart: readonly [number, number, number];
  /** Direction used to grow the very first segment when no attractor is
   * yet within `attractorRadius` of the root. Lets the trunk reach a
   * canopy lifted above its start position. */
  trunkInitialDirection: readonly [number, number, number];
  /** Influence radius — only attractors within this distance of their
   * nearest node count. A few × `segmentLength` works well. */
  attractorRadius: number;
  /** Attractor consumption radius. Should be ~ `segmentLength`. */
  killRadius: number;
  /** Step size per growth iteration. */
  segmentLength: number;
  /** Hard cap on iterations (also bounds branch count). */
  maxIterations: number;
  /** Y-axis pull added to each growth direction. Small positive values
   * (~0.1) prevent attractor balance from producing horizontal sprawl. */
  upBias: number;
  rootRadius: number;
  /** Leaf-node radius before Murray aggregation. */
  tipRadius: number;
  /** Murray's-law exponent. 2.0 = area conservation, 2.5–3.0 typical. */
  radiusExponent: number;
}

interface ScNode {
  pos: [number, number, number];
  parent: number; // -1 for root
  radius: number;
  children: number[];
}

export function generateSpaceColonizationBranchGraph(
  opts: SpaceColonizationOpts,
): BranchGraphValue {
  // Copy attractors into a plain array so we can splice as they're killed.
  const attractors: Array<[number, number, number]> = [];
  for (let i = 0; i < opts.attractorCount; i++) {
    attractors.push([
      opts.attractors[i * 3]!,
      opts.attractors[i * 3 + 1]!,
      opts.attractors[i * 3 + 2]!,
    ]);
  }

  const nodes: ScNode[] = [
    {
      pos: [opts.trunkStart[0], opts.trunkStart[1], opts.trunkStart[2]],
      parent: -1,
      radius: 0,
      children: [],
    },
  ];

  const dInfSq = opts.attractorRadius * opts.attractorRadius;
  const dKillSq = opts.killRadius * opts.killRadius;
  const initialDir = normalize([
    opts.trunkInitialDirection[0],
    opts.trunkInitialDirection[1],
    opts.trunkInitialDirection[2],
  ]);

  for (let iter = 0; iter < opts.maxIterations; iter++) {
    // O(A * N) nearest-node lookup. Fine for A,N in the few hundreds;
    // spatial index is a known optimization when profiling demands it.
    const influence: Map<number, [number, number, number][]> = new Map();
    for (const a of attractors) {
      let bestI = -1;
      let bestDSq = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]!;
        const dx = n.pos[0] - a[0];
        const dy = n.pos[1] - a[1];
        const dz = n.pos[2] - a[2];
        const dsq = dx * dx + dy * dy + dz * dz;
        if (dsq < bestDSq) {
          bestDSq = dsq;
          bestI = i;
        }
      }
      if (bestI >= 0 && bestDSq <= dInfSq) {
        let list = influence.get(bestI);
        if (!list) {
          list = [];
          influence.set(bestI, list);
        }
        list.push(a);
      }
    }

    if (influence.size === 0) {
      // No attractor reaches any node yet. Extend the most-recent tip one
      // segment in its current direction (or the seed direction for the
      // root) so a lifted canopy is reachable. Bounded by maxIterations.
      const latestIdx = nodes.length - 1;
      const latest = nodes[latestIdx]!;
      let dirX = initialDir[0];
      let dirY = initialDir[1];
      let dirZ = initialDir[2];
      if (latest.parent >= 0) {
        const par = nodes[latest.parent]!;
        const dx = latest.pos[0] - par.pos[0];
        const dy = latest.pos[1] - par.pos[1];
        const dz = latest.pos[2] - par.pos[2];
        const len = Math.hypot(dx, dy, dz) || 1;
        dirX = dx / len;
        dirY = dy / len;
        dirZ = dz / len;
      }
      const newPos: [number, number, number] = [
        latest.pos[0] + dirX * opts.segmentLength,
        latest.pos[1] + dirY * opts.segmentLength,
        latest.pos[2] + dirZ * opts.segmentLength,
      ];
      const newIdx = nodes.length;
      nodes.push({ pos: newPos, parent: latestIdx, radius: 0, children: [] });
      latest.children.push(newIdx);
      continue;
    }

    const newStart = nodes.length;
    for (const [nodeIdx, attrs] of influence) {
      const node = nodes[nodeIdx]!;
      let dx = 0, dy = 0, dz = 0;
      for (const a of attrs) {
        const vx = a[0] - node.pos[0];
        const vy = a[1] - node.pos[1];
        const vz = a[2] - node.pos[2];
        const len = Math.hypot(vx, vy, vz) || 1;
        dx += vx / len;
        dy += vy / len;
        dz += vz / len;
      }
      dy += opts.upBias;
      const dlen = Math.hypot(dx, dy, dz) || 1;
      dx /= dlen; dy /= dlen; dz /= dlen;

      const newPos: [number, number, number] = [
        node.pos[0] + dx * opts.segmentLength,
        node.pos[1] + dy * opts.segmentLength,
        node.pos[2] + dz * opts.segmentLength,
      ];
      const newIdx = nodes.length;
      nodes.push({ pos: newPos, parent: nodeIdx, radius: 0, children: [] });
      node.children.push(newIdx);
    }

    // Kill attractors within killRadius of any node. Most kills come from
    // the just-added nodes, so check those first.
    let w = 0;
    for (let r = 0; r < attractors.length; r++) {
      const a = attractors[r]!;
      let alive = true;
      for (let i = newStart; i < nodes.length && alive; i++) {
        const n = nodes[i]!;
        const dx = n.pos[0] - a[0];
        const dy = n.pos[1] - a[1];
        const dz = n.pos[2] - a[2];
        if (dx * dx + dy * dy + dz * dz <= dKillSq) alive = false;
      }
      if (alive) {
        for (let i = 0; i < newStart && alive; i++) {
          const n = nodes[i]!;
          const dx = n.pos[0] - a[0];
          const dy = n.pos[1] - a[1];
          const dz = n.pos[2] - a[2];
          if (dx * dx + dy * dy + dz * dz <= dKillSq) alive = false;
        }
      }
      if (alive) attractors[w++] = a;
    }
    attractors.length = w;

    if (attractors.length === 0) break;
  }

  // Radii: distance-to-deepest-tip taper.
  //
  // Each node gets `depth = max path-length from this node to any tip
  // in its subtree`. The root's depth is the longest root-to-tip path.
  // Map depth ∈ [0, maxDepth] → radius ∈ [tipRadius, rootRadius] via
  // linear interpolation. Every root-to-tip path therefore tapers
  // continuously from rootRadius at the base to tipRadius at the tip
  // — no flat-trunk-then-step-down at a fork.
  //
  // We deliberately drop the strict Murray's-law pipe model here. Pipe
  // model says radius is CONSTANT between branching points (because
  // cross-sectional area = sum of downstream tip areas, which doesn't
  // change without a fork). Visually that produces a club-shaped trunk
  // on low-branch-count trees: the trunk holds rootRadius all the way
  // up to the first fork, then steps down sharply. Distance-based
  // taper matches what we see in real wood with secondary growth and
  // is what the user can actually shape via the rootRadius / tipRadius
  // inputs — `radiusExponent` is now unused by this generator
  // (retained on the input list for backwards compat with saved
  // projects; future Murray-mode toggle could reactivate it).
  const depths = new Float32Array(nodes.length);
  for (let idx = nodes.length - 1; idx >= 0; idx--) {
    const node = nodes[idx]!;
    if (node.children.length === 0) {
      depths[idx] = 0;
    } else {
      let maxDeep = 0;
      for (const ci of node.children) {
        const child = nodes[ci]!;
        const dx = child.pos[0] - node.pos[0];
        const dy = child.pos[1] - node.pos[1];
        const dz = child.pos[2] - node.pos[2];
        const seg = Math.hypot(dx, dy, dz);
        const d = seg + depths[ci]!;
        if (d > maxDeep) maxDeep = d;
      }
      depths[idx] = maxDeep;
    }
  }

  const maxDepth = depths[0]!;
  if (maxDepth > 1e-9) {
    const range = opts.rootRadius - opts.tipRadius;
    for (let i = 0; i < nodes.length; i++) {
      const t = depths[i]! / maxDepth;
      nodes[i]!.radius = opts.tipRadius + t * range;
    }
  } else {
    // Degenerate: single root node, nothing to taper.
    for (const n of nodes) n.radius = opts.rootRadius;
  }

  return nodeTreeToBranchGraph(nodes);
}

function nodeTreeToBranchGraph(nodes: ScNode[]): BranchGraphValue {
  if (nodes.length === 0) return emptyBranchGraph();
  if (nodes.length === 1) {
    return finalizeBranches([
      {
        parentIndex: -1,
        parentT: 0,
        depth: 0,
        polyline: [[nodes[0]!.pos[0], nodes[0]!.pos[1], nodes[0]!.pos[2]]],
        radii: [nodes[0]!.radius],
      },
    ]);
  }

  const raws: RawBranch[] = [];

  // Emit a chain starting at `head`. When a node has multiple children we
  // pick a "dominant" one whose direction best continues the incoming
  // tangent (or `+Y` as a tiebreak at the root) and merge it into THIS
  // chain. Non-dominant siblings become new branches that attach
  // mid-parent at the branch-point's parametric position.
  //
  // This matches how the recursive generator emits children — they
  // branch off mid-parent rather than at the parent's end, so the
  // parent's tube remains continuous through the joint and the child's
  // first ring (after snapping in `sweepBranchGraphToMesh`) emerges from
  // the parent's intact surface. No more wedge gaps where the parent
  // formerly terminated.
  function emitChain(
    head: number,
    parentBranchIdx: number,
    parentT: number,
    depth: number,
    leading: { pos: [number, number, number]; radius: number } | null,
  ): void {
    const polyline: Array<[number, number, number]> = [];
    const radii: number[] = [];
    // (vertexIndexInPolyline, [nonDominantSiblingNodeIdx]) per branch
    // point on this chain. Emitted after the chain is complete so each
    // sibling's parentT reflects the final polyline length.
    const pendingSiblings: Array<{ vertexIdx: number; siblings: number[] }> = [];

    let prevPosX = 0, prevPosY = 0, prevPosZ = 0;
    let havePrev = false;
    let lastDirX = 0, lastDirY = 1, lastDirZ = 0; // default: +Y tiebreak
    let haveDir = false;

    if (leading) {
      polyline.push([leading.pos[0], leading.pos[1], leading.pos[2]]);
      radii.push(leading.radius);
      prevPosX = leading.pos[0];
      prevPosY = leading.pos[1];
      prevPosZ = leading.pos[2];
      havePrev = true;
    }

    let cur = head;
    while (true) {
      const n = nodes[cur]!;
      polyline.push([n.pos[0], n.pos[1], n.pos[2]]);
      radii.push(n.radius);

      if (havePrev) {
        const dx = n.pos[0] - prevPosX;
        const dy = n.pos[1] - prevPosY;
        const dz = n.pos[2] - prevPosZ;
        const dLen = Math.hypot(dx, dy, dz) || 1;
        lastDirX = dx / dLen;
        lastDirY = dy / dLen;
        lastDirZ = dz / dLen;
        haveDir = true;
      }
      prevPosX = n.pos[0];
      prevPosY = n.pos[1];
      prevPosZ = n.pos[2];
      havePrev = true;

      if (n.children.length === 0) break; // leaf

      // Pick the dominant child. With prior direction, most aligned.
      // Without (root, no leading), bias upward.
      let dominantIdx: number;
      if (n.children.length === 1) {
        dominantIdx = n.children[0]!;
      } else {
        let bestDot = -Infinity;
        let bestIdx = n.children[0]!;
        for (const ci of n.children) {
          const c = nodes[ci]!;
          const cdx = c.pos[0] - n.pos[0];
          const cdy = c.pos[1] - n.pos[1];
          const cdz = c.pos[2] - n.pos[2];
          const cdLen = Math.hypot(cdx, cdy, cdz) || 1;
          const dot = haveDir
            ? (cdx * lastDirX + cdy * lastDirY + cdz * lastDirZ) / cdLen
            : cdy / cdLen;
          if (dot > bestDot) {
            bestDot = dot;
            bestIdx = ci;
          }
        }
        dominantIdx = bestIdx;
        const siblings = n.children.filter((ci) => ci !== dominantIdx);
        if (siblings.length > 0) {
          pendingSiblings.push({ vertexIdx: polyline.length - 1, siblings });
        }
      }

      cur = dominantIdx;
    }

    const myIdx = raws.length;
    raws.push({ parentIndex: parentBranchIdx, parentT, depth, polyline, radii });

    // Emit non-dominant siblings as new branches. Each sibling's polyline
    // starts at the branch-point position (passed as `leading`) so its
    // first ring is centered on the parent's centerline — exactly where
    // the snap-to-parent-surface step in the tube sweep expects it.
    const numSegs = polyline.length - 1;
    for (const ps of pendingSiblings) {
      const t = numSegs > 0 ? ps.vertexIdx / numSegs : 0;
      const bpPos: [number, number, number] = [
        polyline[ps.vertexIdx]![0],
        polyline[ps.vertexIdx]![1],
        polyline[ps.vertexIdx]![2],
      ];
      const bpRadius = radii[ps.vertexIdx]!;
      const sharedLeading = { pos: bpPos, radius: bpRadius };
      for (const siblingIdx of ps.siblings) {
        emitChain(siblingIdx, myIdx, t, depth + 1, sharedLeading);
      }
    }
  }

  const root = nodes[0]!;
  if (root.children.length === 0) {
    // Degenerate handled at top; defensive return.
    return emptyBranchGraph();
  }
  emitChain(0, -1, 0, 0, null);

  return finalizeBranches(raws);
}
