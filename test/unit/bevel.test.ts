// Chamfer (segments=1 bevel) tests on hand-verifiable fixtures.
// Each fixture is small enough that the expected output vertex /
// face counts are obvious by inspection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CpuMeshRef } from '../../src/core/resources.js';
import { bevelMesh } from '../../src/render/bevel.js';
import { selectEdgesByAngle } from '../../src/render/select-by-angle.js';

const RAD = (deg: number) => deg * Math.PI / 180;

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

test('bevel: no selection → mesh passes through unchanged', () => {
  const m = meshOf(
    [0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0],
    [0, 1, 2,  0, 2, 3],
  );
  const out = bevelMesh(m, { width: 0.1 });
  // No selection mask → short-circuit returns the SAME reference.
  assert.equal(out, m);
});

test('bevel: empty selection (all zeros) → mesh passes through unchanged', () => {
  const m = meshOf(
    [0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0],
    [0, 1, 2,  0, 2, 3],
  );
  m.selection = { edges: new Uint8Array(6) };
  const out = bevelMesh(m, { width: 0.1 });
  assert.equal(out, m);
});

test('bevel: 8-vert cube, all 12 edges selected — vertex / face counts match the outward chamfer pattern', () => {
  // Outward bevel: each cube corner gets 3 unique inset positions
  // (one per cube edge in the OPPOSITE direction along the edge),
  // each face's quad becomes an OCTAGON (corners doubly cut), and
  // the corner cap is the triangle bounded by those 3 insets.
  //
  // Verts: 8 cube vertices × 3 insets = 24.
  // Tris:
  //   • Each cube face is one cluster (2 coplanar tris). The
  //     modified face has 8 outer cuts (2 per cube corner) +
  //     4 inner inset vertices (at the corners of the shrunk
  //     inset region). Triangulated as 4 corner-cut triangles +
  //     1 inner quad (fan-triangulated = 2 sub-tris).
  //   • 6 faces × 6 tris = 36 face tris.
  //   • 12 strips × 2 = 24 strip tris.
  //   • 8 corner caps × 1 = 8 cap tris.
  //   • Total: 36 + 24 + 8 = 68.
  // Verts: 24 outer insets (shared between faces) + 24 inner
  // insets (4 per face, not shared) = 48.
  const m = sharedVertexCube();
  m.selection = { edges: selectEdgesByAngle(m, RAD(30)) };
  const out = bevelMesh(m, { width: 0.1 });
  assert.equal(out.positions.length / 3, 48);
  assert.equal(out.indices.length / 3, 68);
});

test('bevel: cube primitive (24 split verts), all edges selected — UV islands preserved + outward bevel applied', () => {
  // Cube primitive emits per-face split vertices. At each canonical
  // corner the outward bevel produces 3 unique POSITION insets (one
  // per cube edge in opposite direction), but each position is
  // shared by TWO different ORIGINAL vertices (the two faces
  // flanking that cube edge). Output keeps both originals so per-
  // face UVs survive:
  //   8 canonical corners × 3 cube edges × 2 face-originals = 48 verts.
  // Triangle count is the same as the shared-vert case (topology
  // change doesn't depend on UV split): 56.
  const m = splitVertexCube();
  m.selection = { edges: selectEdgesByAngle(m, RAD(30)) };
  const out = bevelMesh(m, { width: 0.1 });
  // 48 split-vertex outer insets + 24 inner insets = 72.
  assert.equal(out.positions.length / 3, 72);
  assert.equal(out.indices.length / 3, 68);
});

