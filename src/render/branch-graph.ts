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

export function sweepBranchGraphToMesh(graph: BranchGraphValue, opts: TubeOpts): CpuMesh {
  const sides = Math.max(3, Math.floor(opts.sides));

  // Each branch gets its own ring-strip section (no Y-joint blending in
  // Phase 1; branches plain-intersect their parents). +1 ring vertex per
  // segment row for UV-seam continuity.
  let totalV = 0;
  let totalI = 0;
  for (let b = 0; b < graph.branchCount; b++) {
    const vc = graph.vertexLength[b]!;
    if (vc < 2) continue;
    totalV += vc * (sides + 1);
    totalI += (vc - 1) * sides * 6;
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

    for (let i = 0; i < vc; i++) {
      const px = graph.positions[(vs + i) * 3]!;
      const py = graph.positions[(vs + i) * 3 + 1]!;
      const pz = graph.positions[(vs + i) * 3 + 2]!;
      const r = graph.radii[vs + i]!;
      const arc = graph.arcLength[vs + i]!;
      const f = frames[i]!;

      for (let s = 0; s <= sides; s++) {
        const theta = (s / sides) * 2 * Math.PI;
        const c = Math.cos(theta);
        const sn = Math.sin(theta);
        const dx = c * f.n1x + sn * f.n2x;
        const dy = c * f.n1y + sn * f.n2y;
        const dz = c * f.n1z + sn * f.n2z;
        const idx = vCursor + i * (sides + 1) + s;
        positions[idx * 3] = px + dx * r;
        positions[idx * 3 + 1] = py + dy * r;
        positions[idx * 3 + 2] = pz + dz * r;
        normals[idx * 3] = dx;
        normals[idx * 3 + 1] = dy;
        normals[idx * 3 + 2] = dz;
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
      // One point at the branch tip, oriented along the branch tangent —
      // good for "this is a flower / fruit on a twig" placement.
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
      outPos.push(tipX, tipY, tipZ);
      outNorm.push(tx, ty, tz);
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
