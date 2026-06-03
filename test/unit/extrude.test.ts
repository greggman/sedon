// core/extrude tests on hand-verifiable fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CpuMeshRef } from '../../src/core/resources.js';
import { extrudeMesh } from '../../src/render/extrude.js';

function meshOf(
  positions: number[],
  indices: number[],
  uvs?: number[],
): CpuMeshRef {
  const vCount = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(vCount * 3),
    uvs: new Float32Array(uvs ?? new Array(vCount * 2).fill(0)),
    indices: new Uint32Array(indices),
  };
}

function sharedVertexCube(): CpuMeshRef {
  const positions = [
    -1, -1, -1,   1, -1, -1,   1,  1, -1,  -1,  1, -1,
    -1, -1,  1,   1, -1,  1,   1,  1,  1,  -1,  1,  1,
  ];
  const indices = [
    4, 5, 6,   4, 6, 7,    // +Z (tris 0, 1)
    1, 0, 3,   1, 3, 2,    // -Z (tris 2, 3)
    1, 2, 6,   1, 6, 5,    // +X (tris 4, 5)
    0, 4, 7,   0, 7, 3,    // -X (tris 6, 7)
    7, 6, 2,   7, 2, 3,    // +Y (tris 8, 9)
    0, 1, 5,   0, 5, 4,    // -Y (tris 10, 11)
  ];
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(8 * 3),
    uvs: new Float32Array(8 * 2),
    indices: new Uint32Array(indices),
  };
}

test('extrude: no selection → mesh passes through unchanged', () => {
  const m = meshOf([0, 0, 0,  1, 0, 0,  0, 1, 0], [0, 1, 2]);
  const out = extrudeMesh(m, { offset: 0.5 });
  assert.equal(out, m); // same reference
});

test('extrude: empty face-mask → mesh passes through unchanged', () => {
  const m = meshOf([0, 0, 0,  1, 0, 0,  0, 1, 0], [0, 1, 2]);
  m.selection = { faces: new Uint8Array(1) };
  const out = extrudeMesh(m, { offset: 0.5 });
  assert.equal(out, m);
});

test('extrude: single tri pushed along its normal — 7 output tris, cap selected', () => {
  // One tri in xy-plane, area 0.5, normal +Z. Extrude by 0.4.
  const m = meshOf(
    [0, 0, 0,  1, 0, 0,  0, 1, 0],
    [0, 1, 2],
  );
  m.selection = { faces: new Uint8Array([1]) };
  const out = extrudeMesh(m, { offset: 0.4 });
  // 1 offset cap + 3 walls × 2 tris each = 7 tris (the original
  // selected tri is REPLACED by the offset, not kept).
  assert.equal(out.indices.length / 3, 7);
  // Face-selection mask: exactly 1 cap face flagged.
  let capCount = 0;
  for (const v of out.selection!.faces!) if (v === 1) capCount++;
  assert.equal(capCount, 1, 'one cap tri marked in selection.faces');
  // Edge-selection mask: 3 rim edges × 2 half-edges (wall side + cap
  // side, both deduped through the welded half-edge mesh which
  // canonicalises position-coincident vertices). Each undirected
  // rim edge gets ONE half-edge on the cap and ONE on the wall →
  // 2 half-edges per rim × 3 rim edges = 6 marks.
  let edgeCount = 0;
  for (const v of out.selection!.edges!) if (v === 1) edgeCount++;
  assert.equal(edgeCount, 6, '3 rim edges × 2 half-edges (cap + wall)');
});

test('extrude: cube face cluster (2 tris) → cluster walked as one logical face', () => {
  // Select +Z face (tris 0 and 1 of the shared-vert cube — they
  // share the diagonal {4, 6}). Extrude by 0.5 along +Z.
  const m = sharedVertexCube();
  const mask = new Uint8Array(12);
  mask[0] = 1; mask[1] = 1;
  m.selection = { faces: mask };
  const out = extrudeMesh(m, { offset: 0.5 });
  // Output topology:
  //   10 unchanged tris (5 other cube faces × 2)
  // +  2 offset cap tris (the +Z duplicate)
  // +  4 walls × 2 tris (one per cube edge of +Z face)
  // = 20 tris total.
  assert.equal(out.indices.length / 3, 20);
  // selection.faces flags exactly 2 cap tris.
  let capCount = 0;
  for (const v of out.selection!.faces!) if (v === 1) capCount++;
  assert.equal(capCount, 2);
  // Rim: 4 cube edges around +Z face. The cluster's interior
  // diagonal between the two source tris is NOT a rim — it gets no
  // wall and is shared between the 2 cap tris (still no rim).
  // Each rim has 2 half-edges (cap side + wall side) → 8 marks.
  let edgeCount = 0;
  for (const v of out.selection!.edges!) if (v === 1) edgeCount++;
  assert.equal(edgeCount, 8, '4 rim edges × 2 half-edges');
});

