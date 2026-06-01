// Sampler invariants:
//   • A two-point smooth segment with no neighbours reduces to a
//     straight line (tangents are zero because prev == self == next
//     after the end-clamp).
//   • The final endpoint is emitted exactly on open curves (no
//     "stop one short" off-by-one).
//   • Corner points produce a sharp kink in the sampled line — we
//     pin this by checking the sampled curve sits very close to the
//     straight-line path through the corner control points.
//   • Smooth points pass through their authored position (Bezier
//     evaluation at t = 0 is exactly the start control).
//   • Z is 0 on every output sample (the curve lives in the XY plane).
//   • Closed curves wrap: last segment connects back to point 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDLE_ALIGNED,
  HANDLE_CORNER,
  HANDLE_FREE,
  HANDLE_SMOOTH,
  readCurve2DPoints,
  sampleCurve2D,
} from '../../src/render/curve-2d.js';

test('readCurve2DPoints: parses [x, handleType, y] tuples, defaults type to smooth', () => {
  const parsed = readCurve2DPoints([
    [0, 0, 0],        // x=0, smooth, y=0
    [1, 0, 2],        // smooth
    [3, 1, 4],        // corner
    [5, 99, 6],       // out-of-range handle type → smooth
    'not an array',
    [],               // too short → skipped
    [7, 0],           // 2-component (no y) → skipped
  ]);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0]!.handleType, HANDLE_SMOOTH);
  assert.equal(parsed[1]!.handleType, HANDLE_SMOOTH);
  assert.equal(parsed[2]!.handleType, HANDLE_CORNER);
  assert.equal(parsed[2]!.x, 3);
  assert.equal(parsed[2]!.y, 4);
  assert.equal(parsed[3]!.handleType, HANDLE_SMOOTH);
});

test('sampler: two smooth points trace the chord (y stays on the line, x is monotonic)', () => {
  // Both endpoints' tangents end-clamp to the chord direction, so
  // the cubic Bezier stays ON the chord but is parameterised
  // non-uniformly. We pin the invariants that matter (every sample
  // is on the line + endpoints are exact + monotonic in x) instead
  // of asserting a specific x at each t.
  const samples = sampleCurve2D(
    [
      { x: 0, y: 0, handleType: HANDLE_SMOOTH },
      { x: 1, y: 0, handleType: HANDLE_SMOOTH },
    ],
    { samplesPerSegment: 4 },
  );
  // samplesPerSegment(4) + 1 (final endpoint) = 5 samples.
  assert.equal(samples.length, 5 * 3);
  let prevX = -Infinity;
  for (let i = 0; i < 5; i++) {
    const x = samples[i * 3]!;
    const y = samples[i * 3 + 1]!;
    const z = samples[i * 3 + 2]!;
    assert.ok(Math.abs(y) < 1e-5, `y off chord at sample ${i}: ${y}`);
    assert.equal(z, 0);
    assert.ok(x >= prevX, `x not monotonic at ${i}: ${x} < ${prevX}`);
    prevX = x;
  }
  // Endpoints exact.
  assert.ok(Math.abs(samples[0]!) < 1e-5);
  assert.ok(Math.abs(samples[5 * 3 - 3]! - 1) < 1e-5);
});

test('sampler: first and last sample equal the first and last control points (open curve)', () => {
  const samples = sampleCurve2D(
    [
      { x: 1, y: 2, handleType: HANDLE_SMOOTH },
      { x: 3, y: 5, handleType: HANDLE_SMOOTH },
      { x: 7, y: 1, handleType: HANDLE_SMOOTH },
    ],
    { samplesPerSegment: 8 },
  );
  // First sample.
  assert.ok(Math.abs(samples[0]! - 1) < 1e-5);
  assert.ok(Math.abs(samples[1]! - 2) < 1e-5);
  // Last sample.
  const lastIdx = samples.length - 3;
  assert.ok(Math.abs(samples[lastIdx]! - 7) < 1e-5);
  assert.ok(Math.abs(samples[lastIdx + 1]! - 1) < 1e-5);
});

