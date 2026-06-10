// `points/transform` applies one TRS to every position in a
// PointCloud, with matching rotation + inverse-transpose-then-
// renormalize on normals and tangents.
//
// Tests are pure CPU — no GPU device. Same convention the equivalent
// transform-mesh tests use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformPointsNode } from '../../src/nodes/transform-points.js';
import type { PointCloudValue } from '../../src/core/resources.js';

function evalNode(input: PointCloudValue, opts: {
  translate?: [number, number, number];
  rotate?: [number, number, number];
  scale?: [number, number, number];
}): PointCloudValue {
  // ctx isn't used in this evaluate; pass an empty object that satisfies
  // the structural type the function uses.
  const ctx = {} as unknown as Parameters<typeof transformPointsNode.evaluate>[0];
  const result = transformPointsNode.evaluate!(ctx, {
    points: input,
    translate: opts.translate ?? [0, 0, 0],
    rotate: opts.rotate ?? [0, 0, 0],
    scale: opts.scale ?? [1, 1, 1],
  }) as { points: PointCloudValue };
  return result.points;
}

function closeTo(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

function pointCloud(positions: number[], opts: { normals?: number[]; tangents?: number[] } = {}): PointCloudValue {
  const v: PointCloudValue = {
    positions: new Float32Array(positions),
    count: positions.length / 3,
  };
  if (opts.normals) v.normals = new Float32Array(opts.normals);
  if (opts.tangents) v.tangents = new Float32Array(opts.tangents);
  return v;
}

test('identity transform leaves positions / normals / tangents unchanged', () => {
  const input = pointCloud(
    [1, 2, 3, 4, 5, 6],
    { normals: [0, 1, 0, 0, 1, 0], tangents: [1, 0, 0, 1, 0, 0] },
  );
  const out = evalNode(input, {});
  assert.deepEqual([...out.positions], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...out.normals!], [0, 1, 0, 0, 1, 0]);
  assert.deepEqual([...out.tangents!], [1, 0, 0, 1, 0, 0]);
  assert.equal(out.count, 2);
});

test('translate-only: each position shifts by the offset, directions untouched', () => {
  const input = pointCloud(
    [0, 0, 0, 1, 0, 0],
    { normals: [0, 1, 0, 0, 1, 0], tangents: [1, 0, 0, 1, 0, 0] },
  );
  const out = evalNode(input, { translate: [10, 20, 30] });
  assert.deepEqual([...out.positions], [10, 20, 30, 11, 20, 30]);
  // Direction vectors must not pick up the translation column.
  assert.deepEqual([...out.normals!], [0, 1, 0, 0, 1, 0]);
  assert.deepEqual([...out.tangents!], [1, 0, 0, 1, 0, 0]);
});

test('uniform scale: positions scale; normals/tangents stay unit length and unchanged in direction', () => {
  const input = pointCloud(
    [1, 0, 0, 0, 1, 0],
    { normals: [0, 1, 0, 1, 0, 0], tangents: [1, 0, 0, 0, 0, 1] },
  );
  const out = evalNode(input, { scale: [3, 3, 3] });
  assert.deepEqual([...out.positions], [3, 0, 0, 0, 3, 0]);
  // Uniform scale: divide-by-s then renormalise gives the same unit direction.
  assert.deepEqual([...out.normals!], [0, 1, 0, 1, 0, 0]);
  assert.deepEqual([...out.tangents!], [1, 0, 0, 0, 0, 1]);
});

test('non-uniform scale: directions get inverse-transpose treatment', () => {
  // A normal pointing along +X (1,0,0) under a scale of [2,1,1] should
  // stay (1,0,0). Under [1,2,1] it should also stay (1,0,0) since the
  // x-component is unaffected and the y/z are zero. The interesting
  // case: an oblique normal (1,1,0) under non-uniform scale must skew.
  const input = pointCloud([0, 0, 0], { normals: [1, 1, 0] });
  const out = evalNode(input, { scale: [2, 1, 1] });
  // Inverse-transpose for diagonal scale: divide each component by its
  // axis scale, then renormalize. (1/2, 1/1, 0/1) = (0.5, 1, 0), norm √1.25.
  const norm = Math.hypot(0.5, 1, 0);
  assert.ok(closeTo(out.normals![0]!, 0.5 / norm), 'nx ≈ 0.5/√1.25');
  assert.ok(closeTo(out.normals![1]!, 1.0 / norm), 'ny ≈ 1.0/√1.25');
  assert.ok(closeTo(out.normals![2]!, 0));
});

test('90° Y rotation: +X maps to +Z (matches mat4.rotationY sign convention)', () => {
  // The renderer's mat4.rotationY: +π/2 sends (1, 0, 0) → (0, 0, +1).
  // Same convention as geom/transform — the transform-mesh tests pin
  // this elsewhere. Positions, normals, and tangents all follow it.
  const input = pointCloud([1, 0, 0], { normals: [1, 0, 0], tangents: [0, 0, 1] });
  const out = evalNode(input, { rotate: [0, Math.PI / 2, 0] });
  assert.ok(closeTo(out.positions[0]!, 0), `x ≈ 0 (got ${out.positions[0]})`);
  assert.ok(closeTo(out.positions[1]!, 0));
  assert.ok(closeTo(out.positions[2]!, 1), `z ≈ 1 (got ${out.positions[2]})`);
  assert.ok(closeTo(out.normals![0]!, 0));
  assert.ok(closeTo(out.normals![2]!, 1));
  // Tangent (0,0,1) rotated by +π/2 around Y → (-1, 0, 0).
  assert.ok(closeTo(out.tangents![0]!, -1));
  assert.ok(closeTo(out.tangents![2]!, 0));
});

test('output omits normals / tangents when input didn\'t carry them', () => {
  const input = pointCloud([0, 0, 0]);
  const out = evalNode(input, { translate: [1, 0, 0] });
  assert.equal(out.normals, undefined, 'no input normals → no output normals');
  assert.equal(out.tangents, undefined, 'no input tangents → no output tangents');
});

test('count is preserved', () => {
  const input = pointCloud([0, 0, 0, 1, 0, 0, 2, 0, 0]);
  const out = evalNode(input, { translate: [5, 5, 5] });
  assert.equal(out.count, 3);
});

test('node is registered and findable by id', async () => {
  const { createCoreNodeRegistry } = await import('../../src/nodes/index.js');
  const r = createCoreNodeRegistry();
  const def = r.get('points/transform');
  assert.ok(def, 'points/transform must be in the core registry');
  assert.equal(def?.outputs[0]?.type, 'PointCloud');
});
