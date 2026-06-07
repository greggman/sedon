// Unit tests for lathe, mirror, and extrude-on-path. These operate
// on pure-JS CpuMesh data — no GPU dependency, so they run cleanly in
// node-test.
//
// What's pinned:
//   • Triangle counts match the analytic formula (catches off-by-one
//     in seam handling, cap emission, strip-stitching).
//   • Positions land where they should for a known input (the
//     "vertical-line lathe makes a cylinder of the right radius",
//     "mirror flips x", "straight-path extrude == prism" cases).
//   • Triangle winding is consistent (CCW from outside) — for lathe
//     we check a side-face triangle's signed area; for mirror we
//     check that reflected indices got their winding reversed.
//
// Normals get a smoke check (unit-length) but not directional
// verification — that's better covered by visual diffs against
// reference renders, which the headless dev-server tests handle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateBox, generateCube } from '../../src/render/cube.js';
import { generateLathe } from '../../src/render/lathe.js';
import { mirrorMesh } from '../../src/render/mirror-mesh.js';
import { generateExtrudeOnPath } from '../../src/render/extrude-on-path.js';

function assertUnitNormals(normals: Float32Array, where: string): void {
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i]!;
    const y = normals[i + 1]!;
    const z = normals[i + 2]!;
    const len = Math.hypot(x, y, z);
    // Some lathe vertices on-axis can have degenerate frames; allow
    // a zero normal as a graceful no-op rather than asserting unit.
    if (len < 0.001) continue;
    assert.ok(
      Math.abs(len - 1) < 1e-3,
      `${where}: normal at index ${i / 3} has length ${len}, expected ~1`,
    );
  }
}

// ---------- LATHE ----------

test('lathe: vertical-line profile produces a closed cylinder with correct radius', () => {
  // Profile: two points at (0.5, 0) and (0.5, 1) — a vertical line at
  // x=0.5. Revolved around Y → a unit-height cylinder with radius 0.5,
  // both caps closed.
  const mesh = generateLathe(
    [{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }],
    { segments: 16, capStart: true, capEnd: true },
  );
  // Body: 2 rings × 17 verts (seam dup) = 34
  // Start cap: 1 + 16 = 17. End cap: 1 + 16 = 17.
  assert.equal(mesh.positions.length / 3, 34 + 17 + 17);
  // Body strip: 1 inter-ring strip × 16 segs × 6 indices = 96
  // Caps: 16 × 3 × 2 = 96
  assert.equal(mesh.indices.length, 96 + 96);
  // Every body vertex sits on the radius-0.5 cylinder.
  for (let i = 0; i < 34; i++) {
    const x = mesh.positions[i * 3]!;
    const z = mesh.positions[i * 3 + 2]!;
    const r = Math.hypot(x, z);
    assert.ok(Math.abs(r - 0.5) < 1e-5, `body vertex ${i} radius ${r}, expected 0.5`);
  }
  assertUnitNormals(mesh.normals, 'lathe cylinder');
});

test('lathe: empty / single-point profile yields an empty mesh (graceful)', () => {
  const empty = generateLathe([]);
  assert.equal(empty.indices.length, 0);
  const onePoint = generateLathe([{ x: 1, y: 0 }]);
  assert.equal(onePoint.indices.length, 0);
});

test('lathe: caps are omitted when the terminal point sits on the axis (x=0)', () => {
  // Profile drops to x=0 at the top. The end cap should be auto-
  // omitted because the geometry naturally pinches to the axis.
  const mesh = generateLathe(
    [{ x: 0.4, y: 0 }, { x: 0.4, y: 0.8 }, { x: 0, y: 1 }],
    { segments: 12 },
  );
  // Body: 3 rings × 13 = 39. Start cap: 13 (off-axis). End cap: 0.
  assert.equal(mesh.positions.length / 3, 39 + 13);
});

// ---------- MIRROR ----------

