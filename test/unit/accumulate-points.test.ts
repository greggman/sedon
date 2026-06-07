// Pin the cumulative-packing primitives — accumulate-float-cloud and
// points-along-axis. Both are pure CPU so they run without a device.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accumulateFloatCloudNode } from '../../src/nodes/accumulate-float-cloud.js';
import { pointsAlongAxisNode } from '../../src/nodes/points-along-axis.js';
import { vec3CloudFromFloatsNode } from '../../src/nodes/vec3-cloud-from-floats.js';
import type {
  FloatCloudValue,
  PointCloudValue,
  Vec3CloudValue,
} from '../../src/core/resources.js';

function makeCloud(values: number[]): FloatCloudValue {
  return { values: new Float32Array(values), count: values.length };
}

function near(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) < eps;
}

// ===== accumulate-float-cloud =======================================

test('accumulate inclusive: out[i] = sum 0..i', () => {
  const { values } = accumulateFloatCloudNode.evaluate({}, {
    values: makeCloud([1, 2, 3, 4]),
    mode: 0,
  }) as { values: FloatCloudValue };
  assert.equal(values.count, 4);
  assert.deepEqual(Array.from(values.values), [1, 3, 6, 10]);
});

test('accumulate exclusive: out[0] = 0, out[i] = sum 0..i-1', () => {
  const { values } = accumulateFloatCloudNode.evaluate({}, {
    values: makeCloud([1, 2, 3, 4]),
    mode: 1,
  }) as { values: FloatCloudValue };
  assert.deepEqual(Array.from(values.values), [0, 1, 3, 6]);
});

test('accumulate centers: out[i] = exclusive[i] + in[i] / 2 (variable-width packing)', () => {
  const { values } = accumulateFloatCloudNode.evaluate({}, {
    values: makeCloud([2, 4, 6]),
    mode: 2,
  }) as { values: FloatCloudValue };
  // First item width 2 → centre at 1. Second width 4 → centre at 2+2=4. Third width 6 → centre at 2+4+3=9.
  assert.deepEqual(Array.from(values.values), [1, 4, 9]);
});

test('accumulate: empty input → empty output (no crash)', () => {
  const { values } = accumulateFloatCloudNode.evaluate({}, {
    values: makeCloud([]),
    mode: 2,
  }) as { values: FloatCloudValue };
  assert.equal(values.count, 0);
});

test('accumulate: invalid mode clamps to 0 / 2 instead of throwing', () => {
  const out1 = accumulateFloatCloudNode.evaluate({}, {
    values: makeCloud([1, 1, 1]),
    mode: -5,
  }) as { values: FloatCloudValue };
  assert.deepEqual(Array.from(out1.values.values), [1, 2, 3]); // clamped to 0 = inclusive
  const out2 = accumulateFloatCloudNode.evaluate({}, {
    values: makeCloud([1, 1, 1]),
    mode: 99,
  }) as { values: FloatCloudValue };
  assert.deepEqual(Array.from(out2.values.values), [0.5, 1.5, 2.5]); // clamped to 2 = centers
});

// ===== points-along-axis ============================================

test('points-along-axis: offsets become positions along the axis from the origin', () => {
  const { points } = pointsAlongAxisNode.evaluate({}, {
    origin: [10, 0, 0],
    axis: [1, 0, 0],
    offsets: makeCloud([0, 1, 2]),
  }) as { points: PointCloudValue };
  assert.equal(points.count, 3);
  assert.equal(points.positions[0], 10);
  assert.equal(points.positions[3], 11);
  assert.equal(points.positions[6], 12);
  // y, z unchanged from origin.
  for (let i = 0; i < 3; i++) {
    assert.equal(points.positions[i * 3 + 1], 0);
    assert.equal(points.positions[i * 3 + 2], 0);
  }
});

test('points-along-axis: arbitrary axis scales the offsets directionally', () => {
  const { points } = pointsAlongAxisNode.evaluate({}, {
    origin: [0, 0, 0],
    axis: [0, 0, 2],
    offsets: makeCloud([0.5, 1.5]),
  }) as { points: PointCloudValue };
  // point 0: (0, 0, 2*0.5) = (0, 0, 1).
  assert.ok(near(points.positions[2]!, 1));
  // point 1: (0, 0, 2*1.5) = (0, 0, 3).
  assert.ok(near(points.positions[5]!, 3));
});

test('points-along-axis: normals are world-up so downstream align stays predictable', () => {
  const { points } = pointsAlongAxisNode.evaluate({}, {
    origin: [0, 0, 0],
    axis: [1, 0, 0],
    offsets: makeCloud([0, 1]),
  }) as { points: PointCloudValue };
  assert.equal(points.normals![1], 1);
  assert.equal(points.normals![4], 1);
});

// ===== integration: cumulative packing end-to-end ===================

// ===== vec3-cloud-from-floats =======================================

test('vec3-cloud-from-floats: zips three FloatClouds into one Vec3Cloud', () => {
  const { values } = vec3CloudFromFloatsNode.evaluate({}, {
    x: makeCloud([1, 4, 7]),
    y: makeCloud([2, 5, 8]),
    z: makeCloud([3, 6, 9]),
  }) as { values: Vec3CloudValue };
  assert.equal(values.count, 3);
  assert.deepEqual(Array.from(values.values), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('vec3-cloud-from-floats: mismatched counts throw with a clear message', () => {
  assert.throws(
    () => vec3CloudFromFloatsNode.evaluate({}, {
      x: makeCloud([1, 2]),
      y: makeCloud([1]),
      z: makeCloud([1, 2]),
    }),
    /must share the same count/,
  );
});

// ===== integration: cumulative packing end-to-end ===================

test('integration: widths → centers → positions matches hand-computed centres', () => {
  // Three boxes of widths 0.5, 0.3, 0.7. Packed tip-to-tail along X
  // starting at x=0. Expected centres: 0.25, 0.65, 1.15.
  const widths = makeCloud([0.5, 0.3, 0.7]);
  const { values: centers } = accumulateFloatCloudNode.evaluate({}, {
    values: widths,
    mode: 2,
  }) as { values: FloatCloudValue };
  const { points } = pointsAlongAxisNode.evaluate({}, {
    origin: [0, 0, 0],
    axis: [1, 0, 0],
    offsets: centers,
  }) as { points: PointCloudValue };
  assert.ok(near(points.positions[0]!, 0.25));
  assert.ok(near(points.positions[3]!, 0.65));
  assert.ok(near(points.positions[6]!, 1.15));
});
