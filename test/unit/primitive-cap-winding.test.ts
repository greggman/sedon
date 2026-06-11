// Regression guard for the cap-winding bug: every cap triangle's
// FACE normal (computed from its winding via cross product) must
// match the average of its three vertices' declared normals — within
// floating-point tolerance. If they disagree the triangle is back-
// face-culled when viewed from the outward side and the cap appears
// invisible / hollow.
//
// Also covers the slice caps that close the longitude-side openings
// on a partial sphere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSphere } from '../../src/render/sphere.js';
import { generateCylinder } from '../../src/render/cylinder.js';
import { generateCone } from '../../src/render/cone.js';

interface Mesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

// Iterate every triangle, compute its FACE normal (from the winding)
// and the AVERAGE of the three vertex normals. If they disagree by
// more than 90° the winding is backward.
function findWindingFlaws(mesh: Mesh): { tri: number; faceN: number[]; vertN: number[] }[] {
  const flaws: { tri: number; faceN: number[]; vertN: number[] }[] = [];
  const ind = mesh.indices;
  const pos = mesh.positions;
  const nrm = mesh.normals;
  for (let t = 0; t < ind.length; t += 3) {
    const a = ind[t]!, b = ind[t + 1]!, c = ind[t + 2]!;
    const ax = pos[a * 3]!, ay = pos[a * 3 + 1]!, az = pos[a * 3 + 2]!;
    const bx = pos[b * 3]!, by = pos[b * 3 + 1]!, bz = pos[b * 3 + 2]!;
    const cx = pos[c * 3]!, cy = pos[c * 3 + 1]!, cz = pos[c * 3 + 2]!;
    const ex = bx - ax, ey = by - ay, ez = bz - az;
    const fx = cx - ax, fy = cy - ay, fz = cz - az;
    let fnx = ey * fz - ez * fy;
    let fny = ez * fx - ex * fz;
    let fnz = ex * fy - ey * fx;
    const fnLen = Math.hypot(fnx, fny, fnz);
    if (fnLen < 1e-9) continue; // degenerate triangle (e.g. pole singularity)
    fnx /= fnLen; fny /= fnLen; fnz /= fnLen;
    const vnx = (nrm[a * 3]! + nrm[b * 3]! + nrm[c * 3]!) / 3;
    const vny = (nrm[a * 3 + 1]! + nrm[b * 3 + 1]! + nrm[c * 3 + 1]!) / 3;
    const vnz = (nrm[a * 3 + 2]! + nrm[b * 3 + 2]! + nrm[c * 3 + 2]!) / 3;
    const vnLen = Math.hypot(vnx, vny, vnz);
    if (vnLen < 1e-9) continue; // averaged out to zero
    const dot = (fnx * vnx + fny * vny + fnz * vnz) / vnLen;
    if (dot < 0) {
      flaws.push({
        tri: t / 3,
        faceN: [fnx, fny, fnz],
        vertN: [vnx / vnLen, vny / vnLen, vnz / vnLen],
      });
    }
  }
  return flaws;
}

// ─── Sphere ───────────────────────────────────────────────────────

test('sphere: full sphere has no backward triangles', () => {
  const m = generateSphere({ radius: 1, segments: 16, rings: 8 });
  const flaws = findWindingFlaws(m);
  assert.equal(flaws.length, 0, `${flaws.length} backward triangles`);
});

test('sphere: northern hemisphere with cap has no backward triangles (bottom cap winding)', () => {
  const m = generateSphere({
    radius: 1, segments: 16, rings: 8,
    latitudeStart: 0,
    cap: true,
  });
  const flaws = findWindingFlaws(m);
  assert.equal(flaws.length, 0, `${flaws.length} backward triangles`);
});

test('sphere: southern hemisphere with cap has no backward triangles (top cap winding)', () => {
  const m = generateSphere({
    radius: 1, segments: 16, rings: 8,
    latitudeEnd: 0,
    cap: true,
  });
  const flaws = findWindingFlaws(m);
  assert.equal(flaws.length, 0, `${flaws.length} backward triangles`);
});

test('sphere: equatorial band with both top and bottom caps', () => {
  const m = generateSphere({
    radius: 1, segments: 16, rings: 8,
    latitudeStart: -30 * Math.PI / 180,
    latitudeEnd: 30 * Math.PI / 180,
    cap: true,
  });
  const flaws = findWindingFlaws(m);
  assert.equal(flaws.length, 0, `${flaws.length} backward triangles`);
});