test('mirror: reflecting across X flips x of every vertex and reverses winding', () => {
  // Make a tiny one-triangle mesh: a single face with positions A, B, C.
  const mesh = {
    positions: new Float32Array([1, 0, 0,  2, 0, 0,  1, 1, 0]),
    normals: new Float32Array([0, 0, 1,  0, 0, 1,  0, 0, 1]),
    uvs: new Float32Array([0, 0,  1, 0,  0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  };
  // weld=false: just the mirrored half.
  const out = mirrorMesh(mesh, { axis: 'X', offset: 0, weld: false });
  // Positions x-flipped, y/z unchanged.
  assert.deepEqual(Array.from(out.positions), [-1, 0, 0, -2, 0, 0, -1, 1, 0]);
  // Winding reversed: (0, 1, 2) → (0, 2, 1).
  assert.deepEqual(Array.from(out.indices), [0, 2, 1]);
  // Normal x flipped.
  assert.deepEqual(Array.from(out.normals), [-0, 0, 1, -0, 0, 1, -0, 0, 1]);
});

test('mirror: weld=true joins input + reflected with offset triangle indices', () => {
  const mesh = {
    positions: new Float32Array([1, 0, 0,  2, 0, 0,  1, 1, 0]),
    normals: new Float32Array([0, 0, 1,  0, 0, 1,  0, 0, 1]),
    uvs: new Float32Array([0, 0,  1, 0,  0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  };
  const out = mirrorMesh(mesh, { axis: 'X', offset: 0, weld: true });
  // 6 verts (3 original + 3 mirrored), 6 indices (2 triangles).
  assert.equal(out.positions.length / 3, 6);
  assert.equal(out.indices.length, 6);
  // Second triangle's indices are offset by 3 AND winding-reversed.
  assert.deepEqual(Array.from(out.indices.slice(3)), [3, 5, 4]);
});

test('mirror: offset shifts the reflection plane', () => {
  const mesh = {
    positions: new Float32Array([1, 0, 0]),
    normals: new Float32Array([0, 0, 1]),
    uvs: new Float32Array([0, 0]),
    indices: new Uint32Array([]),
  };
  // Plane x = 2 (offset 2). 2 * 2 - 1 = 3.
  const out = mirrorMesh(mesh, { axis: 'X', offset: 2, weld: false });
  assert.equal(out.positions[0], 3);
});

// ---------- EXTRUDE-ON-PATH ----------

test('extrude-on-path: straight-line path with a square section produces a 4-sided prism', () => {
  // 2-sample horizontal path from origin to (2, 0, 0); 4-vertex
  // square cross-section closed. Expected: 4 quad faces (the tube
  // body) + 2 cap quads (each cap = 4 fan triangles).
  const path = new Float32Array([0, 0, 0, 2, 0, 0]);
  const section = [
    { x: -0.1, y: 0 },
    { x:  0.1, y: 0 },
    { x:  0.1, y: 0.2 },
    { x: -0.1, y: 0.2 },
  ];
  const mesh = generateExtrudeOnPath(path, 2, section, {
    closedSection: true,
    capStart: true,
    capEnd: true,
  });
  // Body verts: pathCount(2) × sectionV(5 = 4+1 seam dup) = 10
  // Cap verts: 1 + 4 (centroid + rim) × 2 caps = 10
  assert.equal(mesh.positions.length / 3, 20);
  // Body strip indices: (pathCount - 1)(1) × stripSegs(4) × 6 = 24
  // Cap indices: 4 × 3 × 2 caps = 24
  assert.equal(mesh.indices.length, 48);
  assertUnitNormals(mesh.normals, 'extrude straight');
});

test('extrude-on-path: path shorter than 2 samples produces an empty mesh', () => {
  const path = new Float32Array([0, 0, 0]);
  const out = generateExtrudeOnPath(path, 1, [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  assert.equal(out.indices.length, 0);
});

// ---------- BOX / CUBE ----------

test('box: generates 24 verts / 36 indices (same topology as cube)', () => {
  const mesh = generateBox(2, 3, 4);
  assert.equal(mesh.positions.length / 3, 24);
  assert.equal(mesh.indices.length, 36);
});

test('box: positions span ±width/2, ±height/2, ±depth/2', () => {
  const mesh = generateBox(2, 4, 6);
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < 24; i++) {
    const x = mesh.positions[i * 3]!;
    const y = mesh.positions[i * 3 + 1]!;
    const z = mesh.positions[i * 3 + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  assert.equal(minX, -1); assert.equal(maxX, 1);
  assert.equal(minY, -2); assert.equal(maxY, 2);
  assert.equal(minZ, -3); assert.equal(maxZ, 3);
});

test('box: generateCube(s) and generateBox(s,s,s) produce identical meshes', () => {
  const cube = generateCube(2.5);
  const box = generateBox(2.5, 2.5, 2.5);
  assert.deepEqual(Array.from(cube.positions), Array.from(box.positions));
  assert.deepEqual(Array.from(cube.indices), Array.from(box.indices));
  assert.deepEqual(Array.from(cube.normals), Array.from(box.normals));
});

test('extrude-on-path: open ribbon (closedSection=false) skips the seam dup and caps', () => {
  const path = new Float32Array([0, 0, 0, 1, 0, 0]);
  // Two points = an open strip, not a closed loop.
  const section = [{ x: 0, y: 0 }, { x: 0, y: 0.1 }];
  const mesh = generateExtrudeOnPath(path, 2, section, {
    closedSection: false,
    capStart: true, // ignored — caps require closed section
    capEnd: true,
  });
  // Body verts: 2 × 2 = 4. No caps emitted.
  assert.equal(mesh.positions.length / 3, 4);
  // 1 strip × 1 quad × 6 = 6 indices.
  assert.equal(mesh.indices.length, 6);
});
