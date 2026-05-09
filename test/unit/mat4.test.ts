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
