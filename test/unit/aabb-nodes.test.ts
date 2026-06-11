// Bounding-box measurement nodes — `points/aabb`, `geom/aabb`,
// `scene/aabb` — plus the Vec3 → (x, y, z) splitter `math/floats-
// from-vec3`. All four are pure-CPU, no GPU device required.
//
// The points and geom variants share `computeAabb`; tests cover the
// shared math via points (single Float32Array of positions). The
// scene variant has its own per-entity-transform path, tested
// separately.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAabb, pointsAabbNode } from '../../src/nodes/points-aabb.js';
import { geomAabbNode } from '../../src/nodes/geom-aabb.js';
import { sceneAabbNode } from '../../src/nodes/scene-aabb.js';
import { floatsFromVec3Node } from '../../src/nodes/floats-from-vec3.js';
import type {
  GeometryValue,
  SceneEntity,
  SceneValue,
} from '../../src/core/resources.js';

const ctx = {} as unknown as Parameters<typeof pointsAabbNode.evaluate>[0];

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

// ─── computeAabb (shared by points + geom) ────────────────────────

test('computeAabb: single point — min == max == centre == point, size = 0', () => {
  const r = computeAabb(new Float32Array([3, 7, 11]), 1);
  assert.deepEqual(r.min, [3, 7, 11]);
  assert.deepEqual(r.max, [3, 7, 11]);
  assert.deepEqual(r.centre, [3, 7, 11]);
  assert.deepEqual(r.size, [0, 0, 0]);
});

test('computeAabb: two opposite-corner points', () => {
  const r = computeAabb(new Float32Array([-1, -2, -3, 5, 4, 3]), 2);
  assert.deepEqual(r.min, [-1, -2, -3]);
  assert.deepEqual(r.max, [5, 4, 3]);
  assert.deepEqual(r.centre, [2, 1, 0]);
  assert.deepEqual(r.size, [6, 6, 6]);
});

test('computeAabb: empty input → all zeros (no NaNs, no Infinity)', () => {
  const r = computeAabb(undefined, 0);
  assert.deepEqual(r.min, [0, 0, 0]);
  assert.deepEqual(r.max, [0, 0, 0]);
  assert.deepEqual(r.centre, [0, 0, 0]);
  assert.deepEqual(r.size, [0, 0, 0]);
});

test('computeAabb: count caps the sweep — extra trailing data is ignored', () => {
  // Useful when an upstream allocates more capacity than count
  // currently uses; we walk only `count * 3` floats.
  const positions = new Float32Array([0, 0, 0, 5, 5, 5, 99, 99, 99]);
  const r = computeAabb(positions, 2); // only first two points
  assert.deepEqual(r.max, [5, 5, 5]);
});

// ─── points/aabb node ─────────────────────────────────────────────

test('points/aabb: 4 corners of a unit square at Y=0 → expected min/max/centre/size', () => {
  const r = pointsAabbNode.evaluate!(ctx, {
    points: {
      positions: new Float32Array([
        0, 0, 0,
        1, 0, 0,
        1, 0, 1,
        0, 0, 1,
      ]),
      count: 4,
    },
  }) as { min: number[]; max: number[]; centre: number[]; size: number[] };
  assert.deepEqual(r.min, [0, 0, 0]);
  assert.deepEqual(r.max, [1, 0, 1]);
  assert.deepEqual(r.centre, [0.5, 0, 0.5]);
  assert.deepEqual(r.size, [1, 0, 1]);
});

test('points/aabb: undefined input → all-zero AABB', () => {
  const r = pointsAabbNode.evaluate!(ctx, { points: undefined }) as { size: number[] };
  assert.deepEqual(r.size, [0, 0, 0]);
});

// ─── geom/aabb node ───────────────────────────────────────────────

test('geom/aabb: cube mesh (centre-at-origin) → centre = [0,0,0], size = full extent', () => {
  // Hand-built 2-unit cube — positions span [-1, +1] on every axis.
  const positions = new Float32Array([
    -1, -1, -1,  1, -1, -1,  1, 1, -1, -1, 1, -1,
    -1, -1,  1,  1, -1,  1,  1, 1,  1, -1, 1,  1,
  ]);
  const geom: GeometryValue = {
    mesh: { positions, normals: new Float32Array(0), uvs: new Float32Array(0), indices: new Uint32Array(0) },
  } as GeometryValue;
  const r = geomAabbNode.evaluate!(ctx, { geometry: geom }) as { min: number[]; max: number[]; centre: number[]; size: number[] };
  assert.deepEqual(r.min, [-1, -1, -1]);
  assert.deepEqual(r.max, [1, 1, 1]);
  assert.deepEqual(r.centre, [0, 0, 0]);
  assert.deepEqual(r.size, [2, 2, 2]);
});

test('geom/aabb: no CPU mesh → all-zero AABB (fail-soft for GPU-only geometry)', () => {
  const geom: GeometryValue = {} as GeometryValue; // no `mesh` field
  const r = geomAabbNode.evaluate!(ctx, { geometry: geom }) as { size: number[] };
  assert.deepEqual(r.size, [0, 0, 0]);
});