test('sphere: half-orange wedge with slice caps — no backward triangles', () => {
  // Longitude windowed → two slice caps should fill the open sides.
  const m = generateSphere({
    radius: 1, segments: 16, rings: 8,
    longitudeStart: 0,
    longitudeEnd: Math.PI,
    cap: true,
  });
  const flaws = findWindingFlaws(m);
  assert.equal(flaws.length, 0, `${flaws.length} backward triangles`);
});

test('sphere: wedge with both lat AND lon windowed → top, bottom, AND two slice caps all face out', () => {
  const m = generateSphere({
    radius: 1, segments: 16, rings: 8,
    latitudeStart: -45 * Math.PI / 180,
    latitudeEnd: 60 * Math.PI / 180,
    longitudeStart: 30 * Math.PI / 180,
    longitudeEnd: 200 * Math.PI / 180,
    cap: true,
  });
  const flaws = findWindingFlaws(m);
  assert.equal(flaws.length, 0, `${flaws.length} backward triangles`);
});

test('sphere: half-orange wedge generates two slice caps with outward normals roughly perpendicular to Y', () => {
  // For a wedge [0, π], the start slice plane is at θ=0 (the XZ
  // plane with Z<0 — outward is -Z) and the end slice plane is at
  // θ=π (outward is also -Z by the rotation convention). The
  // existence test here is: there must be at least some triangles
  // whose face normal is roughly horizontal (Y ≈ 0). Without slice
  // caps, only the spherical surface (whose normals vary in Y) and
  // ±Y top/bottom caps exist.
  const m = generateSphere({
    radius: 1, segments: 16, rings: 8,
    longitudeStart: 0, longitudeEnd: Math.PI,
    cap: true,
  });
  let horizontalCount = 0;
  for (let i = 0; i < m.normals.length; i += 3) {
    const ny = m.normals[i + 1]!;
    const nx = m.normals[i]!;
    const nz = m.normals[i + 2]!;
    if (Math.abs(ny) < 1e-3 && Math.hypot(nx, nz) > 0.99) horizontalCount++;
  }
  assert.ok(horizontalCount > 0, 'expected slice-cap vertices with Y≈0 normals');
});

// ─── Cylinder ─────────────────────────────────────────────────────

test('cylinder: full closed cylinder has no backward triangles', () => {
  const m = generateCylinder({ radius: 1, height: 1, segments: 16 });
  const flaws = findWindingFlaws(m);
  assert.equal(flaws.length, 0, `${flaws.length} backward triangles`);
});

test('cylinder: half-cylinder wedge — radial walls face out (no backward triangles)', () => {
  const m = generateCylinder({
    radius: 1, height: 1, segments: 16,
    angleStart: 0, angleEnd: Math.PI,
    cap: true,
  });
  const flaws = findWindingFlaws(m);
  assert.equal(flaws.length, 0, `${flaws.length} backward triangles`);
});

test('cylinder: quarter wedge — caps + walls face out', () => {
  const m = generateCylinder({
    radius: 1, height: 1, segments: 12,
    angleStart: Math.PI / 4, angleEnd: 3 * Math.PI / 4,
    cap: true,
  });
  const flaws = findWindingFlaws(m);
  assert.equal(flaws.length, 0, `${flaws.length} backward triangles`);
});

// ─── Cone ─────────────────────────────────────────────────────────

test('cone: full closed cone has no backward triangles', () => {
  const m = generateCone({ radius: 1, height: 1, segments: 16 });
  const flaws = findWindingFlaws(m);
  assert.equal(flaws.length, 0, `${flaws.length} backward triangles`);
});

test('cone: half-cone wedge — radial walls face out', () => {
  const m = generateCone({
    radius: 1, height: 1, segments: 16,
    angleStart: 0, angleEnd: Math.PI,
    cap: true,
  });
  const flaws = findWindingFlaws(m);
  assert.equal(flaws.length, 0, `${flaws.length} backward triangles`);
});

test('cone: quarter wedge — cap + walls face out', () => {
  const m = generateCone({
    radius: 1, height: 1, segments: 12,
    angleStart: Math.PI / 6, angleEnd: 2 * Math.PI / 3,
    cap: true,
  });
  const flaws = findWindingFlaws(m);
  assert.equal(flaws.length, 0, `${flaws.length} backward triangles`);
});
