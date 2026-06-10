// geom/inset tests on hand-verifiable fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CpuMeshRef } from '../../src/core/resources.js';
import { insetMesh } from '../../src/render/inset.js';

function meshOf(positions: number[], indices: number[]): CpuMeshRef {
  const vCount = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(vCount * 3),
    uvs: new Float32Array(vCount * 2),
    indices: new Uint32Array(indices),
  };
}

function sharedVertexCube(): CpuMeshRef {
  return {
    positions: new Float32Array([
      -1, -1, -1,   1, -1, -1,   1,  1, -1,  -1,  1, -1,
      -1, -1,  1,   1, -1,  1,   1,  1,  1,  -1,  1,  1,
    ]),
    normals: new Float32Array(8 * 3),
    uvs: new Float32Array(8 * 2),
    indices: new Uint32Array([
      4, 5, 6,   4, 6, 7,    // +Z
      1, 0, 3,   1, 3, 2,    // -Z
      1, 2, 6,   1, 6, 5,    // +X
      0, 4, 7,   0, 7, 3,    // -X
      7, 6, 2,   7, 2, 3,    // +Y
      0, 1, 5,   0, 5, 4,    // -Y
    ]),
  };
}

test('inset: no selection → passes through unchanged', () => {
  const m = meshOf([0, 0, 0,  1, 0, 0,  0, 1, 0], [0, 1, 2]);
  const out = insetMesh(m, { width: 0.1 });
  assert.equal(out, m);
});

test('inset: empty mask → passes through unchanged', () => {
  const m = meshOf([0, 0, 0,  1, 0, 0,  0, 1, 0], [0, 1, 2]);
  m.selection = { faces: new Uint8Array(1) };
  const out = insetMesh(m, { width: 0.1 });
  assert.equal(out, m);
});

test('inset: cube +Y face cluster → 4 frame quads + 2 inner tris, inner face selected', () => {
  const m = sharedVertexCube();
  const mask = new Uint8Array(12);
  mask[8] = 1; mask[9] = 1; // +Y face (tris 8, 9)
  m.selection = { faces: mask };
  const out = insetMesh(m, { width: 0.1 });
  // Output topology:
  //   10 unchanged tris (5 other cube faces × 2)
  // +  2 inner-face tris (same triangulation as the cluster, verts inset)
  // +  4 frame quads × 2 tris = 8
  // = 20 tris.
  assert.equal(out.indices.length / 3, 20);
  // selection.faces flags exactly the 2 inner tris.
  let innerCount = 0;
  for (const v of out.selection!.faces!) if (v === 1) innerCount++;
  assert.equal(innerCount, 2);
  // selection.edges flags rim half-edges. Welded output mesh has 2
  // half-edges per rim edge × 4 rim edges = 8.
  let rimCount = 0;
  for (const v of out.selection!.edges!) if (v === 1) rimCount++;
  assert.equal(rimCount, 8);
});

test('inset: +Y face inner corners sit at the inset positions on the cluster plane', () => {
  const m = sharedVertexCube();
  const mask = new Uint8Array(12);
  mask[8] = 1; mask[9] = 1;
  m.selection = { faces: mask };
  const out = insetMesh(m, { width: 0.1 });
  // The +Y face's 4 cube corners are at the (±1, 1, ±1) positions.
  // Inset by 0.1 along each 90° corner's bisector → new corners at
  // (±0.9, 1, ±0.9). Confirm at least 4 verts in the output sit at
  // y=1 with x and z in {±0.9}.
  const expected: Array<[number, number]> = [
    [0.9, 0.9], [-0.9, 0.9], [0.9, -0.9], [-0.9, -0.9],
  ];
  const matched = new Set<number>();
  for (let i = 0; i < out.positions.length / 3; i++) {
    const x = out.positions[i * 3]!;
    const y = out.positions[i * 3 + 1]!;
    const z = out.positions[i * 3 + 2]!;
    if (Math.abs(y - 1) > 1e-4) continue;
    for (let e = 0; e < expected.length; e++) {
      if (Math.abs(x - expected[e]![0]) < 1e-4 && Math.abs(z - expected[e]![1]) < 1e-4) {
        matched.add(e);
      }
    }
  }
  assert.equal(matched.size, 4, 'all 4 inset corner positions present');
});

test('inset: cap normal matches cluster normal (flat shading on the inner face)', () => {
  const m = sharedVertexCube();
  const mask = new Uint8Array(12);
  mask[8] = 1; mask[9] = 1; // +Y
  m.selection = { faces: mask };
  const out = insetMesh(m, { width: 0.1 });
  for (let t = 0; t < out.indices.length / 3; t++) {
    if (out.selection!.faces![t] !== 1) continue;
    for (let k = 0; k < 3; k++) {
      const v = out.indices[t * 3 + k]!;
      assert.ok(Math.abs(out.normals[v * 3]!     - 0) < 1e-4);
      assert.ok(Math.abs(out.normals[v * 3 + 1]! - 1) < 1e-4);
      assert.ok(Math.abs(out.normals[v * 3 + 2]! - 0) < 1e-4);
    }
  }
});

test('inset: feeds straight into extrude (paneled-door pipeline first half)', async () => {
  const { extrudeMesh } = await import('../../src/render/extrude.js');
  const m = sharedVertexCube();
  const mask = new Uint8Array(12);
  mask[8] = 1; mask[9] = 1; // +Y
  m.selection = { faces: mask };
  const insetOut = insetMesh(m, { width: 0.1 });
  // After inset: selection.faces marks the 2 inner cap tris.
  // Extrude consumes it and pushes the inner cluster downward by
  // -0.05 — the recessed-panel result.
  const ext = extrudeMesh(insetOut, { offset: -0.05 });
  // Extrude topology on a 2-tri cluster (input had 20 tris):
  //   18 pass-through (everything except the 2 inset cap tris)
  // +  2 extrude cap (the duplicated and recessed inset face)
  // +  4 walls × 2 = 8
  // = 28 tris.
  assert.equal(ext.indices.length / 3, 28);
  // Output cap is now the recessed face: y = 1 - 0.05 = 0.95.
  let recessed = 0;
  for (let t = 0; t < ext.indices.length / 3; t++) {
    if (ext.selection!.faces![t] !== 1) continue;
    for (let k = 0; k < 3; k++) {
      const v = ext.indices[t * 3 + k]!;
      if (Math.abs(ext.positions[v * 3 + 1]! - 0.95) < 1e-4) recessed++;
    }
  }
  // 2 tris × 3 verts each = 6 vert references at y = 0.95.
  assert.equal(recessed, 6);
});

test('inset: drops the input face mask AND other selection slots', () => {
  const m = sharedVertexCube();
  const mask = new Uint8Array(12);
  mask[8] = 1; mask[9] = 1;
  m.selection = {
    faces: mask,
    vertices: new Uint8Array(8).fill(1),
  };
  const out = insetMesh(m, { width: 0.1 });
  assert.equal(out.selection!.vertices, undefined);
  assert.ok(out.selection!.faces);
});
