// Tests for the cusp-angle normal recomputation. Each fixture is a
// hand-verifiable mesh so the expected normals / vertex counts are
// obvious by inspection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CpuMeshRef } from '../../src/core/resources.js';
import { computeNormalsWithCuspAngle } from '../../src/render/compute-normals.js';

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

const RAD = (deg: number) => deg * Math.PI / 180;

function approxNormal(a: Float32Array, idx: number, expected: [number, number, number], tol = 1e-5) {
  const ax = a[idx * 3]!, ay = a[idx * 3 + 1]!, az = a[idx * 3 + 2]!;
  assert.ok(Math.abs(ax - expected[0]) < tol, `v${idx} normal.x: ${ax} vs ${expected[0]}`);
  assert.ok(Math.abs(ay - expected[1]) < tol, `v${idx} normal.y: ${ay} vs ${expected[1]}`);
  assert.ok(Math.abs(az - expected[2]) < tol, `v${idx} normal.z: ${az} vs ${expected[2]}`);
}

test('compute-normals: single triangle — every corner gets the face normal', () => {
  // CCW from +Z: cross = (e1 × e2) points +Z.
  const m = meshOf([0, 0, 0,  1, 0, 0,  0, 1, 0], [0, 1, 2]);
  const out = computeNormalsWithCuspAngle(m, RAD(30));
  assert.equal(out.positions.length / 3, 3);
  assert.equal(out.indices.length, 3);
  for (let v = 0; v < 3; v++) approxNormal(out.normals, v, [0, 0, 1]);
});

test('compute-normals: two coplanar triangles — no split, smooth normals everywhere', () => {
  // Quad on z=0, two tris sharing edge 0-2. Both face normals are
  // exactly +Z; angle between them is 0 < any positive cusp.
  const m = meshOf(
    [0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0],
    [0, 1, 2,  0, 2, 3],
  );
  const out = computeNormalsWithCuspAngle(m, RAD(30));
  assert.equal(out.positions.length / 3, 4, 'no vertex split on a coplanar quad');
  for (let v = 0; v < 4; v++) approxNormal(out.normals, v, [0, 0, 1]);
});

test('compute-normals: two triangles at 90° (a folded sheet) — split when cusp is below 90°', () => {
  // Triangle A on z=0 plane: corners (0,0,0), (1,0,0), (1,1,0). Normal +Z.
  // Triangle B on y=0 plane: corners (1,0,0), (1,0,-1), (1,1,0). Normal +X.
  // (Hand check: B's vertices share edge {1,0,0}-{1,1,0} with A.)
  // Dihedral angle between +Z and +X is 90°. With cusp 30°, that's
  // a crease; the shared vertices get split → 6 output vertices.
  const m = meshOf(
    [0, 0, 0,  1, 0, 0,  1, 1, 0,  1, 0, -1],
    [0, 1, 2,  1, 3, 2],
  );
  const out30 = computeNormalsWithCuspAngle(m, RAD(30));
  assert.equal(out30.positions.length / 3, 6, '90° angle creases at cusp 30°');
  // Each face's three corners are independent vertices with the face normal.
  // Faces are emitted in input index order: face 0 = corners 0..2 → +Z;
  // face 1 = corners 3..5 → +X. (Group ids match emission order via
  // the BFS seeding loop walking corners 0..halfEdgeCount.)
  for (let i = 0; i < 3; i++) approxNormal(out30.normals, out30.indices[i]!, [0, 0, 1]);
  for (let i = 3; i < 6; i++) approxNormal(out30.normals, out30.indices[i]!, [1, 0, 0]);
});

test('compute-normals: 90° fold smooths into 4 vertices when cusp = 180°', () => {
  // Same fold. cusp=180° = "always smooth." Output is the original
  // 4 vertices; the two shared vertices get an averaged normal
  // (the (+Z + +X)/√2 direction).
  const m = meshOf(
    [0, 0, 0,  1, 0, 0,  1, 1, 0,  1, 0, -1],
    [0, 1, 2,  1, 3, 2],
  );
  const out = computeNormalsWithCuspAngle(m, RAD(180));
  assert.equal(out.positions.length / 3, 4, 'cusp=180° preserves vertex count when topology shares');
  // Vertices 0 and 3 are only in one face each (corners of just one
  // triangle) — they keep that face's normal.
  // Vertices 1 and 2 are shared, so their normal is the area-weighted
  // average. Both face areas are 0.5; both unit normals are axis-
  // aligned. Average = (1, 0, 1)/√2.
  const r2 = 1 / Math.SQRT2;
  // Find which output vertex corresponds to which source vertex by
  // position (the algorithm preserves UVs+positions). Vertex 0 in
  // source = position (0,0,0); we expect that output vertex to have
  // normal +Z (only in face 0).
  function vertexAt(x: number, y: number, z: number, tol = 1e-5): number {
    for (let i = 0; i < out.positions.length / 3; i++) {
      if (Math.abs(out.positions[i * 3]! - x) < tol
        && Math.abs(out.positions[i * 3 + 1]! - y) < tol
        && Math.abs(out.positions[i * 3 + 2]! - z) < tol) return i;
    }
    return -1;
  }
  approxNormal(out.normals, vertexAt(0, 0, 0), [0, 0, 1]);
  approxNormal(out.normals, vertexAt(1, 0, -1), [1, 0, 0]);
  approxNormal(out.normals, vertexAt(1, 0, 0), [r2, 0, r2]);
  approxNormal(out.normals, vertexAt(1, 1, 0), [r2, 0, r2]);
});

