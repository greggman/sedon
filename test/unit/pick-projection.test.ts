// The pick projection must map THIS pixel's tangent footprint to the
// full 1×1 NDC — that's what lets a normal scene render correctly into
// a 1-pixel target. Sanity-check the centre of three representative
// pixels (corner, dead-centre, off-centre) lands at NDC ~(0, 0) under
// the pick projection, while a neighbouring pixel's centre falls
// outside NDC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickProjection } from '../../src/render/mat4.js';

const FOV = (60 * Math.PI) / 180;
const NEAR = 0.1;
const FAR = 100;

// Apply a column-major Mat4 to a (vx, vy, vz, 1) view-space point.
function project(m: Float32Array, vx: number, vy: number, vz: number): { ndcX: number; ndcY: number } {
  const cx = m[0]! * vx + m[4]! * vy + m[8]!  * vz + m[12]!;
  const cy = m[1]! * vx + m[5]! * vy + m[9]!  * vz + m[13]!;
  const cw = m[3]! * vx + m[7]! * vy + m[11]! * vz + m[15]!;
  return { ndcX: cx / cw, ndcY: cy / cw };
}

// View-space ray through screen pixel centre on the near plane.
function pixelCenterRay(px: number, py: number, w: number, h: number): { vx: number; vy: number } {
  const tanHalf = Math.tan(FOV / 2);
  const aspect = w / h;
  const right = NEAR * tanHalf * aspect;
  const top = NEAR * tanHalf;
  const ndcX = (2 * (px + 0.5) / w) - 1;
  const ndcY = 1 - (2 * (py + 0.5) / h);
  return { vx: ndcX * right, vy: ndcY * top };
}

test('pick projection at the centre pixel maps that pixel\'s centre to NDC ~(0,0)', () => {
  const w = 800, h = 600;
  const px = 400, py = 300;
  const proj = pickProjection(FOV, w / h, NEAR, FAR, px, py, w, h);
  const ray = pixelCenterRay(px, py, w, h);
  const ndc = project(proj, ray.vx, ray.vy, -NEAR);
  assert.ok(Math.abs(ndc.ndcX) < 1e-5, `ndcX should be ~0, got ${ndc.ndcX}`);
  assert.ok(Math.abs(ndc.ndcY) < 1e-5, `ndcY should be ~0, got ${ndc.ndcY}`);
});

test('pick projection at a corner pixel still maps THAT pixel\'s centre to NDC ~(0,0)', () => {
  const w = 800, h = 600;
  const px = 0, py = 0; // top-left
  const proj = pickProjection(FOV, w / h, NEAR, FAR, px, py, w, h);
  const ray = pixelCenterRay(px, py, w, h);
  const ndc = project(proj, ray.vx, ray.vy, -NEAR);
  // Tolerance loosened from 1e-5: at the screen corner the pick frustum
  // is highly asymmetric and m[8]/m[9] (skew) accumulate one extra
  // float32 round-off worth of error vs the centred case.
  assert.ok(Math.abs(ndc.ndcX) < 1e-4, `ndcX at corner pixel = ${ndc.ndcX}`);
  assert.ok(Math.abs(ndc.ndcY) < 1e-4, `ndcY at corner pixel = ${ndc.ndcY}`);
});

test('the NEIGHBOURING pixel\'s centre falls outside NDC under the pick projection', () => {
  const w = 800, h = 600;
  const px = 400, py = 300;
  const proj = pickProjection(FOV, w / h, NEAR, FAR, px, py, w, h);
  // Neighbour to the right: should be clipped (|ndcX| > 1).
  const right = pixelCenterRay(px + 1, py, w, h);
  const ndcR = project(proj, right.vx, right.vy, -NEAR);
  assert.ok(Math.abs(ndcR.ndcX) > 1, `right neighbour should clip, got ndcX=${ndcR.ndcX}`);
  // Neighbour below.
  const down = pixelCenterRay(px, py + 1, w, h);
  const ndcD = project(proj, down.vx, down.vy, -NEAR);
  assert.ok(Math.abs(ndcD.ndcY) > 1, `down neighbour should clip, got ndcY=${ndcD.ndcY}`);
});

test('reverse-Z depth mapping is preserved (zNear → 1, zFar → 0)', () => {
  const proj = pickProjection(FOV, 1.5, NEAR, FAR, 0, 0, 100, 100);
  // A point ON the near plane (view.z = -NEAR) → NDC z = 1 under reverse-Z.
  // (Use the centre ray of pixel (0, 0) so it survives clipping.)
  const ray = pixelCenterRay(0, 0, 100, 100);
  const m = proj;
  const cz = m[2]! * ray.vx + m[6]! * ray.vy + m[10]! * (-NEAR) + m[14]!;
  const cw = m[3]! * ray.vx + m[7]! * ray.vy + m[11]! * (-NEAR) + m[15]!;
  const ndcZNear = cz / cw;
  assert.ok(Math.abs(ndcZNear - 1) < 1e-5, `near should map to NDC z=1, got ${ndcZNear}`);
  // Far plane → 0.
  const czFar = m[2]! * ray.vx * (FAR / NEAR) + m[6]! * ray.vy * (FAR / NEAR) + m[10]! * (-FAR) + m[14]!;
  const cwFar = m[3]! * ray.vx * (FAR / NEAR) + m[7]! * ray.vy * (FAR / NEAR) + m[11]! * (-FAR) + m[15]!;
  const ndcZFar = czFar / cwFar;
  assert.ok(Math.abs(ndcZFar) < 1e-5, `far should map to NDC z=0, got ${ndcZFar}`);
});
