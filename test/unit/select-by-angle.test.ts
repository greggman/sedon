// Edge-selection-by-dihedral-angle tests. Fixtures are tiny so the
// expected selection mask is obvious by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CpuMeshRef } from '../../src/core/resources.js';
import { countSelectedEdges, selectEdgesByAngle } from '../../src/render/select-by-angle.js';
import { buildHalfEdgeMesh, faceOf, nextInFace } from '../../src/render/half-edge-mesh.js';

const RAD = (deg: number) => deg * Math.PI / 180;

function meshFrom(positions: number[], indices: number[]): CpuMeshRef {
  const vCount = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(vCount * 3),
    uvs: new Float32Array(vCount * 2),
    indices: new Uint32Array(indices),
  };
}

test('selectEdgesByAngle: coplanar quad has NO selected edges at any positive threshold (all interior dihedrals are 0°)', () => {
  // Two coplanar tris on z=0 sharing edge {0,2}. Dihedral angle = 0,
  // so it shouldn't be selected at threshold=1° or any higher.
  const m = meshFrom(
    [0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0],
    [0, 1, 2,  0, 2, 3],
  );
  const sel = selectEdgesByAngle(m, RAD(1));
  assert.equal(countSelectedEdges(sel), 0);
});

test('selectEdgesByAngle: 90° fold — interior edge selected at threshold < 90°, NOT at threshold > 90°', () => {
  // Two triangles meeting at a 90° angle along their shared edge.
  // tri0 [0,1,2] on z=0 (normal +Z); tri1 [1,3,2] in the x=1 plane
  // (normal +X). Shared edge endpoints are vertices 1 and 2.
  const m = meshFrom(
    [0, 0, 0,  1, 0, 0,  1, 1, 0,  1, 0, -1],
    [0, 1, 2,  1, 3, 2],
  );
  const at60 = selectEdgesByAngle(m, RAD(60));
  // One logical edge ≥ 60° → 1 selected (twins both marked).
  assert.equal(countSelectedEdges(at60), 1);
  // Confirm the selection is on the SHARED edge: find the half-edge
  // with endpoints {1,2} (in tri 0 that's corner 1 → 2 = he 1; in tri 1
  // the twin is somewhere in face 1). At least the two twin bytes
  // should both be 1.
  const half = buildHalfEdgeMesh(m);
  let selectedHeOnSharedEdge = 0;
  for (let he = 0; he < half.halfEdgeCount; he++) {
    if (at60[he] === 1) {
      const v0 = half.origin[he]!;
      const v1 = half.origin[nextInFace(he)]!;
      const pair = [v0, v1].sort((a, b) => a - b).join(',');
      if (pair === '1,2') selectedHeOnSharedEdge++;
    }
  }
  assert.equal(selectedHeOnSharedEdge, 2, 'both twins of the {1,2} edge are marked');

  const at120 = selectEdgesByAngle(m, RAD(120));
  // 90° is < 120° → not selected.
  assert.equal(countSelectedEdges(at120), 0);
});

test('selectEdgesByAngle: cube primitive (24 split verts) — every cube edge selected at threshold 30°', () => {
  // The Sedon cube emits 24 split verts; without welding the half-edge
  // layer sees every edge as a boundary. With welding (default), the
  // 12 cube edges all read at 90° dihedral and exceed the 30° default.
  const m = unitCubeSplitVertices();
  const sel = selectEdgesByAngle(m, RAD(30));
  assert.equal(countSelectedEdges(sel), 12, 'a cube has 12 sharp edges');
});

test('selectEdgesByAngle: weldByPosition = false on the cube — no edges selected (every face an island)', () => {
  const m = unitCubeSplitVertices();
  const sel = selectEdgesByAngle(m, RAD(30), { weldByPosition: false });
  assert.equal(countSelectedEdges(sel), 0, 'without welding the half-edge layer sees all-boundary');
});

test('selectEdgesByAngle: 90° fold at exactly the 90° threshold — strict ≥ semantics SELECTS', () => {
  // The convention is angle ≥ threshold means "this is a sharp edge"
  // (the bevel-this-edge case). cos(angle) <= cos(threshold) — equality
  // is the boundary. cos(90°) === cos(90°) → selected.
  const m = meshFrom(
    [0, 0, 0,  1, 0, 0,  1, 1, 0,  1, 0, -1],
    [0, 1, 2,  1, 3, 2],
  );
  const at90 = selectEdgesByAngle(m, RAD(90));
  assert.equal(countSelectedEdges(at90), 1);
});

