// geom/select-by-normal — face selection by normal direction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CpuMeshRef } from '../../src/core/resources.js';
import { countSelectedFaces, selectFacesByNormal } from '../../src/render/select-by-normal.js';

const RAD = (deg: number) => deg * Math.PI / 180;

function sharedVertexCube(): CpuMeshRef {
  // Same fixture as bevel/extrude tests; tri ordering matches:
  //   tris 0,1 = +Z   tris 2,3 = -Z   tris 4,5 = +X
  //   tris 6,7 = -X   tris 8,9 = +Y   tris 10,11 = -Y
  return {
    positions: new Float32Array([
      -1, -1, -1,   1, -1, -1,   1,  1, -1,  -1,  1, -1,
      -1, -1,  1,   1, -1,  1,   1,  1,  1,  -1,  1,  1,
    ]),
    normals: new Float32Array(8 * 3),
    uvs: new Float32Array(8 * 2),
    indices: new Uint32Array([
      4, 5, 6,   4, 6, 7,
      1, 0, 3,   1, 3, 2,
      1, 2, 6,   1, 6, 5,
      0, 4, 7,   0, 7, 3,
      7, 6, 2,   7, 2, 3,
      0, 1, 5,   0, 5, 4,
    ]),
  };
}

test('select-by-normal: +Y, threshold 30° on a cube → +Y face only (2 tris)', () => {
  const m = sharedVertexCube();
  const mask = selectFacesByNormal(m, {
    direction: [0, 1, 0],
    thresholdRadians: RAD(30),
  });
  assert.equal(countSelectedFaces(mask), 2);
  // The two +Y tris are at indices 8 and 9.
  assert.equal(mask[8], 1);
  assert.equal(mask[9], 1);
});

test('select-by-normal: +Y, threshold 91° → +Y + 4 side faces (upper hemisphere)', () => {
  const m = sharedVertexCube();
  // 91° (slightly past the 90° boundary) so floating-point on
  // cos(threshold) safely includes the side faces whose normals sit
  // exactly perpendicular to +Y. A user who wants "upper hemisphere
  // inclusive of perpendicular" picks anything in (90°, 180°).
  const mask = selectFacesByNormal(m, {
    direction: [0, 1, 0],
    thresholdRadians: RAD(91),
  });
  // +Y (2) + the 4 side faces (4 × 2 = 8) = 10.
  assert.equal(countSelectedFaces(mask), 10);
  // -Y (cosAngle = -1 = cos(180°)) is OUT.
  assert.equal(mask[10], 0);
  assert.equal(mask[11], 0);
});

test('select-by-normal: degenerate direction → empty selection', () => {
  const m = sharedVertexCube();
  const mask = selectFacesByNormal(m, {
    direction: [0, 0, 0],
    thresholdRadians: RAD(45),
  });
  assert.equal(countSelectedFaces(mask), 0);
});

test('select-by-normal: select_below inverts → all tris EXCEPT +Y face', () => {
  const m = sharedVertexCube();
  const mask = selectFacesByNormal(m, {
    direction: [0, 1, 0],
    thresholdRadians: RAD(30),
    selectBelow: true,
  });
  assert.equal(countSelectedFaces(mask), 10); // 12 total - 2 +Y tris
  assert.equal(mask[8], 0);
  assert.equal(mask[9], 0);
});

test('select-by-normal: direction need not be unit length', () => {
  const m = sharedVertexCube();
  const a = selectFacesByNormal(m, {
    direction: [0, 1, 0],
    thresholdRadians: RAD(30),
  });
  const b = selectFacesByNormal(m, {
    direction: [0, 7.3, 0],
    thresholdRadians: RAD(30),
  });
  assert.deepEqual(Array.from(a), Array.from(b));
});

test('select-by-normal: feeds straight into extrude', async () => {
  // Smoke test: produce a faces mask via select-by-normal, hand to
  // extrude, get the cube +Y face pushed up. Same shape as the
  // paneled-door first step.
  const { extrudeMesh } = await import('../../src/render/extrude.js');
  const m = sharedVertexCube();
  m.selection = {
    faces: selectFacesByNormal(m, {
      direction: [0, 1, 0],
      thresholdRadians: RAD(30),
    }),
  };
  const out = extrudeMesh(m, { offset: 0.5 });
  // Output topology: 10 unchanged + 2 cap + 4 walls × 2 = 20 tris.
  assert.equal(out.indices.length / 3, 20);
  // Two cap faces flagged in the output.
  let capCount = 0;
  for (const v of out.selection!.faces!) if (v === 1) capCount++;
  assert.equal(capCount, 2);
});
