import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateGrassCard } from '../../src/render/grass-card.js';

test('grass card: default 2 quads → 8 verts, 12 indices', () => {
  const m = generateGrassCard();
  assert.equal(m.positions.length, 8 * 3, '8 vertices');
  assert.equal(m.uvs.length, 8 * 2);
  assert.equal(m.normals.length, 8 * 3);
  assert.equal(m.indices.length, 2 * 6, '2 quads × 2 tris × 3 verts');
});

test('grass card: quad count scales verts + indices', () => {
  const m = generateGrassCard(3);
  assert.equal(m.positions.length, 12 * 3, '3 quads × 4 verts');
  assert.equal(m.indices.length, 3 * 6);
});

test('grass card: base sits on y=0, tip at y=1 (unit height for per-instance scaling)', () => {
  const m = generateGrassCard(2);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < m.positions.length; i += 3) {
    const y = m.positions[i + 1]!;
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  assert.equal(minY, 0, 'base anchored at ground (y=0)');
  assert.equal(maxY, 1, 'tip at unit height');
});

test('grass card: normals are sky-up (soft even lighting, no dark blade backs)', () => {
  const m = generateGrassCard(3);
  for (let i = 0; i < m.normals.length; i += 3) {
    assert.equal(m.normals[i], 0, 'nx=0');
    assert.equal(m.normals[i + 1], 1, 'ny=1 (up)');
    assert.equal(m.normals[i + 2], 0, 'nz=0');
  }
});

test('grass card: UV tip at V=0, base at V=1 (matches WebGPU top-left origin)', () => {
  const m = generateGrassCard(1);
  // Vert order per quad: 0=base-left,1=base-right,2=tip-left,3=tip-right.
  // base verts → v=1, tip verts → v=0.
  assert.equal(m.uvs[1], 1, 'base-left V=1');   // vert 0
  assert.equal(m.uvs[3], 1, 'base-right V=1');  // vert 1
  assert.equal(m.uvs[5], 0, 'tip-left V=0');    // vert 2
  assert.equal(m.uvs[7], 0, 'tip-right V=0');   // vert 3
});

test('grass card: quads are rotated about Y so they are not coplanar', () => {
  // With 2 quads at 0 and 90°, the second quad's corners must have
  // non-zero Z extent (the first quad lies in the XY plane, z≈0).
  const m = generateGrassCard(2);
  let maxAbsZ = 0;
  for (let i = 0; i < m.positions.length; i += 3) {
    maxAbsZ = Math.max(maxAbsZ, Math.abs(m.positions[i + 2]!));
  }
  assert.ok(maxAbsZ > 0.4, 'second quad spans Z (cross-quad, not a single plane)');
});
