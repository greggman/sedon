import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTropismToBranchGraph,
  generatePalmBranchGraph,
  generateRecursiveBranchGraph,
  generateSpaceColonizationBranchGraph,
  generateWhorledPineBranchGraph,
  mergeBranchGraphs,
  sampleBranchGraphPoints,
  sweepBranchGraphToMesh,
} from '../../src/render/branch-graph.js';

const DEFAULT_OPTS = {
  trunkHeight: 6,
  trunkRadius: 0.25,
  trunkSegments: 10,
  maxDepth: 3,
  branchesPerSegment: 1,
  branchStart: 0.4,
  branchAngleDeg: 50,
  branchAngleJitterDeg: 12,
  lengthRatio: 0.65,
  radiusRatio: 0.55,
  branchCurvatureDeg: 4,
  phyllotaxisDeg: 137.5,
  segmentRatio: 0.75,
  minSegmentsPerBranch: 3,
  tipRadiusFraction: 0.2,
  seed: 0.31,
};

test('branch/recursive yields a well-formed BranchGraph', () => {
  const g = generateRecursiveBranchGraph(DEFAULT_OPTS);
  assert.ok(g.branchCount >= 1, 'has at least the trunk branch');
  assert.ok(g.vertexCount >= g.branchCount, 'each branch has at least one vertex');
  assert.equal(g.parentIndex.length, g.branchCount);
  assert.equal(g.parentT.length, g.branchCount);
  assert.equal(g.branchDepth.length, g.branchCount);
  assert.equal(g.vertexStart.length, g.branchCount);
  assert.equal(g.vertexLength.length, g.branchCount);
  assert.equal(g.positions.length, g.vertexCount * 3);
  assert.equal(g.radii.length, g.vertexCount);
  assert.equal(g.arcLength.length, g.vertexCount);

  // Trunk should be branch 0, depth 0, parentIndex -1.
  assert.equal(g.branchDepth[0], 0);
  assert.equal(g.parentIndex[0], -1);

  // All non-root branches have a valid parent earlier in the array (pre-order).
  for (let b = 1; b < g.branchCount; b++) {
    const p = g.parentIndex[b]!;
    assert.ok(p >= 0 && p < b, `branch ${b} parent ${p} not earlier in array`);
    assert.equal(g.branchDepth[b], g.branchDepth[p]! + 1);
  }

  // All vertex ranges land in bounds and don't overlap.
  let lastEnd = 0;
  for (let b = 0; b < g.branchCount; b++) {
    const start = g.vertexStart[b]!;
    const len = g.vertexLength[b]!;
    assert.equal(start, lastEnd, `branch ${b} should start where previous ended`);
    lastEnd = start + len;
  }
  assert.equal(lastEnd, g.vertexCount);
});

test('branch/recursive positions are finite (no NaN/Inf)', () => {
  const g = generateRecursiveBranchGraph(DEFAULT_OPTS);
  for (let i = 0; i < g.positions.length; i++) {
    assert.ok(Number.isFinite(g.positions[i]!), `position[${i}] is not finite`);
  }
  for (let i = 0; i < g.radii.length; i++) {
    assert.ok(Number.isFinite(g.radii[i]!), `radius[${i}] is not finite`);
    assert.ok(g.radii[i]! > 0, `radius[${i}] not positive`);
  }
});

test('branch/recursive trunk base is at origin', () => {
  const g = generateRecursiveBranchGraph(DEFAULT_OPTS);
  // Trunk's first vertex
  assert.equal(g.positions[0], 0);
  assert.equal(g.positions[1], 0);
  assert.equal(g.positions[2], 0);
});

test('branch/tube produces a valid mesh', () => {
  const g = generateRecursiveBranchGraph(DEFAULT_OPTS);
  const mesh = sweepBranchGraphToMesh(g, { sides: 8, uvTilingV: 0.5 });
  assert.ok(mesh.positions.length > 0);
  assert.equal(mesh.normals.length, mesh.positions.length);
  assert.equal(mesh.uvs.length / 2, mesh.positions.length / 3);
  assert.equal(mesh.indices.length % 3, 0);
  // All indices in range.
  const vc = mesh.positions.length / 3;
  for (let i = 0; i < mesh.indices.length; i++) {
    assert.ok(mesh.indices[i]! < vc, `index ${i} out of range`);
  }
  // Normals are unit-length (ish).
  for (let i = 0; i < mesh.normals.length; i += 3) {
    const len = Math.hypot(mesh.normals[i]!, mesh.normals[i + 1]!, mesh.normals[i + 2]!);
    assert.ok(Math.abs(len - 1) < 1e-4, `normal ${i / 3} length ${len}`);
  }
});

