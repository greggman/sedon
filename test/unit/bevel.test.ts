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

test('bevel: 8-vert cube, all 12 edges selected — vertex / face counts match the chamfer pattern', () => {
  // Test cube with shared (welded) vertices. With all 12 edges
  // selected at width 0.1:
  //   • Each of the 8 cube vertices has 3 incident faces, 3 selected
  //     edges → 3 sectors → 3 inset vertices per cube vertex.
  //   • 8 verts × 3 sectors = 24 output vertices.
  //   • Original 12 tris re-emitted (each corner remapped to its
  //     sector inset).
  //   • Each of 12 cube edges contributes 2 strip triangles → 24.
  //   • Each of 8 cube corners contributes 1 cap triangle → 8.
  //   • Total tris = 12 + 24 + 8 = 44.
  const m = sharedVertexCube();
  // Select every shared edge using the angle test — every cube edge
  // is at 90° so threshold 30° catches them all.
  m.selection = { edges: selectEdgesByAngle(m, RAD(30)) };
  const out = bevelMesh(m, { width: 0.1 });
  assert.equal(out.positions.length / 3, 24, 'expected 8 cube verts × 3 sectors = 24 output verts');
  assert.equal(out.indices.length / 3, 44, 'expected 12 inset + 24 strip + 8 cap = 44 triangles');
});

test('bevel: cube primitive (24 split verts), all edges selected — UV islands preserved + chamfer applied', () => {
  // Cube primitive emits per-face split vertices. Welded topology
  // sees the same 8 canonical vertices, but the output keeps per-
  // face UVs. With all edges selected:
  //   • Each canonical vertex has 3 sectors.
  //   • Each sector has 1 face → 1 original vertex per sector at
  //     that canonical, so 3 sector-output-verts per canonical with
  //     distinct UVs.
  //   • 8 × 3 = 24 output verts (matches the input vertex count,
  //     coincidentally).
  //   • Inset / strip / cap counts same as the shared-vert case.
  const m = splitVertexCube();
  m.selection = { edges: selectEdgesByAngle(m, RAD(30)) };
  const out = bevelMesh(m, { width: 0.1 });
  assert.equal(out.positions.length / 3, 24);
  assert.equal(out.indices.length / 3, 44);
});

test('bevel: cube width 0.1 — every inset is exactly distance √3 × 0.1 from its canonical vertex (90° cube corners along the body-diagonal bisector)', () => {
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
  for (let i = 0; i < out.positions.length / 3; i++) {
    const px = out.positions[i * 3]!, py = out.positions[i * 3 + 1]!, pz = out.positions[i * 3 + 2]!;
    let bestDist = Infinity;
    for (const [ix, iy, iz] of inputs) {
      const d = Math.hypot(px - ix, py - iy, pz - iz);
      if (d < bestDist) bestDist = d;
    }
    assert.ok(
      Math.abs(bestDist - width) < 1e-4,
      `vertex ${i} expected distance ${width} from nearest input, got ${bestDist}`,
    );
  }
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