test('selectEdgesByAngle: boundary edges are NEVER selected (no neighbour face to angle against)', () => {
  // Two tris with a coplanar shared edge and a bunch of boundary
  // edges around the outside. Threshold=0 would normally catch every
  // shared edge, but boundary edges have no twin so they stay 0.
  const m = meshFrom(
    [0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0],
    [0, 1, 2,  0, 2, 3],
  );
  const sel = selectEdgesByAngle(m, RAD(0));
  // The interior edge (coplanar) at angle 0 — cos=1 ≤ cos(0)=1 ⇒
  // selected per ≥-semantics. The 4 outer boundary edges have twin=-1
  // so they cannot be selected.
  assert.equal(countSelectedEdges(sel), 1, 'only the interior coplanar edge selected at threshold=0');
});

test('selectEdgesByAngle: selectBelow inverts the test (selects coplanar/smooth edges)', () => {
  // Same coplanar quad as above. With selectBelow=true and threshold=10°,
  // edges whose dihedral angle is BELOW 10° are selected → the interior
  // coplanar edge.
  const m = meshFrom(
    [0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0],
    [0, 1, 2,  0, 2, 3],
  );
  const sel = selectEdgesByAngle(m, RAD(10), { selectBelow: true });
  assert.equal(countSelectedEdges(sel), 1, 'interior coplanar edge is below 10°');
});

test('selectEdgesByAngle: both twins of a selected edge are marked (the invariant for combinators)', () => {
  const m = meshFrom(
    [0, 0, 0,  1, 0, 0,  1, 1, 0,  1, 0, -1],
    [0, 1, 2,  1, 3, 2],
  );
  const sel = selectEdgesByAngle(m, RAD(45));
  const half = buildHalfEdgeMesh(m);
  // Every byte marked 1 must have its twin also marked 1.
  for (let he = 0; he < half.halfEdgeCount; he++) {
    if (sel[he] === 1) {
      const t = half.twin[he]!;
      assert.ok(t >= 0, `selected he ${he} must have a twin`);
      assert.equal(sel[t], 1, `twin of selected he ${he} (=${t}) must also be selected`);
    }
  }
  // And vice-versa: no orphan 1s.
  void faceOf; // kept for future tests that reference it
});

test('countSelectedEdges: divides bytes-marked by 2 (since both twins of a selected edge are marked)', () => {
  const m = meshFrom(
    [0, 0, 0,  1, 0, 0,  1, 1, 0,  1, 0, -1],
    [0, 1, 2,  1, 3, 2],
  );
  const sel = selectEdgesByAngle(m, RAD(45));
  // The two marked bytes correspond to ONE logical edge.
  let bytesMarked = 0;
  for (let i = 0; i < sel.length; i++) bytesMarked += sel[i]!;
  assert.equal(bytesMarked, 2);
  assert.equal(countSelectedEdges(sel), 1);
});

// ── Fixtures ──────────────────────────────────────────────────────

function unitCubeSplitVertices(): CpuMeshRef {
  const h = 0.5;
  const faces = [
    { o: [+h, -h, +h], eu: [0, 0, -1], ev: [0, +1, 0] },
    { o: [-h, -h, -h], eu: [0, 0, +1], ev: [0, +1, 0] },
    { o: [-h, +h, +h], eu: [+1, 0, 0], ev: [0, 0, -1] },
    { o: [-h, -h, -h], eu: [+1, 0, 0], ev: [0, 0, +1] },
    { o: [-h, -h, +h], eu: [+1, 0, 0], ev: [0, +1, 0] },
    { o: [+h, -h, -h], eu: [-1, 0, 0], ev: [0, +1, 0] },
  ];
  const positions = new Float32Array(24 * 3);
  const uvs = new Float32Array(24 * 2);
  const indices = new Uint32Array(36);
  let p = 0, u = 0, ii = 0;
  const corners: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f]!;
    const base = f * 4;
    for (const [ci, cj] of corners) {
      positions[p]     = face.o[0]! + face.eu[0]! * ci + face.ev[0]! * cj;
      positions[p + 1] = face.o[1]! + face.eu[1]! * ci + face.ev[1]! * cj;
      positions[p + 2] = face.o[2]! + face.eu[2]! * ci + face.ev[2]! * cj;
      uvs[u] = ci; uvs[u + 1] = 1 - cj;
      p += 3; u += 2;
    }
    indices[ii++] = base;
    indices[ii++] = base + 1;
    indices[ii++] = base + 2;
    indices[ii++] = base;
    indices[ii++] = base + 2;
    indices[ii++] = base + 3;
  }
  return { positions, normals: new Float32Array(24 * 3), uvs, indices };
}