test('branch/sample-points emits leaves on depth >= 1', () => {
  const g = generateRecursiveBranchGraph(DEFAULT_OPTS);
  const pc = sampleBranchGraphPoints(g, {
    depthMin: 1,
    depthMax: 99,
    radiusMin: 0,
    radiusMax: 99,
    onlyTips: false,
    density: 30,
    tipCount: 1,
    seed: 0.5,
  });
  assert.ok(pc.count > 0, 'should sample some points');
  assert.equal(pc.positions.length, pc.count * 3);
  assert.ok(pc.normals !== undefined);
  assert.equal(pc.normals!.length, pc.count * 3);
});

test('branch/sample-points onlyTips emits one point per qualifying branch', () => {
  const g = generateRecursiveBranchGraph(DEFAULT_OPTS);
  const pc = sampleBranchGraphPoints(g, {
    depthMin: 0,
    depthMax: 99,
    radiusMin: 0,
    radiusMax: 99,
    onlyTips: true,
    density: 0,
    tipCount: 1,
    seed: 0.5,
  });
  assert.equal(pc.count, g.branchCount);
});

test('branch/sample-points onlyTips with tipCount=N emits N points per tip', () => {
  const g = generateRecursiveBranchGraph(DEFAULT_OPTS);
  const tipCount = 6;
  const pc = sampleBranchGraphPoints(g, {
    depthMin: 0,
    depthMax: 99,
    radiusMin: 0,
    radiusMax: 99,
    onlyTips: true,
    density: 0,
    tipCount,
    seed: 0.5,
  });
  assert.equal(pc.count, g.branchCount * tipCount);
});

// Build a small attractor cloud on the surface of a sphere at (0, height, 0).
function sphereAttractors(
  centerY: number,
  radius: number,
  count: number,
): { attractors: Float32Array; attractorCount: number } {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Quasi-uniform sphere via golden-ratio spiral. Deterministic, no RNG.
    const u = (i + 0.5) / count;
    const theta = 2 * Math.PI * i * (1 + Math.sqrt(5)) / 2;
    const z = 1 - 2 * u;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    positions[i * 3] = Math.cos(theta) * r * radius;
    positions[i * 3 + 1] = centerY + z * radius;
    positions[i * 3 + 2] = Math.sin(theta) * r * radius;
  }
  return { attractors: positions, attractorCount: count };
}

const SC_DEFAULT_OPTS = {
  trunkStart: [0, 0, 0] as [number, number, number],
  trunkInitialDirection: [0, 1, 0] as [number, number, number],
  attractorRadius: 3.5,
  killRadius: 0.5,
  segmentLength: 0.4,
  maxIterations: 200,
  upBias: 0.18,
  rootRadius: 0.3,
  tipRadius: 0.04,
  radiusExponent: 2.5,
};

test('branch/space-colonization grows a non-trivial tree toward attractors', () => {
  const { attractors, attractorCount } = sphereAttractors(9, 4, 120);
  const g = generateSpaceColonizationBranchGraph({
    ...SC_DEFAULT_OPTS,
    attractors,
    attractorCount,
  });
  assert.ok(g.branchCount >= 2, 'expected at least a trunk + 1 child branch');
  assert.ok(g.vertexCount >= g.branchCount);
  // Trunk anchored at origin.
  assert.equal(g.positions[0], 0);
  assert.equal(g.positions[1], 0);
  assert.equal(g.positions[2], 0);
  // Root branch carries depth 0 and is a root.
  assert.equal(g.parentIndex[0], -1);
  assert.equal(g.branchDepth[0], 0);
  // At least one vertex made it into the canopy zone (y > 5).
  let reachedCanopy = false;
  for (let v = 0; v < g.vertexCount; v++) {
    if (g.positions[v * 3 + 1]! > 5) {
      reachedCanopy = true;
      break;
    }
  }
  assert.ok(reachedCanopy, 'expected branches to reach the lifted canopy (y > 5)');
});

test('branch/space-colonization: Murray-law radii scale root to rootRadius', () => {
  const { attractors, attractorCount } = sphereAttractors(9, 4, 120);
  const g = generateSpaceColonizationBranchGraph({
    ...SC_DEFAULT_OPTS,
    attractors,
    attractorCount,
  });
  // The first vertex of the trunk-root branch is the root node; its radius
  // should match the input rootRadius.
  assert.ok(Math.abs(g.radii[0]! - SC_DEFAULT_OPTS.rootRadius) < 1e-4,
    `root radius ${g.radii[0]} != ${SC_DEFAULT_OPTS.rootRadius}`);
});