test('extrude: negative offset recesses into the mesh, same topology', () => {
  const m = sharedVertexCube();
  const mask = new Uint8Array(12);
  mask[0] = 1; mask[1] = 1; // +Z face
  m.selection = { faces: mask };
  const out = extrudeMesh(m, { offset: -0.3 });
  // Same triangle count whether we go in or out.
  assert.equal(out.indices.length / 3, 20);
  // The cap verts should sit BELOW z = 1 (recessed). Find any
  // vertex with z < 1.0 — there must be some, and they must sit at
  // z = 1 - 0.3 = 0.7 (the recessed plane).
  let recessed = 0;
  for (let i = 0; i < out.positions.length / 3; i++) {
    if (Math.abs(out.positions[i * 3 + 2]! - 0.7) < 1e-4) recessed++;
  }
  assert.ok(recessed >= 4, 'at least the 4 corner cap verts at z=0.7');
});

test('extrude: cap normal matches cluster normal — flat shading on the offset face', () => {
  const m = sharedVertexCube();
  const mask = new Uint8Array(12);
  mask[0] = 1; mask[1] = 1; // +Z face
  m.selection = { faces: mask };
  const out = extrudeMesh(m, { offset: 0.5 });
  // Iterate the selected (cap) faces and confirm every vertex on
  // them has normal +Z.
  for (let t = 0; t < out.indices.length / 3; t++) {
    if (out.selection!.faces![t] !== 1) continue;
    for (let k = 0; k < 3; k++) {
      const v = out.indices[t * 3 + k]!;
      assert.ok(Math.abs(out.normals[v * 3]!     - 0) < 1e-4, `cap vert n.x ≈ 0`);
      assert.ok(Math.abs(out.normals[v * 3 + 1]! - 0) < 1e-4, `cap vert n.y ≈ 0`);
      assert.ok(Math.abs(out.normals[v * 3 + 2]! - 1) < 1e-4, `cap vert n.z ≈ +1`);
    }
  }
});

test('extrude: two disjoint selected tris form two clusters and extrude independently', () => {
  // Cube +Z face is tris [0,1] (shared); +Y is tris [8,9]. Select
  // ONE tri from each: 0 (+Z) and 8 (+Y). They don't share an edge
  // → two separate clusters, two separate extrudes.
  const m = sharedVertexCube();
  const mask = new Uint8Array(12);
  mask[0] = 1; mask[8] = 1;
  m.selection = { faces: mask };
  const out = extrudeMesh(m, { offset: 0.3 });
  // Topology:
  //   10 unselected tris (everything except the 2 selected)
  // +  2 offset cap tris (1 per cluster)
  // +  3 walls × 2 tris per cluster × 2 clusters = 12 wall tris
  // = 24 tris.
  assert.equal(out.indices.length / 3, 24);
  // 2 cap faces marked.
  let capCount = 0;
  for (const v of out.selection!.faces!) if (v === 1) capCount++;
  assert.equal(capCount, 2);
});

test('extrude: drops the input face mask AND any other selection slots', () => {
  // Carry a vertex mask in — extrude should drop it in the output.
  const m = meshOf([0, 0, 0,  1, 0, 0,  0, 1, 0], [0, 1, 2]);
  m.selection = {
    faces: new Uint8Array([1]),
    vertices: new Uint8Array([1, 1, 0]),
  };
  const out = extrudeMesh(m, { offset: 0.5 });
  assert.equal(out.selection!.vertices, undefined, 'vertices mask dropped');
  // Output FACE mask is the cap mask (different shape than the
  // input's "extrude this triangle" mask); presence is fine, but
  // its meaning is "what the next op should act on", not a
  // pass-through of the input.
  assert.ok(out.selection!.faces);
});