test('bevel: cube width 0.1 — every inset / arc intermediate sits at exactly width from its canonical (face centroids excepted)', () => {
  // For a cube vertex with 3 incident faces meeting at right
  // angles, the average bisector (across the 3 single-face sectors)
  // points along the body diagonal away from the cube centre. Per
  // sector, the bisector is the in-FACE bisector — for a square
  // corner that's normalize(unit(+X) + unit(+Y)) = (√2/2, √2/2, 0),
  // length 1. Inset = V + width * bisector → distance from V is
  // exactly `width`. (NOT width × √3 — the bisector is averaged in
  // 3D space across coplanar in-face directions; my earlier mental
  // model that mixed sectors at a cube corner gave the body-diag
  // direction; but each SECTOR has its own bisector in its own
  // face, so the per-sector inset is `width` along that face's
  // bisector.)
  const m = sharedVertexCube();
  m.selection = { edges: selectEdgesByAngle(m, RAD(30)) };
  const width = 0.1;
  const out = bevelMesh(m, { width });
  // Every output vertex must lie at distance `width` from some
  // input vertex (its parent canonical), since per-face bisectors
  // are unit vectors and the inset = V + width * unit.
  const inputs: [number, number, number][] = [];
  for (let i = 0; i < m.positions.length / 3; i++) {
    inputs.push([m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!]);
  }
  // Outer insets sit at distance `width` from their canonical
  // along cube edges. Inner inset corners sit at the inset region's
  // corner — at distance `width × √2` from their canonical for a
  // 90° cube corner (V + w·(d1+d2) with |d1+d2| = √2).
  let outerCount = 0, innerCount = 0;
  for (let i = 0; i < out.positions.length / 3; i++) {
    const px = out.positions[i * 3]!, py = out.positions[i * 3 + 1]!, pz = out.positions[i * 3 + 2]!;
    let bestDist = Infinity;
    for (const [ix, iy, iz] of inputs) {
      const d = Math.hypot(px - ix, py - iy, pz - iz);
      if (d < bestDist) bestDist = d;
    }
    if (Math.abs(bestDist - width) < 1e-4) outerCount++;
    else if (Math.abs(bestDist - width * Math.SQRT2) < 1e-4) innerCount++;
    else assert.fail(`vertex ${i} at unexpected distance ${bestDist}`);
  }
  assert.equal(outerCount, 24, '24 outer cuts on the 12 cube edges');
  assert.equal(innerCount, 24, '24 inner inset corners (4 per face × 6 faces)');
});

test('bevel: single fold (two coplanar triangles sharing one edge) → 1 selected edge → vertex split + strip', () => {
  // Two coplanar tris share edge {0, 2}. Selecting that edge with
  // chamfer split each endpoint into 2 sectors (one per face), so
  //   • 4 verts → 0+2 (unaffected; only 0 and 2 are on the
  //     selected edge) + 4 (2 sectors × 2 verts) = 6 output verts.
  //
  // Faces:
  //   • 2 original faces re-emitted with corners remapped.
  //   • 1 strip = 2 triangles.
  //   • 0 corner fills (each affected vertex has only 1 selected
  //     edge AND no boundary break → single sector → not multi).
  //     Wait — vertices 0 and 2 each have boundary edges around
  //     them, so the boundary acts as a fan break. Let me re-think.
  //
  // Boundary handling: an open-mesh vertex like v0 has incident
  // half-edges that come in via boundary edges (twin = -1). The fan
  // walk yields a linear fan (not cyclic). With ONE selected edge
  // somewhere in the fan, the boundary on the OTHER side of the
  // fan doesn't create a sector break for the selected-edge logic
  // — we treat selected edges only as breakpoints. So a boundary
  // vertex with exactly one selected incident edge has TWO sectors
  // (one on each side of the selected edge) and no extra break
  // from boundaries.
  //
  // Both v0 and v2 are on the selected edge {0,2}: they each split
  // into 2 sectors. v1 and v3 are NOT on the selected edge — they
  // stay as one vertex each (sectorOfCorner = -1).
  // Output verts: v0(×2) + v1 + v2(×2) + v3 = 6.
  // Output tris: 2 (orig) + 2 (strip) + 0 (no multi-sector verts) = 4.
  const m = meshOf(
    [0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0],
    [0, 1, 2,  0, 2, 3],
  );
  m.selection = { edges: selectEdgesByAngle(m, RAD(0)) }; // every interior edge selected
  // The only interior edge in this quad is {0,2}; outer 4 are
  // boundaries and never selected.
  const out = bevelMesh(m, { width: 0.05 });
  // Outward bevel with corner-tri + inner-fan face emission:
  //   Each of the 2 tri clusters has corners with 0 or 1 cuts (no
  //   2-cut corners), so no corner triangles are emitted. The
  //   inner polygon at each cluster is [v_unaffected, cut1, cut2]
  //   = 1 triangle.
  //   Verts: v0 + v3 + 4 strip-endpoint insets = 6.
  //   Tris : 2 clusters × 1 + 1 strip × 2 = 4.
  assert.equal(out.positions.length / 3, 6);
  assert.equal(out.indices.length / 3, 4);
});

test('bevel: cube with NO selected edges (selectEdgesByAngle threshold 180°) — passes through unchanged', () => {
  const m = sharedVertexCube();
  // threshold = 180° → no edge can be > 180° → nothing selected
  m.selection = { edges: selectEdgesByAngle(m, RAD(180.1)) };
  const out = bevelMesh(m, { width: 0.1 });
  assert.equal(out, m, 'no-op when nothing selected');
});