test('branch/space-colonization: child branch attaches at a parent polyline vertex (dominant-child)', () => {
  const { attractors, attractorCount } = sphereAttractors(9, 4, 120);
  const g = generateSpaceColonizationBranchGraph({
    ...SC_DEFAULT_OPTS,
    attractors,
    attractorCount,
  });
  // With dominant-child restructuring, non-root branches attach mid-parent
  // at an integer-vertex parentT, NOT at the parent's tip. Each non-root
  // branch's first vertex equals the parent's vertex at parentT *
  // (vertexLength - 1).
  for (let b = 1; b < g.branchCount; b++) {
    const p = g.parentIndex[b]!;
    if (p < 0) continue;
    const pVs = g.vertexStart[p]!;
    const pVc = g.vertexLength[p]!;
    const tIdx = Math.round(g.parentT[b]! * (pVc - 1));
    const parentVertex = pVs + tIdx;
    const childFirst = g.vertexStart[b]!;
    assert.ok(Math.abs(g.positions[childFirst * 3]! - g.positions[parentVertex * 3]!) < 1e-5);
    assert.ok(Math.abs(g.positions[childFirst * 3 + 1]! - g.positions[parentVertex * 3 + 1]!) < 1e-5);
    assert.ok(Math.abs(g.positions[childFirst * 3 + 2]! - g.positions[parentVertex * 3 + 2]!) < 1e-5);
    return;
  }
  throw new Error('space-colonization test produced no branching');
});

test('branch/space-colonization with no attractors returns near-trivial graph', () => {
  const g = generateSpaceColonizationBranchGraph({
    ...SC_DEFAULT_OPTS,
    attractors: new Float32Array(0),
    attractorCount: 0,
  });
  // With no attractors, no growth happens past iteration 0's seed step
  // (which doesn't fire when there's nothing to grow toward either —
  // iter 0 only seeds when nodes.length === 1 AND influence is empty,
  // which only matters when there are SOMEDAY attractors).
  // Should still produce a valid (possibly tiny) BranchGraph.
  assert.ok(g.branchCount >= 1);
  assert.ok(g.vertexCount >= 1);
});

test('branch/tropism preserves trunk base (depth 0 stays anchored)', () => {
  const g = generateRecursiveBranchGraph(DEFAULT_OPTS);
  const bent = applyTropismToBranchGraph(g, {
    gravity: 0.5,
    phototropism: [0, 0, 0],
    wobble: 0,
    wobbleSeed: 0,
  });
  // Trunk root vertex (first vertex of branch 0) should be unchanged.
  assert.equal(bent.positions[0], g.positions[0]);
  assert.equal(bent.positions[1], g.positions[1]);
  assert.equal(bent.positions[2], g.positions[2]);
});

test('branch/palm produces a single-branch BranchGraph rooted at origin', () => {
  const g = generatePalmBranchGraph({
    height: 8,
    trunkRadiusBase: 0.16,
    trunkRadiusTip: 0.1,
    trunkSegments: 14,
    leanAngleDeg: 6,
    leanCurvatureDeg: 0.6,
    leanAzimuthDeg: 0,
    seed: 0.41,
  });
  assert.equal(g.branchCount, 1, 'palm has exactly one branch');
  assert.equal(g.parentIndex[0], -1, 'palm trunk is a root branch');
  assert.equal(g.branchDepth[0], 0, 'palm trunk is depth 0');
  assert.equal(g.positions[0], 0);
  assert.equal(g.positions[1], 0);
  assert.equal(g.positions[2], 0);
});

test('branch/whorled-pine produces trunk + whorl branches with correct depths', () => {
  const g = generateWhorledPineBranchGraph({
    trunkHeight: 12,
    trunkRadiusBase: 0.32,
    trunkRadiusTip: 0.04,
    trunkSegments: 16,
    trunkLeanDeg: 0,
    whorlCount: 5,
    whorlStart: 0.25,
    whorlEnd: 0.95,
    branchesPerWhorl: 6,
    whorlPhaseOffsetDeg: 35,
    branchLengthAtBase: 3,
    branchLengthAtTop: 0.5,
    branchAngleDeg: 80,
    branchSegments: 6,
    branchRadiusFraction: 0.25,
    branchTipRadiusFraction: 0.15,
    subBranchCount: 0,
    subBranchLengthRatio: 0.4,
    subBranchAngleDeg: 55,
    seed: 0.58,
  });
  assert.equal(g.branchCount, 1 + 5 * 6, 'trunk + 5×6 whorl branches');
  assert.equal(g.branchDepth[0], 0);
  for (let b = 1; b < g.branchCount; b++) {
    assert.equal(g.parentIndex[b], 0, `whorl branch ${b} attaches to trunk`);
    assert.equal(g.branchDepth[b], 1);
  }
});