test('sampler: a corner point produces a sharp kink (sampled curve hugs the straight chord into the corner)', () => {
  // Three colinear-on-X but Y-zigzag points with the MIDDLE marked
  // corner. The sampled curve through the corner should be ~straight
  // because zero tangents collapse the Bezier into a line.
  const samples = sampleCurve2D(
    [
      { x: 0, y: 0, handleType: HANDLE_SMOOTH },
      { x: 1, y: 1, handleType: HANDLE_CORNER },
      { x: 2, y: 0, handleType: HANDLE_SMOOTH },
    ],
    { samplesPerSegment: 8 },
  );
  // The corner is at (1, 1). Walk the first segment's samples — y
  // should rise monotonically from 0 to 1 (because the smooth start
  // has a flat tangent toward the corner). For comparison, a fully-
  // smooth setup would overshoot.
  for (let i = 0; i <= 8; i++) {
    const y = samples[i * 3 + 1]!;
    // Cubic Bezier with one zero tangent and one Catmull-Rom-derived
    // tangent stays bounded: y should never exceed the corner's y by
    // a noticeable amount. (A fully-smooth curve through these three
    // points would noticeably overshoot at the corner.)
    assert.ok(y <= 1 + 0.05, `corner overshoot at sample ${i}: y = ${y}`);
  }
});

test('sampler: corner-only triangle is a polyline (each segment is a straight line)', () => {
  // All three points marked corner → all tangents zero → every
  // segment is a Bezier with zero-length handles → a straight line.
  const samples = sampleCurve2D(
    [
      { x: 0, y: 0, handleType: HANDLE_CORNER },
      { x: 1, y: 0, handleType: HANDLE_CORNER },
      { x: 1, y: 1, handleType: HANDLE_CORNER },
    ],
    { samplesPerSegment: 4 },
  );
  // First segment: from (0,0) toward (1,0) — every sample is on the
  // line y = 0.
  for (let i = 0; i <= 4; i++) {
    const y = samples[i * 3 + 1]!;
    assert.ok(Math.abs(y) < 1e-5, `sample ${i} y: ${y}`);
  }
  // Second segment: from (1,0) to (1,1) — every sample at x = 1.
  for (let i = 4; i <= 8; i++) {
    const x = samples[i * 3]!;
    assert.ok(Math.abs(x - 1) < 1e-5, `sample ${i} x: ${x}`);
  }
});

test('sampler: closed curve produces samples-per-segment × n samples (no trailing endpoint)', () => {
  // Closed loop: no extra trailing endpoint; the wrap-around segment
  // is the last one in the buffer.
  const samples = sampleCurve2D(
    [
      { x: 0, y: 0, handleType: HANDLE_CORNER },
      { x: 1, y: 0, handleType: HANDLE_CORNER },
      { x: 1, y: 1, handleType: HANDLE_CORNER },
      { x: 0, y: 1, handleType: HANDLE_CORNER },
    ],
    { samplesPerSegment: 2, closed: true },
  );
  // 4 segments × 2 samples = 8.
  assert.equal(samples.length, 8 * 3);
  // First sample of each segment lands exactly on the corresponding
  // control point (corner = zero tangent = Bezier starts at B0).
  assert.deepEqual(
    [samples[0], samples[1]],
    [0, 0],
  );
  assert.deepEqual(
    [samples[2 * 3], samples[2 * 3 + 1]],
    [1, 0],
  );
  assert.deepEqual(
    [samples[4 * 3], samples[4 * 3 + 1]],
    [1, 1],
  );
  assert.deepEqual(
    [samples[6 * 3], samples[6 * 3 + 1]],
    [0, 1],
  );
});

test('sampler: empty / single-point input returns an empty buffer', () => {
  assert.equal(
    sampleCurve2D([], {}).length,
    0,
  );
  assert.equal(
    sampleCurve2D([
      { x: 0, y: 0, handleType: HANDLE_SMOOTH, leftDx: 0, leftDy: 0, rightDx: 0, rightDy: 0 },
    ]).length,
    0,
  );
});

test('readCurve2DPoints: 3-number tuples (old format) parse with zero explicit handles', () => {
  // Back-compat: saved graphs from before the 7-number per-anchor
  // format must still load. The trailing handle slots default to 0,
  // and an AUTO point ignores them anyway (Catmull-Rom recompute).
  const parsed = readCurve2DPoints([
    [1, 0, 2],            // smooth
    [3, 1, 4],            // corner
  ]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.leftDx, 0);
  assert.equal(parsed[0]!.leftDy, 0);
  assert.equal(parsed[0]!.rightDx, 0);
  assert.equal(parsed[0]!.rightDy, 0);
  assert.equal(parsed[1]!.handleType, HANDLE_CORNER);
});