test('bevel: output index buffer is valid (all indices in range)', () => {
  const m = sharedVertexCube();
  m.selection = { edges: selectEdgesByAngle(m, RAD(30)) };
  const out = bevelMesh(m, { width: 0.1 });
  const vCount = out.positions.length / 3;
  for (let i = 0; i < out.indices.length; i++) {
    const v = out.indices[i]!;
    assert.ok(v >= 0 && v < vCount, `index ${i} = ${v} out of range [0, ${vCount})`);
  }
});

test('bevel: output drops the selection mask (topology no longer matches)', () => {
  const m = sharedVertexCube();
  m.selection = { edges: selectEdgesByAngle(m, RAD(30)) };
  const out = bevelMesh(m, { width: 0.1 });
  assert.equal(out.selection, undefined, 'topology changed → selection must be cleared');
});

test('bevel: cube with segments=2 — vertex / face counts match the arc-subdivided outward bevel', () => {
  // Outward bevel at N=2 on the shared-vert cube:
  //   Verts: 24 sector insets + 12 edges × 2 endpoints × (N-1) arc
  //          intermediates = 24 + 24 = 48 (cap interior for N=2 is
  //          (N-1)(N-2)/2 = 0, so no extra).
  //   Verts: 24 outer insets + 24 inner insets + 24 arc intermediates
  //         = 72.
  //   Tris : 36 face (6 × 6 = 4 corner-cuts + 2 inner-quad)
  //         + 12 strips × 2N = 48
  //         + 8 caps × N² = 32
  //         = 116.
  const m = sharedVertexCube();
  m.selection = { edges: selectEdgesByAngle(m, RAD(30)) };
  const out = bevelMesh(m, { width: 0.1, segments: 2 });
  assert.equal(out.positions.length / 3, 72);
  assert.equal(out.indices.length / 3, 116);
});

test('bevel: cube with segments=3 — vertex / face counts match the arc-subdivided outward bevel', () => {
  // N=3:
  //   Verts: 24 + 12×2×(N-1)=48 + 8 × (N-1)(N-2)/2 = 8 interior
  //          = 24 + 48 + 8 = 80.
  //   Verts: 48 + 48 + 8 = 104.
  //   Tris : 36 face + 12 × 2N strip + 8 × N² cap
  //         = 36 + 72 + 72 = 180.
  const m = sharedVertexCube();
  m.selection = { edges: selectEdgesByAngle(m, RAD(30)) };
  const out = bevelMesh(m, { width: 0.1, segments: 3 });
  assert.equal(out.positions.length / 3, 104);
  assert.equal(out.indices.length / 3, 180);
});

test('bevel: cube with segments=2 — arc intermediates sit at exactly width from their canonical (face centroids excepted)', () => {
  const m = sharedVertexCube();
  m.selection = { edges: selectEdgesByAngle(m, RAD(30)) };
  const width = 0.1;
  const out = bevelMesh(m, { width, segments: 2 });
  const inputs: [number, number, number][] = [];
  for (let i = 0; i < m.positions.length / 3; i++) {
    inputs.push([m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!]);
  }
  let outerCount = 0, innerCount = 0;
  for (let i = 0; i < out.positions.length / 3; i++) {
    const px = out.positions[i * 3]!, py = out.positions[i * 3 + 1]!, pz = out.positions[i * 3 + 2]!;
    let bestDist = Infinity;
    for (const [ix, iy, iz] of inputs) {
      const d = Math.hypot(px - ix, py - iy, pz - iz);
      if (d < bestDist) bestDist = d;
    }
    if (Math.abs(bestDist - width) < 1e-4) outerCount++;
    else if (Math.abs(bestDist - width * Math.SQRT2) < 1e-4) innerCount++;
    else assert.fail(`vertex ${i} at unexpected distance ${bestDist}`);
  }
  // 24 outer + 24 arc intermediates at distance width.
  assert.equal(outerCount, 48);
  assert.equal(innerCount, 24);
});

