// Half-edge connectivity tests. Each test pins one invariant of the
// builder so future refactors can't silently break a case. The
// fixtures are intentionally tiny so the expected adjacency is easy
// to verify by hand — anything bigger should be a fuzz test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CpuMeshRef } from '../../src/core/resources.js';
import {
  buildHalfEdgeMesh,
  destination,
  faceOf,
  nextInFace,
  outgoingFan,
  prevInFace,
} from '../../src/render/half-edge-mesh.js';

// Helper: minimal CpuMeshRef with the bare buffers the half-edge
// builder needs (it ignores normals/UVs, but the type forces all
// four fields). Positions are 0,0,0 for every vertex — connectivity
// doesn't read them.
function meshFromIndices(indices: number[], vertexCount: number): CpuMeshRef {
  return {
    positions: new Float32Array(vertexCount * 3),
    normals: new Float32Array(vertexCount * 3),
    uvs: new Float32Array(vertexCount * 2),
    indices: new Uint32Array(indices),
  };
}

test('helpers: faceOf / nextInFace / prevInFace are the canonical triangle-corner cycles', () => {
  // Face 0: 0 → 1 → 2 → 0. Face 1: 3 → 4 → 5 → 3.
  assert.equal(faceOf(0), 0);
  assert.equal(faceOf(2), 0);
  assert.equal(faceOf(3), 1);
  assert.equal(faceOf(5), 1);
  assert.equal(nextInFace(0), 1);
  assert.equal(nextInFace(1), 2);
  assert.equal(nextInFace(2), 0);
  assert.equal(nextInFace(3), 4);
  assert.equal(nextInFace(5), 3);
  assert.equal(prevInFace(0), 2);
  assert.equal(prevInFace(1), 0);
  assert.equal(prevInFace(2), 1);
  assert.equal(prevInFace(3), 5);
  assert.equal(prevInFace(5), 4);
});

test('buildHalfEdgeMesh: single triangle — all three edges are boundaries, no twins', () => {
  const m = buildHalfEdgeMesh(meshFromIndices([0, 1, 2], 3));
  assert.equal(m.vertexCount, 3);
  assert.equal(m.faceCount, 1);
  assert.equal(m.halfEdgeCount, 3);
  assert.equal(m.boundaryEdgeCount, 3);
  assert.equal(m.nonManifoldEdgeCount, 0);
  assert.equal(m.degenerateFaceCount, 0);
  for (let he = 0; he < 3; he++) {
    assert.equal(m.twin[he], -1, `boundary half-edge ${he} should have twin = -1`);
  }
  // origin matches the source indices
  assert.deepEqual(Array.from(m.origin), [0, 1, 2]);
  // every vertex has SOME outgoing half-edge
  for (let v = 0; v < 3; v++) assert.ok(m.vertexFirstEdge[v]! >= 0, `v${v} should have a seed`);
});

test('buildHalfEdgeMesh: two triangles sharing one edge — 1 manifold pair, 4 boundaries', () => {
  // Quad split into [0,1,2] and [0,2,3]. Shared edge is {0,2}:
  // tri 0 corner 2 (he 2) runs 2→0; tri 1 corner 0 (he 3) runs 0→2.
  const m = buildHalfEdgeMesh(meshFromIndices([0, 1, 2, 0, 2, 3], 4));
  assert.equal(m.faceCount, 2);
  assert.equal(m.halfEdgeCount, 6);
  assert.equal(m.boundaryEdgeCount, 4);
  assert.equal(m.nonManifoldEdgeCount, 0);
  // The interior pair: twin[2] = 3 and twin[3] = 2.
  assert.equal(m.twin[2], 3);
  assert.equal(m.twin[3], 2);
  // All other half-edges are boundaries.
  assert.equal(m.twin[0], -1);
  assert.equal(m.twin[1], -1);
  assert.equal(m.twin[4], -1);
  assert.equal(m.twin[5], -1);
  // destination() agrees with the next-in-face origin.
  assert.equal(destination(m, 0), 1);
  assert.equal(destination(m, 1), 2);
  assert.equal(destination(m, 2), 0);
});

