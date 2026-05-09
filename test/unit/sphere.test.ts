import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSphere } from '../../src/render/sphere.js';

test('sphere has expected vertex and index counts', () => {
  const segments = 8;
  const rings = 4;
  const sphere = generateSphere(1, segments, rings);
  const verts = (rings + 1) * (segments + 1);
  assert.equal(sphere.positions.length, verts * 3);
  assert.equal(sphere.normals.length, verts * 3);
  assert.equal(sphere.uvs.length, verts * 2);
  assert.equal(sphere.indices.length, rings * segments * 6);
});

test('sphere uvs span the unit square', () => {
  const sphere = generateSphere(1, 8, 4);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < sphere.uvs.length; i += 2) {
    minU = Math.min(minU, sphere.uvs[i]!);
    maxU = Math.max(maxU, sphere.uvs[i]!);
    minV = Math.min(minV, sphere.uvs[i + 1]!);
    maxV = Math.max(maxV, sphere.uvs[i + 1]!);
  }
  assert.equal(minU, 0);
  assert.equal(maxU, 1);
  assert.equal(minV, 0);
  assert.equal(maxV, 1);
});

test('sphere vertices lie on the expected radius', () => {
  const radius = 2.5;
  const sphere = generateSphere(radius, 16, 8);
  for (let i = 0; i < sphere.positions.length; i += 3) {
    const x = sphere.positions[i]!;
    const y = sphere.positions[i + 1]!;
    const z = sphere.positions[i + 2]!;
    const r = Math.hypot(x, y, z);
    assert.ok(Math.abs(r - radius) < 1e-5, `vertex ${i / 3} at radius ${r}, expected ${radius}`);
  }
});

test('sphere normals are unit length', () => {
  const sphere = generateSphere(3, 16, 8);
  for (let i = 0; i < sphere.normals.length; i += 3) {
    const x = sphere.normals[i]!;
    const y = sphere.normals[i + 1]!;
    const z = sphere.normals[i + 2]!;
    const len = Math.hypot(x, y, z);
    assert.ok(Math.abs(len - 1) < 1e-5, `normal ${i / 3} length ${len}`);
  }
});

test('sphere indices are all in range', () => {
  const segments = 12;
  const rings = 6;
  const sphere = generateSphere(1, segments, rings);
  const vertCount = (rings + 1) * (segments + 1);
  for (let i = 0; i < sphere.indices.length; i++) {
    const idx = sphere.indices[i]!;
    assert.ok(idx < vertCount, `index ${i} = ${idx} out of range (vertCount=${vertCount})`);
  }
});