// ─── scene/aabb node ──────────────────────────────────────────────

// Build a 4×4 column-major translation matrix (no rotation, no scale).
function translation(tx: number, ty: number, tz: number): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  m[12] = tx; m[13] = ty; m[14] = tz;
  return m;
}

// Build a 4×4 column-major scale matrix.
function scale(sx: number, sy: number, sz: number): Float32Array {
  const m = new Float32Array(16);
  m[0] = sx; m[5] = sy; m[10] = sz; m[15] = 1;
  return m;
}

function entity(positions: Float32Array, transform: Float32Array): SceneEntity {
  return {
    geometry: {
      mesh: { positions, normals: new Float32Array(0), uvs: new Float32Array(0), indices: new Uint32Array(0) },
    } as GeometryValue,
    material: {} as never,
    transform,
    tint: new Float32Array([1, 1, 1, 1]),
  };
}

test('scene/aabb: empty scene → all-zero AABB', () => {
  const scene: SceneValue = { entities: [] };
  const r = sceneAabbNode.evaluate!(ctx, { scene }) as { size: number[] };
  assert.deepEqual(r.size, [0, 0, 0]);
});

test('scene/aabb: single translated unit cube → AABB shifts by the translation', () => {
  // Unit cube positions [-1, 1]^3, translated to (+10, +20, +30).
  const positions = new Float32Array([
    -1, -1, -1,  1, 1, 1, // two opposite corners suffice for AABB
  ]);
  const scene: SceneValue = { entities: [entity(positions, translation(10, 20, 30))] };
  const r = sceneAabbNode.evaluate!(ctx, { scene }) as { min: number[]; max: number[] };
  assert.deepEqual(r.min, [9, 19, 29]);
  assert.deepEqual(r.max, [11, 21, 31]);
});

test('scene/aabb: scaled cube → world AABB scales accordingly', () => {
  // Unit cube [-1, +1]^3 with 3× scale on X, 2× on Y, 1× on Z.
  const positions = new Float32Array([-1, -1, -1, 1, 1, 1]);
  const scene: SceneValue = { entities: [entity(positions, scale(3, 2, 1))] };
  const r = sceneAabbNode.evaluate!(ctx, { scene }) as { size: number[] };
  // Size doubles per-axis from the cube's [-1,1] → [-s, +s] = 2s wide.
  assert.ok(approx(r.size[0]!, 6));
  assert.ok(approx(r.size[1]!, 4));
  assert.ok(approx(r.size[2]!, 2));
});

test('scene/aabb: multiple entities → union of all transformed bounds', () => {
  // Entity A: cube at origin, [-1, 1]. Entity B: cube translated to (5, 5, 5).
  const positions = new Float32Array([-1, -1, -1, 1, 1, 1]);
  const scene: SceneValue = {
    entities: [
      entity(positions, translation(0, 0, 0)),
      entity(positions, translation(5, 5, 5)),
    ],
  };
  const r = sceneAabbNode.evaluate!(ctx, { scene }) as { min: number[]; max: number[]; centre: number[]; size: number[] };
  assert.deepEqual(r.min, [-1, -1, -1]);
  assert.deepEqual(r.max, [6, 6, 6]);
  assert.deepEqual(r.centre, [2.5, 2.5, 2.5]);
  assert.deepEqual(r.size, [7, 7, 7]);
});

test('scene/aabb: entity without CPU mesh is silently skipped', () => {
  const positions = new Float32Array([0, 0, 0, 1, 1, 1]);
  const scene: SceneValue = {
    entities: [
      entity(positions, translation(0, 0, 0)),
      { ...entity(positions, translation(99, 99, 99)), geometry: {} as GeometryValue },
    ],
  };
  const r = sceneAabbNode.evaluate!(ctx, { scene }) as { max: number[] };
  // The second entity should NOT contribute its (99, 99, 99) extent.
  assert.deepEqual(r.max, [1, 1, 1]);
});

// ─── math/floats-from-vec3 node ───────────────────────────────────

test('math/floats-from-vec3: round-trips a Vec3 to (x, y, z)', () => {
  const r = floatsFromVec3Node.evaluate!(ctx, { value: [3, 7, 11] }) as { x: number; y: number; z: number };
  assert.equal(r.x, 3);
  assert.equal(r.y, 7);
  assert.equal(r.z, 11);
});

test('math/floats-from-vec3: undefined input → zeros', () => {
  const r = floatsFromVec3Node.evaluate!(ctx, { value: undefined as never }) as { x: number; y: number; z: number };
  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
  assert.equal(r.z, 0);
});

// ─── Registry presence ────────────────────────────────────────────

test('All four new nodes are registered in createCoreNodeRegistry', async () => {
  const { createCoreNodeRegistry } = await import('../../src/nodes/index.js');
  const reg = createCoreNodeRegistry();
  for (const id of ['points/aabb', 'geom/aabb', 'scene/aabb', 'math/floats-from-vec3']) {
    assert.ok(reg.get(id), `${id} must be in the core registry`);
  }
});
