// Diagnostic: does the bevel + compute-normals pipeline produce
// OUTWARD-facing vertex normals on a unit cube?
//
// Method:
//  1. Build a unit cube mesh (8 shared verts, 12 tris).
//  2. selectEdgesByAngle(30°) — marks all 12 cube edges as selected.
//  3. bevelMesh(width=0.12, segments=4).
//  4. computeNormalsWithCuspAngle(30°).
//  5. For every output triangle, check face-winding normal AND averaged
//     per-vertex normal against direction from cube centre (origin) to
//     face centroid.
import { bevelMesh } from '../src/render/bevel.ts';
import { computeNormalsWithCuspAngle } from '../src/render/compute-normals.ts';
import { selectEdgesByAngle } from '../src/render/select-by-angle.ts';

function sharedVertexCube() {
  const positions = [
    -1, -1, -1,   1, -1, -1,   1,  1, -1,  -1,  1, -1,
    -1, -1,  1,   1, -1,  1,   1,  1,  1,  -1,  1,  1,
  ];
  const indices = [
    4, 5, 6,   4, 6, 7,
    1, 0, 3,   1, 3, 2,
    1, 2, 6,   1, 6, 5,
    0, 4, 7,   0, 7, 3,
    7, 6, 2,   7, 2, 3,
    0, 1, 5,   0, 5, 4,
  ];
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(8 * 3),
    uvs: new Float32Array(8 * 2),
    indices: new Uint32Array(indices),
  };
}

const cube = sharedVertexCube();
cube.selection = { edges: selectEdgesByAngle(cube, 30 * Math.PI / 180) };
const beveled = bevelMesh(cube, { width: 0.12, segments: 4 });
console.log('bevel out:', beveled.positions.length / 3, 'verts,', beveled.indices.length / 3, 'tris');

const final = computeNormalsWithCuspAngle(beveled, 30 * Math.PI / 180);
console.log('after compute-normals:', final.positions.length / 3, 'verts,', final.indices.length / 3, 'tris');

let outward = 0, inward = 0, degenerate = 0;
const inwardFaces = [];
const triCount = final.indices.length / 3;
for (let f = 0; f < triCount; f++) {
  const i0 = final.indices[f * 3], i1 = final.indices[f * 3 + 1], i2 = final.indices[f * 3 + 2];
  const ax = final.positions[i0 * 3], ay = final.positions[i0 * 3 + 1], az = final.positions[i0 * 3 + 2];
  const bx = final.positions[i1 * 3], by = final.positions[i1 * 3 + 1], bz = final.positions[i1 * 3 + 2];
  const cx = final.positions[i2 * 3], cy = final.positions[i2 * 3 + 1], cz = final.positions[i2 * 3 + 2];
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-9) { degenerate++; continue; }
  const cxd = (ax + bx + cx) / 3, cyd = (ay + by + cy) / 3, czd = (az + bz + cz) / 3;
  const dot = nx * cxd + ny * cyd + nz * czd;
  if (dot > 0) outward++;
  else { inward++; inwardFaces.push(f); }
}
console.log('face winding:', { outward, inward, degenerate, total: triCount });
if (inwardFaces.length > 0 && inwardFaces.length < 30) console.log('inward face indices:', inwardFaces);

let nOut = 0, nIn = 0, nZero = 0;
for (let f = 0; f < triCount; f++) {
  const i0 = final.indices[f * 3], i1 = final.indices[f * 3 + 1], i2 = final.indices[f * 3 + 2];
  const ax = final.positions[i0 * 3], ay = final.positions[i0 * 3 + 1], az = final.positions[i0 * 3 + 2];
  const bx = final.positions[i1 * 3], by = final.positions[i1 * 3 + 1], bz = final.positions[i1 * 3 + 2];
  const cx = final.positions[i2 * 3], cy = final.positions[i2 * 3 + 1], cz = final.positions[i2 * 3 + 2];
  const cxd = (ax + bx + cx) / 3, cyd = (ay + by + cy) / 3, czd = (az + bz + cz) / 3;
  const n0x = final.normals[i0 * 3], n0y = final.normals[i0 * 3 + 1], n0z = final.normals[i0 * 3 + 2];
  const n1x = final.normals[i1 * 3], n1y = final.normals[i1 * 3 + 1], n1z = final.normals[i1 * 3 + 2];
  const n2x = final.normals[i2 * 3], n2y = final.normals[i2 * 3 + 1], n2z = final.normals[i2 * 3 + 2];
  const nx = (n0x + n1x + n2x) / 3;
  const ny = (n0y + n1y + n2y) / 3;
  const nz = (n0z + n1z + n2z) / 3;
  const lenN = Math.hypot(nx, ny, nz);
  if (lenN < 1e-6) { nZero++; continue; }
  const dot = nx * cxd + ny * cyd + nz * czd;
  if (dot > 0) nOut++; else nIn++;
}
console.log('vertex normals (avg per tri):', { outward: nOut, inward: nIn, zero: nZero });

console.log('first 8 vertex normals:');
for (let i = 0; i < 8; i++) {
  const x = final.normals[i * 3], y = final.normals[i * 3 + 1], z = final.normals[i * 3 + 2];
  const len = Math.hypot(x, y, z);
  console.log(`  [${i}] (${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)}) |len|=${len.toFixed(3)}`);
}
