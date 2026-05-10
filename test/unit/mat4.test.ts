import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identity, multiply, perspective, rotationY, translation } from '../../src/render/mat4.js';

function approxEqual(a: Float32Array, b: number[], eps = 1e-5) {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i]! - b[i]!) < eps, `index ${i}: ${a[i]} vs ${b[i]}`);
  }
}

test('identity is the identity matrix', () => {
  approxEqual(identity(), [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
});

test('identity * identity = identity', () => {
  approxEqual(multiply(identity(), identity()), [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
});

test('translation places into the last column (column-major layout)', () => {
  const t = translation(2, 3, 4);
  // Column-major: m[12], m[13], m[14] hold x, y, z translation.
  assert.equal(t[12], 2);
  assert.equal(t[13], 3);
  assert.equal(t[14], 4);
});

test('rotationY by 0 is identity', () => {
  approxEqual(rotationY(0), Array.from(identity()));
});

test('multiply translation by identity leaves it unchanged', () => {
  const t = translation(1, 2, 3);
  approxEqual(multiply(t, identity()), Array.from(t));
  approxEqual(multiply(identity(), t), Array.from(t));
});

test('perspective produces a sane projection matrix', () => {
  const p = perspective(Math.PI / 2, 1, 0.1, 100);
  // For fovY=90, aspect=1: m[0]=1, m[5]=1, m[11]=-1
  assert.ok(Math.abs(p[0]! - 1) < 1e-5);
  assert.ok(Math.abs(p[5]! - 1) < 1e-5);
  assert.equal(p[11], -1);
});

// Project a view-space point (looking down -Z, so view.z is negative) and
// return ndc.z after the perspective divide.
function projectNdcZ(p: Float32Array, viewZ: number): number {
  // clip.z = m[2]*x + m[6]*y + m[10]*z + m[14]*w; for view-space (0,0,viewZ,1):
  const clipZ = p[10]! * viewZ + p[14]!;
  // clip.w = m[3]*x + m[7]*y + m[11]*z + m[15]*w; m[3]=m[7]=m[15]=0, m[11]=-1.
  const clipW = p[11]! * viewZ;
  return clipZ / clipW;
}

test('perspective is reverse-Z: maps zNear → 1, zFar → 0', () => {
  const zNear = 0.1;
  const zFar = 100;
  const p = perspective(Math.PI / 2, 1, zNear, zFar);
  // View-space z is negative for points in front of the camera (looking -Z).
  assert.ok(Math.abs(projectNdcZ(p, -zNear) - 1) < 1e-5, 'near plane should map to 1');
  assert.ok(Math.abs(projectNdcZ(p, -zFar)) < 1e-5, 'far plane should map to 0');
});

test('perspective with infinite zFar stays well-defined', () => {
  const zNear = 0.1;
  const p = perspective(Math.PI / 2, 1, zNear, Infinity);
  assert.ok(Math.abs(projectNdcZ(p, -zNear) - 1) < 1e-5, 'near plane should map to 1');
  // At very far distances ndc.z approaches 0 from above.
  const farZ = projectNdcZ(p, -1e9);
  assert.ok(farZ > 0 && farZ < 1e-6, 'distant geometry should map near 0');
});