test('compute-normals: cube with cusp=30° produces 24 output vertices (one per face-corner)', () => {
  // Unit cube. 8 source vertices, 12 triangles. Each pair of faces
  // around a cube edge meets at 90° → all 12 edges crease. Each
  // vertex's 3 incident faces split into 3 distinct groups → 8 × 3
  // = 24 output vertices.
  const m = unitCube();
  const out = computeNormalsWithCuspAngle(m, RAD(30));
  assert.equal(out.positions.length / 3, 24);
  // Each face's 4 corners should have the SAME normal — the face's
  // outward axis. Walk the 12 triangles (6 faces × 2 tris each) and
  // pin each corner's normal.
  const faceNormals = perFaceCubeNormals();
  for (let f = 0; f < 12; f++) {
    const expected = faceNormals[(f / 2) | 0]!;
    for (let k = 0; k < 3; k++) {
      const outV = out.indices[f * 3 + k]!;
      approxNormal(out.normals, outV, expected);
    }
  }
});

test('compute-normals: cube with cusp=180° (always smooth) — 8 vertices, normals pointing toward each vertex', () => {
  const m = unitCube();
  const out = computeNormalsWithCuspAngle(m, RAD(180));
  assert.equal(out.positions.length / 3, 8);
  // Each output vertex should sit at one of the 8 corners. The
  // averaged normal at the (1,1,1) corner is the (+X + +Y + +Z)/√3
  // direction.
  function vertexAt(x: number, y: number, z: number): number {
    for (let i = 0; i < 8; i++) {
      if (Math.abs(out.positions[i * 3]! - x) < 1e-5
        && Math.abs(out.positions[i * 3 + 1]! - y) < 1e-5
        && Math.abs(out.positions[i * 3 + 2]! - z) < 1e-5) return i;
    }
    return -1;
  }
  const r3 = 1 / Math.sqrt(3);
  approxNormal(out.normals, vertexAt(1, 1, 1), [r3, r3, r3]);
  approxNormal(out.normals, vertexAt(-1, -1, -1), [-r3, -r3, -r3]);
  approxNormal(out.normals, vertexAt(1, -1, 1), [r3, -r3, r3]);
});

test('compute-normals: cube at the threshold — cusp just BELOW 90° still creases (strict-less-than semantics)', () => {
  // 90° between cube faces. With cusp = 89.9°, we want creases.
  // (cos test: cosAngle > cosThreshold → smooth; at exactly 90° the
  // cos is 0; cos(89.9°) is slightly > 0. So 0 > 0.00175 is false →
  // crease. Good.)
  const m = unitCube();
  const out = computeNormalsWithCuspAngle(m, RAD(89.9));
  assert.equal(out.positions.length / 3, 24);
});

test('compute-normals: cusp just ABOVE 90° smooths the cube', () => {
  const m = unitCube();
  const out = computeNormalsWithCuspAngle(m, RAD(90.1));
  assert.equal(out.positions.length / 3, 8);
});

test('compute-normals: boundary edges always crease (no smoothing across them)', () => {
  // Three triangles forming a strip on z=0. The two interior edges
  // are coplanar → smooth at any positive cusp. But the OUTER edges
  // are boundaries → don't matter for smoothing groups (there's no
  // other face to smooth with). Confirm the interior corners get
  // the shared coplanar +Z normal and the strip has 5 vertices.
  const m = meshOf(
    [0, 0, 0,  1, 0, 0,  2, 0, 0,  0, 1, 0,  1, 1, 0,  2, 1, 0],
    [0, 1, 4,  0, 4, 3,  1, 2, 5,  1, 5, 4],
  );
  const out = computeNormalsWithCuspAngle(m, RAD(30));
  // Coplanar strip → every face-pair is smooth → 6 unique groups
  // is wrong: actually, every CORNER per vertex shares a smoothing
  // group since coplanar. So 6 output vertices total.
  assert.equal(out.positions.length / 3, 6);
  for (let v = 0; v < 6; v++) approxNormal(out.normals, v, [0, 0, 1]);
});

