// Partial-range primitives: geom/sphere / cylinder / cone support
// latitude/longitude (or angle) windowing with an optional cap to
// close the resulting open boundaries. Tests pin the contract: full
// defaults still produce a closed solid, restricting any window
// shrinks the bounding box, and cap behaviour adds/removes the
// expected open boundaries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSphere } from '../../src/render/sphere.js';
import { generateCylinder } from '../../src/render/cylinder.js';
import { generateCone } from '../../src/render/cone.js';
import type { CpuMesh } from '../../src/render/mesh.js';

function bbox(mesh: { positions: Float32Array }): {
  min: [number, number, number];
  max: [number, number, number];
} {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i]!, y = mesh.positions[i + 1]!, z = mesh.positions[i + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function hasFlatYNormal(mesh: { normals: Float32Array }, sign: 1 | -1): boolean {
  for (let i = 0; i < mesh.normals.length; i += 3) {
    if (Math.abs(mesh.normals[i]!) < 1e-3
      && Math.abs(mesh.normals[i + 1]! - sign) < 1e-3
      && Math.abs(mesh.normals[i + 2]!) < 1e-3) return true;
  }
  return false;
}

function inRangeUVs(mesh: CpuMesh): boolean {
  for (let i = 0; i < mesh.uvs.length; i++) {
    if (mesh.uvs[i]! < -1e-6 || mesh.uvs[i]! > 1 + 1e-6) return false;
  }
  return true;
}

// ─── Sphere ───────────────────────────────────────────────────────

test('sphere defaults reproduce a full closed UV sphere (no caps, normalised radius)', () => {
  const m = generateSphere({ radius: 1, segments: 16, rings: 8 });
  const bb = bbox(m);
  for (const v of [...bb.min, ...bb.max]) assert.ok(Math.abs(Math.abs(v) - 1) < 1e-3);
});

test('sphere: northern hemisphere (lat_start=0) keeps Y in [0, radius]', () => {
  const m = generateSphere({
    radius: 1, segments: 16, rings: 8,
    latitudeStart: 0,
    latitudeEnd: Math.PI / 2,
  });
  const bb = bbox(m);
  assert.ok(bb.min[1] >= -1e-3, `min.y should be ≥ 0 for northern hemisphere, got ${bb.min[1]}`);
  assert.ok(Math.abs(bb.max[1] - 1) < 1e-3);
});

test('sphere: cap:true on a windowed sphere adds a flat-bottom cap with -Y normals', () => {
  // Northern hemisphere. The equator is now an open boundary; cap
  // should close it with a -Y-facing disc.
  const m = generateSphere({
    radius: 1, segments: 8, rings: 4,
    latitudeStart: 0,
    latitudeEnd: Math.PI / 2,
    cap: true,
  });
  assert.ok(hasFlatYNormal(m, -1), 'expected a -Y normal somewhere (bottom cap)');
});

test('sphere: cap:false on a windowed sphere leaves the boundary open (no flat caps)', () => {
  const m = generateSphere({
    radius: 1, segments: 8, rings: 4,
    latitudeStart: 0,
    latitudeEnd: Math.PI / 2,
    cap: false,
  });
  assert.ok(!hasFlatYNormal(m, -1), 'no flat -Y normal expected when cap:false');
});

test('sphere: longitude window shrinks the X/Z extent (half-orange has Z≈[-r, 0])', () => {
  // Half-orange wedge: theta in [π, 2π] — south half of the equator,
  // so Z stays in [-r, 0] (since sin(theta) ≤ 0 across that range).
  const m = generateSphere({
    radius: 1, segments: 16, rings: 8,
    longitudeStart: Math.PI,
    longitudeEnd: 2 * Math.PI,
  });
  const bb = bbox(m);
  assert.ok(bb.max[2] <= 1e-3, `expected max.z ≤ 0 for half-orange, got ${bb.max[2]}`);
  assert.ok(bb.min[2] >= -1 - 1e-3);
});

test('sphere: UVs span the unit square regardless of window', () => {
  const m = generateSphere({
    radius: 1, segments: 8, rings: 4,
    latitudeStart: Math.PI / 6,
    latitudeEnd: Math.PI / 3,
    longitudeStart: 0,
    longitudeEnd: Math.PI,
  });
  assert.ok(inRangeUVs(m));
});

test('sphere: indices stay in range when caps are added', () => {
  const m = generateSphere({
    radius: 1, segments: 8, rings: 4,
    latitudeStart: 0,
    cap: true,
  });
  const v = m.positions.length / 3;
  for (let i = 0; i < m.indices.length; i++) {
    assert.ok(m.indices[i]! < v, `index ${i} = ${m.indices[i]} out of range (vCount=${v})`);
  }
});

// ─── Cylinder ─────────────────────────────────────────────────────

test('cylinder defaults reproduce a full closed cylinder with both caps', () => {
  const m = generateCylinder({ radius: 1, height: 2, segments: 16 });
  const bb = bbox(m);
  assert.ok(Math.abs(bb.min[1]) < 1e-6);
  assert.ok(Math.abs(bb.max[1] - 2) < 1e-6);
  assert.ok(hasFlatYNormal(m, 1), 'top cap (+Y)');
  assert.ok(hasFlatYNormal(m, -1), 'bottom cap (-Y)');
});

test('cylinder: angle window shrinks the X/Z extent', () => {
  // Quarter wedge in the +X / +Z quadrant.
  const m = generateCylinder({
    radius: 1, height: 1, segments: 12,
    angleStart: 0,
    angleEnd: Math.PI / 2,
  });
  const bb = bbox(m);
  assert.ok(bb.max[0] <= 1 + 1e-6 && bb.min[0] >= -1e-6, `X should stay in [0, r], got [${bb.min[0]}, ${bb.max[0]}]`);
  assert.ok(bb.max[2] <= 1 + 1e-6 && bb.min[2] >= -1e-6, `Z should stay in [0, r], got [${bb.min[2]}, ${bb.max[2]}]`);
});

test('cylinder: cap:true on a partial wedge adds radial wall normals (pointing in the XZ plane)', () => {
  const m = generateCylinder({
    radius: 1, height: 1, segments: 8,
    angleStart: 0,
    angleEnd: Math.PI,
    cap: true,
  });
  // The +X tangent endpoint (angle=0) means the start-wall outward
  // normal should be (sin 0, 0, -cos 0) = (0, 0, -1).
  let foundStartWallN = false;
  for (let i = 0; i < m.normals.length; i += 3) {
    if (Math.abs(m.normals[i]!) < 1e-3
      && Math.abs(m.normals[i + 1]!) < 1e-3
      && Math.abs(m.normals[i + 2]! + 1) < 1e-3) {
      foundStartWallN = true;
      break;
    }
  }
  assert.ok(foundStartWallN, 'expected a (0,0,-1) wall normal for the start radial wall');
});

test('cylinder: cap:false produces an open tube — no flat Y normals anywhere', () => {
  const m = generateCylinder({ radius: 1, height: 1, segments: 8, cap: false });
  assert.ok(!hasFlatYNormal(m, 1), 'no +Y normals');
  assert.ok(!hasFlatYNormal(m, -1), 'no -Y normals');
});

test('cylinder: indices stay in range with cap + partial', () => {
  const m = generateCylinder({
    radius: 1, height: 1, segments: 8,
    angleStart: 0, angleEnd: Math.PI / 2, cap: true,
  });
  const v = m.positions.length / 3;
  for (let i = 0; i < m.indices.length; i++) {
    assert.ok(m.indices[i]! < v);
  }
});

// ─── Cone ─────────────────────────────────────────────────────────

test('cone defaults reproduce a full closed cone with a bottom cap', () => {
  const m = generateCone({ radius: 1, height: 2, segments: 16 });
  const bb = bbox(m);
  assert.ok(Math.abs(bb.min[1]) < 1e-6);
  assert.ok(Math.abs(bb.max[1] - 2) < 1e-6);
  assert.ok(hasFlatYNormal(m, -1), 'bottom cap (-Y)');
});

test('cone: angle window shrinks the X/Z extent', () => {
  const m = generateCone({
    radius: 1, height: 1, segments: 12,
    angleStart: 0,
    angleEnd: Math.PI / 2,
  });
  const bb = bbox(m);
  assert.ok(bb.min[0] >= -1e-6 && bb.max[0] <= 1 + 1e-6);
  assert.ok(bb.min[2] >= -1e-6 && bb.max[2] <= 1 + 1e-6);
});

test('cone: cap:false on a partial wedge leaves all boundaries open (no -Y normals)', () => {
  const m = generateCone({
    radius: 1, height: 1, segments: 8,
    angleStart: 0,
    angleEnd: Math.PI / 2,
    cap: false,
  });
  assert.ok(!hasFlatYNormal(m, -1), 'no -Y normal expected with cap:false');
});

test('cone: cap:true on a partial wedge adds bottom cap + two triangle walls', () => {
  const m = generateCone({
    radius: 1, height: 1, segments: 8,
    angleStart: 0,
    angleEnd: Math.PI / 2,
    cap: true,
  });
  // bottom cap → -Y normals exist
  assert.ok(hasFlatYNormal(m, -1));
  // Start wall outward normal = (sin 0, 0, -cos 0) = (0, 0, -1).
  let foundWall = false;
  for (let i = 0; i < m.normals.length; i += 3) {
    if (Math.abs(m.normals[i]!) < 1e-3
      && Math.abs(m.normals[i + 1]!) < 1e-3
      && Math.abs(m.normals[i + 2]! + 1) < 1e-3) {
      foundWall = true;
      break;
    }
  }
  assert.ok(foundWall, 'expected start-wall (0, 0, -1) normal');
});

test('cone: indices stay in range with cap + partial', () => {
  const m = generateCone({
    radius: 1, height: 1, segments: 8,
    angleStart: 0, angleEnd: Math.PI / 2, cap: true,
  });
  const v = m.positions.length / 3;
  for (let i = 0; i < m.indices.length; i++) {
    assert.ok(m.indices[i]! < v);
  }
});