test('bevel: 90° fold strip ring at t=0.5 sits along the diagonal between the two perpendicular face-OTHER edges', () => {
  // Outward bevel of the single-edge fold. The fold's selected
  // edge runs between V1=(1,0,0) and V2=(1,1,0). At V1, the F_A
  // OTHER direction is unit(V0 - V1) = (-1,0,0); the F_B OTHER
  // direction is unit(V3 - V1) = (0,0,-1). With width=0.1 and
  // segments=2, the ring midpoint at V1 sits at V1 + 0.1 × slerp
  // ≈ (1 - 0.0707, 0, -0.0707). Pin that — it's the geometric
  // signature of outward (not inward) bevel.
  const m: CpuMeshRef = {
    positions: new Float32Array([0, 0, 0,  1, 0, 0,  1, 1, 0,  1, 0, -1]),
    normals: new Float32Array(12),
    uvs: new Float32Array(8),
    indices: new Uint32Array([0, 1, 2,  1, 3, 2]),
  };
  m.selection = { edges: selectEdgesByAngle(m, RAD(45)) };
  const out = bevelMesh(m, { width: 0.1, segments: 2 });
  // The mid-arc at V1 has y ≈ 0 (the strip cross-section at V1 is
  // perpendicular to the edge V1-V2 = +Y); x and z each ≈
  // 1 - 0.0707 and -0.0707 by symmetry of the 90° slerp.
  let found: [number, number, number] | null = null;
  for (let i = 0; i < out.positions.length / 3; i++) {
    const px = out.positions[i * 3]!, py = out.positions[i * 3 + 1]!, pz = out.positions[i * 3 + 2]!;
    const dx = px - 1, dy = py - 0, dz = pz - 0;
    const d = Math.hypot(dx, dy, dz);
    if (Math.abs(d - 0.1) < 1e-4 && Math.abs(py) < 0.01) {
      // Mid-arc: dx ≈ dz both negative ≈ -0.0707.
      if (Math.abs(dx - dz) < 1e-3 && dx < -0.05) {
        found = [px, py, pz];
      }
    }
  }
  assert.ok(found, `expected mid-arc ring vertex at V1; got none. positions: ${Array.from(out.positions).map((n) => n.toFixed(3)).join(',')}`);
});

test('bevel: cube with segments=4 — output is well-formed (no NaN / out-of-range indices)', () => {
  const m = sharedVertexCube();
  m.selection = { edges: selectEdgesByAngle(m, RAD(30)) };
  const out = bevelMesh(m, { width: 0.1, segments: 4 });
  const vCount = out.positions.length / 3;
  // Every position is finite.
  for (let i = 0; i < out.positions.length; i++) {
    assert.ok(Number.isFinite(out.positions[i]!), `position[${i}] not finite`);
  }
  // Every index is in range.
  for (let i = 0; i < out.indices.length; i++) {
    const v = out.indices[i]!;
    assert.ok(v >= 0 && v < vCount, `indices[${i}] = ${v} out of range`);
  }
  // Triangle count: 36 face + 12 × 2N strip + 8 × N² cap
  // = 36 + 96 + 128 = 260.
  assert.equal(out.indices.length / 3, 260);
});

// ── Fixtures ───────────────────────────────────────────────────────

function sharedVertexCube(): CpuMeshRef {
  // 8 shared-position vertices, 12 triangles forming a cube with
  // outward-facing normals. Used to test the canonical chamfer case
  // without the split-vertex complication.
  const positions = [
    -1, -1, -1,   1, -1, -1,   1,  1, -1,  -1,  1, -1, // back  z=-1
    -1, -1,  1,   1, -1,  1,   1,  1,  1,  -1,  1,  1, // front z= 1
  ];
  const indices = [
    4, 5, 6,   4, 6, 7,    // +Z
    1, 0, 3,   1, 3, 2,    // -Z
    1, 2, 6,   1, 6, 5,    // +X
    0, 4, 7,   0, 7, 3,    // -X
    7, 6, 2,   7, 2, 3,    // +Y
    0, 1, 5,   0, 5, 4,    // -Y
  ];
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(8 * 3),
    uvs: new Float32Array(8 * 2),
    indices: new Uint32Array(indices),
  };
}

function splitVertexCube(): CpuMeshRef {
  // The Sedon cube-primitive shape: 24 split verts, per-face UVs.
  // Each face's 4 vertices are unique to that face; canonical
  // positions are coincident across faces (welded topology = 8
  // canonical vertices).
  const h = 0.5;
  const faces = [
    { o: [+h, -h, +h], eu: [0, 0, -1], ev: [0, +1, 0] }, // +X
    { o: [-h, -h, -h], eu: [0, 0, +1], ev: [0, +1, 0] }, // -X
    { o: [-h, +h, +h], eu: [+1, 0, 0], ev: [0, 0, -1] }, // +Y
    { o: [-h, -h, -h], eu: [+1, 0, 0], ev: [0, 0, +1] }, // -Y
    { o: [-h, -h, +h], eu: [+1, 0, 0], ev: [0, +1, 0] }, // +Z
    { o: [+h, -h, -h], eu: [-1, 0, 0], ev: [0, +1, 0] }, // -Z
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