test('compute-normals: degenerate face contributes no smoothing — stays isolated, valid +Y fallback normal', () => {
  // Face 0 is the real triangle; face 1 is degenerate (two equal
  // indices). The degenerate face MUST NOT pollute the smoothing
  // average of the real triangle's corners, and its own corners
  // must end up with the fallback +Y normal (not NaN).
  const m = meshOf(
    [0, 0, 0,  1, 0, 0,  0, 1, 0],
    [0, 1, 2,  0, 0, 1],
  );
  const out = computeNormalsWithCuspAngle(m, RAD(30));
  // 3 real corners + 3 degenerate corners, each in its own group →
  // 6 output vertices.
  assert.equal(out.positions.length / 3, 6);
  // First 3 indices index into the +Z group.
  for (let i = 0; i < 3; i++) approxNormal(out.normals, out.indices[i]!, [0, 0, 1]);
  // Next 3 are the degenerate face's corners — each gets the +Y
  // fallback (since their group's summed normal is zero).
  for (let i = 3; i < 6; i++) approxNormal(out.normals, out.indices[i]!, [0, 1, 0]);
});

test('compute-normals: UVs forwarded onto split duplicates from the source vertex', () => {
  // Same 90° fold as before, but with distinct UVs per source vertex.
  // After the cusp split each duplicate should carry the source UV
  // it descended from.
  const positions = [0, 0, 0,  1, 0, 0,  1, 1, 0,  1, 0, -1];
  const uvs = [0.1, 0.2,  0.3, 0.4,  0.5, 0.6,  0.7, 0.8];
  const m: CpuMeshRef = {
    positions: new Float32Array(positions),
    normals: new Float32Array(4 * 3),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array([0, 1, 2,  1, 3, 2]),
  };
  const out = computeNormalsWithCuspAngle(m, RAD(30));
  // Every output vertex sits on one of the 4 source vertices; UV
  // matches the source by position.
  for (let i = 0; i < out.positions.length / 3; i++) {
    // Find source vertex with matching position.
    const opx = out.positions[i * 3]!, opy = out.positions[i * 3 + 1]!, opz = out.positions[i * 3 + 2]!;
    let matched = -1;
    for (let s = 0; s < 4; s++) {
      if (Math.abs(positions[s * 3]! - opx) < 1e-5
        && Math.abs(positions[s * 3 + 1]! - opy) < 1e-5
        && Math.abs(positions[s * 3 + 2]! - opz) < 1e-5) {
        matched = s;
        break;
      }
    }
    assert.ok(matched >= 0, `output v${i} has no source match`);
    assert.ok(Math.abs(out.uvs[i * 2]! - uvs[matched * 2]!) < 1e-5);
    assert.ok(Math.abs(out.uvs[i * 2 + 1]! - uvs[matched * 2 + 1]!) < 1e-5);
  }
});

// ─ Helpers ────────────────────────────────────────────────────────

function unitCube(): CpuMeshRef {
  // Eight corners of the [-1, 1]³ cube. Faces wound CCW from
  // OUTSIDE (so face normals point outward).
  const positions = [
    -1, -1, -1,   1, -1, -1,   1,  1, -1,  -1,  1, -1, // back face vertices  (0..3) z = -1
    -1, -1,  1,   1, -1,  1,   1,  1,  1,  -1,  1,  1, // front face vertices (4..7) z =  1
  ];
  const indices = [
    // +Z (front, z=1):  4,5,6,7 CCW from +Z
    4, 5, 6,   4, 6, 7,
    // -Z (back,  z=-1): 1,0,3,2 CCW from -Z
    1, 0, 3,   1, 3, 2,
    // +X (right, x=1):  1,2,6,5 CCW from +X
    1, 2, 6,   1, 6, 5,
    // -X (left,  x=-1): 0,4,7,3 CCW from -X
    0, 4, 7,   0, 7, 3,
    // +Y (top,   y=1):  7,6,2,3 CCW from +Y
    7, 6, 2,   7, 2, 3,
    // -Y (bottom,y=-1): 0,1,5,4 CCW from -Y
    0, 1, 5,   0, 5, 4,
  ];
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(8 * 3),
    uvs: new Float32Array(8 * 2),
    indices: new Uint32Array(indices),
  };
}

function perFaceCubeNormals(): [number, number, number][] {
  // Indexed the same order the cube emits triangles: +Z, -Z, +X, -X, +Y, -Y.
  return [
    [0, 0, 1],
    [0, 0, -1],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
  ];
}