test('buildHalfEdgeMesh: closed manifold (tetrahedron) — every edge has a twin, no boundaries', () => {
  // Tet faces, consistently wound (each edge appears in opposite
  // directions in its two faces — hand-verified).
  // tri0[0,1,2]  tri1[0,3,1]  tri2[1,3,2]  tri3[2,3,0]
  const m = buildHalfEdgeMesh(meshFromIndices(
    [0, 1, 2,  0, 3, 1,  1, 3, 2,  2, 3, 0],
    4,
  ));
  assert.equal(m.faceCount, 4);
  assert.equal(m.halfEdgeCount, 12);
  assert.equal(m.boundaryEdgeCount, 0);
  assert.equal(m.nonManifoldEdgeCount, 0);
  // Every half-edge has a valid twin.
  for (let he = 0; he < 12; he++) {
    const t = m.twin[he]!;
    assert.ok(t >= 0 && t < 12, `he ${he} missing twin`);
    assert.equal(m.twin[t], he, `twin reciprocity broken at ${he}↔${t}`);
    // Opposite directions: origin(he) === destination(twin(he))
    assert.equal(m.origin[he], destination(m, t));
  }
});

test('buildHalfEdgeMesh: three triangles sharing an edge — non-manifold, no twins assigned', () => {
  // Edge {0,1} appears in three faces; the directions alternate so
  // it's not just an inconsistent-winding pair but a genuine 3-way.
  // tri0 [0,1,2]: 0→1
  // tri1 [1,0,3]: 1→0
  // tri2 [0,1,4]: 0→1
  const m = buildHalfEdgeMesh(meshFromIndices(
    [0, 1, 2,  1, 0, 3,  0, 1, 4],
    5,
  ));
  assert.equal(m.faceCount, 3);
  assert.equal(m.nonManifoldEdgeCount, 1);
  // All three half-edges sitting on the {0,1} edge have twin = -1.
  // Those are: he 0 (0→1), he 3 (1→0), he 6 (0→1).
  assert.equal(m.twin[0], -1);
  assert.equal(m.twin[3], -1);
  assert.equal(m.twin[6], -1);
  // Other edges are normal boundaries (each appears once: {1,2},
  // {2,0}, {0,3}, {3,1}, {1,4}, {4,0}). 6 boundaries.
  assert.equal(m.boundaryEdgeCount, 6);
});

test('buildHalfEdgeMesh: two triangles with same-direction shared edge — inconsistent winding flagged', () => {
  // Both faces wind 0→1 on the shared edge. That can't form a
  // manifold pair: one face is flipped relative to the other.
  // tri0 [0,1,2]: 0→1
  // tri1 [0,1,3]: 0→1
  const m = buildHalfEdgeMesh(meshFromIndices(
    [0, 1, 2,  0, 1, 3],
    4,
  ));
  assert.equal(m.nonManifoldEdgeCount, 1);
  // Neither of the two 0→1 half-edges got a twin.
  assert.equal(m.twin[0], -1);
  assert.equal(m.twin[3], -1);
  // The other four are normal boundaries.
  assert.equal(m.boundaryEdgeCount, 4);
});

test('buildHalfEdgeMesh: degenerate triangle (two indices equal) is skipped, not paired', () => {
  // Face 0 is [0, 0, 1] — corner a == corner b → zero-length edge.
  // Adding a real triangle alongside ensures the degenerate didn't
  // sabotage the rest of the builder.
  const m = buildHalfEdgeMesh(meshFromIndices(
    [0, 0, 1,  0, 1, 2],
    3,
  ));
  assert.equal(m.degenerateFaceCount, 1);
  // All half-edges of the degenerate face have twin = -1.
  assert.equal(m.twin[0], -1);
  assert.equal(m.twin[1], -1);
  assert.equal(m.twin[2], -1);
  // The real triangle's half-edges are boundaries as if it were
  // alone — the degenerate didn't accidentally pair with them.
  assert.equal(m.twin[3], -1);
  assert.equal(m.twin[4], -1);
  assert.equal(m.twin[5], -1);
  assert.equal(m.nonManifoldEdgeCount, 0);
});

