import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTropismToBranchGraph,
  generateRecursiveBranchGraph,
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
    seed: 0.5,
  });
  assert.equal(pc.count, g.branchCount);
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