test('branch/whorled-pine with subBranchCount emits depth-2 branches', () => {
  const g = generateWhorledPineBranchGraph({
    trunkHeight: 12,
    trunkRadiusBase: 0.32,
    trunkRadiusTip: 0.04,
    trunkSegments: 12,
    trunkLeanDeg: 0,
    whorlCount: 3,
    whorlStart: 0.3,
    whorlEnd: 0.9,
    branchesPerWhorl: 4,
    whorlPhaseOffsetDeg: 0,
    branchLengthAtBase: 2,
    branchLengthAtTop: 0.5,
    branchAngleDeg: 80,
    branchSegments: 6,
    branchRadiusFraction: 0.25,
    branchTipRadiusFraction: 0.15,
    subBranchCount: 2,
    subBranchLengthRatio: 0.4,
    subBranchAngleDeg: 55,
    seed: 0.58,
  });
  // trunk + 3*4 whorl + 3*4*2 sub-branches
  assert.equal(g.branchCount, 1 + 12 + 24);
  let depth2 = 0;
  for (let b = 0; b < g.branchCount; b++) {
    if (g.branchDepth[b] === 2) depth2++;
  }
  assert.equal(depth2, 24);
});

test('branch/merge concatenates branches and rebases indices', () => {
  const palm = generatePalmBranchGraph({
    height: 5,
    trunkRadiusBase: 0.1,
    trunkRadiusTip: 0.08,
    trunkSegments: 6,
    leanAngleDeg: 0,
    leanCurvatureDeg: 0,
    leanAzimuthDeg: 0,
    seed: 0,
  });
  const recursive = generateRecursiveBranchGraph(DEFAULT_OPTS);
  const merged = mergeBranchGraphs(palm, recursive);
  assert.equal(merged.branchCount, palm.branchCount + recursive.branchCount);
  assert.equal(merged.vertexCount, palm.vertexCount + recursive.vertexCount);

  // The first palm.branchCount entries should match palm.
  assert.equal(merged.parentIndex[0], -1);

  // Recursive's root (at index palm.branchCount in merged) should remain -1.
  assert.equal(merged.parentIndex[palm.branchCount], -1);
  // And a non-root entry from recursive should have its parent shifted.
  if (recursive.branchCount > 1) {
    const origParent = recursive.parentIndex[1]!;
    const expectedShifted = origParent === -1 ? -1 : origParent + palm.branchCount;
    assert.equal(merged.parentIndex[palm.branchCount + 1], expectedShifted);
  }

  // Vertex ranges contiguous.
  let lastEnd = 0;
  for (let b = 0; b < merged.branchCount; b++) {
    assert.equal(merged.vertexStart[b], lastEnd);
    lastEnd += merged.vertexLength[b]!;
  }
  assert.equal(lastEnd, merged.vertexCount);
});

test('branch/merge with empty graph returns the other unchanged', () => {
  const palm = generatePalmBranchGraph({
    height: 5,
    trunkRadiusBase: 0.1,
    trunkRadiusTip: 0.08,
    trunkSegments: 6,
    leanAngleDeg: 0,
    leanCurvatureDeg: 0,
    leanAzimuthDeg: 0,
    seed: 0,
  });
  const empty = {
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
  const a = mergeBranchGraphs(empty, palm);
  assert.equal(a.branchCount, palm.branchCount);
  const b = mergeBranchGraphs(palm, empty);
  assert.equal(b.branchCount, palm.branchCount);
});

test('branch/tropism: depth-1+ branches sag downward with positive gravity', () => {
  const g = generateRecursiveBranchGraph(DEFAULT_OPTS);
  const bent = applyTropismToBranchGraph(g, {
    gravity: 0.3,
    phototropism: [0, 0, 0],
    wobble: 0,
    wobbleSeed: 0,
  });
  // Find a depth-1+ branch tip and confirm its Y dropped.
  let sawSag = false;
  for (let b = 0; b < g.branchCount; b++) {
    if (g.branchDepth[b]! === 0) continue;
    const tipIdx = g.vertexStart[b]! + g.vertexLength[b]! - 1;
    const origY = g.positions[tipIdx * 3 + 1]!;
    const bentY = bent.positions[tipIdx * 3 + 1]!;
    if (bentY < origY - 1e-4) {
      sawSag = true;
      break;
    }
  }
  assert.ok(sawSag, 'expected at least one non-trunk tip to sag under gravity');
});