test('buildHalfEdgeMesh: isolated vertex (no face references it) gets vertexFirstEdge = -1', () => {
  // 4 vertices declared, only 0..2 used. Vertex 3 is isolated.
  const m = buildHalfEdgeMesh(meshFromIndices([0, 1, 2], 4));
  assert.equal(m.vertexCount, 4);
  assert.ok(m.vertexFirstEdge[0]! >= 0);
  assert.ok(m.vertexFirstEdge[1]! >= 0);
  assert.ok(m.vertexFirstEdge[2]! >= 0);
  assert.equal(m.vertexFirstEdge[3], -1, 'isolated vertex should have no seed edge');
});

test('outgoingFan: closed manifold yields every incident edge exactly once', () => {
  // Same tetrahedron. Vertex 0 is incident to 3 faces (tri0, tri1,
  // tri3) → 3 outgoing edges. The fan should yield exactly those.
  const m = buildHalfEdgeMesh(meshFromIndices(
    [0, 1, 2,  0, 3, 1,  1, 3, 2,  2, 3, 0],
    4,
  ));
  const fan = [...outgoingFan(m, 0)];
  assert.equal(fan.length, 3, `expected 3 outgoing edges from v0, got ${fan.length}: ${fan.join(',')}`);
  // Every yielded half-edge actually originates at v0.
  for (const he of fan) assert.equal(m.origin[he], 0);
  // No duplicates.
  assert.equal(new Set(fan).size, fan.length);
  // The set of destinations is exactly {1, 2, 3} — the other three
  // tet vertices.
  const dests = new Set(fan.map((he) => destination(m, he)));
  assert.deepEqual([...dests].sort(), [1, 2, 3]);
});

test('outgoingFan: boundary vertex yields every OUTGOING half-edge (not boundary-incoming-only ones)', () => {
  // Two triangles forming a quad: vertices 0,1,2,3, faces [0,1,2]
  // and [0,2,3]. Vertex 0's outgoing half-edges are 0→1 (face 0)
  // and 0→2 (face 1); the third incident edge {0,3} only has the
  // boundary half-edge 3→0 — incoming to v0, so outgoingFan does
  // NOT yield anything for it (by design — see docstring). Each
  // undirected edge is still reachable from its OTHER endpoint's
  // fan, so "iterate edges once" is best done by walking half-edge
  // ids directly rather than every fan.
  const m = buildHalfEdgeMesh(meshFromIndices([0, 1, 2, 0, 2, 3], 4));
  const fan = [...outgoingFan(m, 0)];
  assert.equal(fan.length, 2, `expected 2 outgoing edges from v0, got: ${fan.join(',')}`);
  const dests = new Set(fan.map((he) => destination(m, he)));
  assert.deepEqual([...dests].sort(), [1, 2]);
  for (const he of fan) assert.equal(m.origin[he], 0);
});

test('outgoingFan: isolated vertex yields nothing', () => {
  const m = buildHalfEdgeMesh(meshFromIndices([0, 1, 2], 4));
  assert.deepEqual([...outgoingFan(m, 3)], []);
});

test('outgoingFan: out-of-range vertex yields nothing (defensive)', () => {
  const m = buildHalfEdgeMesh(meshFromIndices([0, 1, 2], 3));
  assert.deepEqual([...outgoingFan(m, -1)], []);
  assert.deepEqual([...outgoingFan(m, 99)], []);
});

test('buildHalfEdgeMesh: indices length not a multiple of 3 — tail is silently truncated', () => {
  // 4 indices = one full triangle + one orphan. We expect 1 face
  // and no errors.
  const m = buildHalfEdgeMesh(meshFromIndices([0, 1, 2, 0], 3));
  assert.equal(m.faceCount, 1);
  assert.equal(m.halfEdgeCount, 3);
});