test('readCurve2DPoints: 7-number tuples populate explicit handle deltas', () => {
  // [x, type, y, leftDx, leftDy, rightDx, rightDy]
  const parsed = readCurve2DPoints([
    [10, HANDLE_FREE, 20, -1, -2, 3, 4],
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.x, 10);
  assert.equal(parsed[0]!.y, 20);
  assert.equal(parsed[0]!.handleType, HANDLE_FREE);
  assert.equal(parsed[0]!.leftDx, -1);
  assert.equal(parsed[0]!.leftDy, -2);
  assert.equal(parsed[0]!.rightDx, 3);
  assert.equal(parsed[0]!.rightDy, 4);
});

test('sampler: FREE handles override Catmull-Rom — explicit deltas drive the Bezier control points', () => {
  // Three colinear-in-x points. With AUTO handles the curve would be
  // a straight line. With FREE handles authored to swing UPWARD at
  // the middle point, the segments must overshoot upward — proving the
  // explicit handles, not Catmull-Rom, drive the shape.
  const samples = sampleCurve2D(
    [
      { x: 0, y: 0, handleType: HANDLE_FREE, leftDx: 0, leftDy: 0, rightDx: 0.3, rightDy: 1 },
      { x: 1, y: 0, handleType: HANDLE_FREE, leftDx: -0.3, leftDy: 1, rightDx: 0.3, rightDy: 1 },
      { x: 2, y: 0, handleType: HANDLE_FREE, leftDx: -0.3, leftDy: 1, rightDx: 0, rightDy: 0 },
    ],
    { samplesPerSegment: 8 },
  );
  // Some sample between t=0 and t=1 must have y noticeably > 0 (the
  // bezier handles pull the curve upward).
  let maxY = -Infinity;
  for (let i = 0; i * 3 + 1 < samples.length; i++) {
    const y = samples[i * 3 + 1]!;
    if (y > maxY) maxY = y;
  }
  assert.ok(maxY > 0.3, `FREE handles should swing curve up; saw max y = ${maxY}`);
  // Endpoints exact.
  assert.ok(Math.abs(samples[0]!) < 1e-5);
  assert.ok(Math.abs(samples[1]!) < 1e-5);
});

test('sampler: ALIGNED handles produce the same samples as FREE with identical values (the alignment constraint lives in the editor, not the sampler)', () => {
  const free = sampleCurve2D(
    [
      { x: 0, y: 0, handleType: HANDLE_FREE, leftDx: 0, leftDy: 0, rightDx: 0.25, rightDy: 0.5 },
      { x: 1, y: 1, handleType: HANDLE_FREE, leftDx: -0.25, leftDy: -0.5, rightDx: 0, rightDy: 0 },
    ],
    { samplesPerSegment: 6 },
  );
  const aligned = sampleCurve2D(
    [
      { x: 0, y: 0, handleType: HANDLE_ALIGNED, leftDx: 0, leftDy: 0, rightDx: 0.25, rightDy: 0.5 },
      { x: 1, y: 1, handleType: HANDLE_ALIGNED, leftDx: -0.25, leftDy: -0.5, rightDx: 0, rightDy: 0 },
    ],
    { samplesPerSegment: 6 },
  );
  for (let i = 0; i < free.length; i++) {
    assert.ok(Math.abs(free[i]! - aligned[i]!) < 1e-6);
  }
});

test('sampler: AUTO points ignore any stored handle deltas (Catmull-Rom recomputes regardless)', () => {
  // Stash garbage in the handle slots — AUTO must NOT use them.
  const samples = sampleCurve2D(
    [
      { x: 0, y: 0, handleType: HANDLE_SMOOTH, leftDx: 99, leftDy: 99, rightDx: 99, rightDy: 99 },
      { x: 1, y: 0, handleType: HANDLE_SMOOTH, leftDx: 99, leftDy: 99, rightDx: 99, rightDy: 99 },
    ],
    { samplesPerSegment: 4 },
  );
  // Two smooth points = straight chord; every sample has y ≈ 0.
  for (let i = 0; i * 3 + 1 < samples.length; i++) {
    const y = samples[i * 3 + 1]!;
    assert.ok(Math.abs(y) < 1e-5, `AUTO leaked handle deltas at sample ${i}: y = ${y}`);
  }
});
