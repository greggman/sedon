// path/spline consumes a PointCloud of control points (typically
// authored in core/point-list) and emits a resampled Catmull-Rom
// polyline as a Path. The interface pins:
//   • count = (n - 1) * samples_per_segment + 1 for n ≥ 2 controls
//   • count = 0 for fewer than 2 controls (downstream consumers
//     treat empty paths as no-ops)
//   • first sample ≈ first control point (the curve passes through
//     every control)
//   • last sample EQUALS the last control point (we pin it explicitly
//     to clean up floating-point drift)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathSplineNode } from '../../src/nodes/path-spline.js';
import type { PathValue, PointCloudValue } from '../../src/core/resources.js';
import type { NodeContext } from '../../src/core/node-def.js';

function pcOf(...points: [number, number, number][]): PointCloudValue {
  const positions = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    positions[i * 3 + 0] = points[i]![0];
    positions[i * 3 + 1] = points[i]![1];
    positions[i * 3 + 2] = points[i]![2];
  }
  return { positions, count: points.length };
}

function runSpline(
  points: PointCloudValue,
  width = 4,
  samplesPerSegment = 16,
): PathValue {
  const result = pathSplineNode.evaluate(
    {} as NodeContext,
    { points, width, samples_per_segment: samplesPerSegment },
  );
  return (result as { path: PathValue }).path;
}

test('path/spline emits empty polyline for fewer than 2 control points', () => {
  assert.equal(runSpline(pcOf()).count, 0);
  assert.equal(runSpline(pcOf([0, 0, 0])).count, 0);
});

test('path/spline preserves width regardless of point count', () => {
  assert.equal(runSpline(pcOf(), 7.5).width, 7.5);
  assert.equal(runSpline(pcOf([0, 0, 0], [1, 0, 0]), 7.5).width, 7.5);
});

test('path/spline sample count = (n-1) * samples_per_segment + 1', () => {
  const path = runSpline(pcOf([0, 0, 0], [10, 0, 0], [20, 0, 5]), 4, 8);
  // 2 segments × 8 + 1 closing sample = 17.
  assert.equal(path.count, 17);
  assert.equal(path.samples.length, 17 * 3);
});

test('path/spline passes through first and last control points', () => {
  const first: [number, number, number] = [-5, 0, -3];
  const last: [number, number, number] = [7, 0, 4];
  const path = runSpline(pcOf(first, [0, 0, 1], last), 4, 16);
  // First sample is exactly the first control (Catmull-Rom q(0) = p1).
  assert.ok(Math.abs(path.samples[0]! - first[0]) < 1e-5);
  assert.ok(Math.abs(path.samples[1]! - first[1]) < 1e-5);
  assert.ok(Math.abs(path.samples[2]! - first[2]) < 1e-5);
  // Last sample is pinned to the last control exactly.
  const o = (path.count - 1) * 3;
  assert.equal(path.samples[o + 0], last[0]);
  assert.equal(path.samples[o + 1], last[1]);
  assert.equal(path.samples[o + 2], last[2]);
});

test('path/spline two-point path produces straight-line samples', () => {
  // With only two controls, the reflection-extrapolated phantoms make
  // every interior sample lerp linearly between p1 and p2. Verify a
  // few midpoints.
  const path = runSpline(pcOf([0, 0, 0], [10, 0, 0]), 4, 4);
  // 1 segment × 4 + 1 closing = 5 samples.
  assert.equal(path.count, 5);
  // Sample at t=0.5 (index 2) should be at x=5.
  assert.ok(Math.abs(path.samples[2 * 3 + 0]! - 5) < 1e-5);
});
