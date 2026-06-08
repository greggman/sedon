// Pin the camera-input math against the renderer's modelView. The
// look-around path is easy to get a sign wrong on — and that's
// exactly what happened the first time around — so this test asserts
// the invariant directly:
//
//   For any starting (yaw, pitch, distance, target), applying
//   look-around with arbitrary dx/dy must leave the camera's WORLD
//   position unchanged. Target slides; camera stays put.
//
// We re-derive the camera world position from the modelView matrix
// (built the same way the render paths build it) so this test
// validates not just `cameraForward` against itself but against the
// matrix code in render/mat4.ts. If the renderer's Ry convention ever
// flips, this test catches it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLookAround, cameraForward, cameraWorldPosition } from '../../src/editor/orbit-camera.js';
import { multiply, rotationX, rotationY, translation } from '../../src/render/mat4.js';
import type { CameraState } from '../../src/editor/store.js';

function buildModelView(cam: CameraState): Float32Array {
  // Matches preview-tile.tsx / scene-preview.tsx exactly.
  return new Float32Array(
    multiply(
      multiply(
        multiply(translation(0, 0, -cam.distance), rotationX(cam.pitch)),
        rotationY(cam.yaw),
      ),
      translation(-cam.target[0], -cam.target[1], -cam.target[2]),
    ),
  );
}

// Apply a 4x4 column-major mat4 to a homogeneous (x,y,z,1) vec and
// return the (x,y,z) of the result.
function applyMat4(m: Float32Array | number[], v: readonly [number, number, number]): [number, number, number] {
  const x = m[0]! * v[0] + m[4]! * v[1] + m[8]!  * v[2] + m[12]!;
  const y = m[1]! * v[0] + m[5]! * v[1] + m[9]!  * v[2] + m[13]!;
  const z = m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2] + m[14]!;
  return [x, y, z];
}

function close(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function makeCam(yaw: number, pitch: number, distance: number, target: [number, number, number]): CameraState {
  return { yaw, pitch, distance, target: [target[0], target[1], target[2]] };
}

// ── cameraWorldPosition matches the renderer's modelView ────────────
// For every test camera, applying modelView to the computed world
// camera position must land at the view-space origin (0, 0, 0). If
// `cameraForward` has a sign bug, this test fires.
test('cameraWorldPosition: applying modelView lands at view origin', () => {
  const cases: CameraState[] = [
    makeCam(0, 0, 10, [0, 0, 0]),
    makeCam(0.5, 0.3, 10, [0, 0, 0]),
    makeCam(-0.5, -0.3, 7, [5, 2, 3]),
    makeCam(Math.PI / 4, Math.PI / 6, 10, [5, 2, 3]),
    makeCam(Math.PI, 0, 50, [-10, 30, 100]),
    // Pitch near ±π/2 — the clamped extreme of look-around.
    makeCam(0.7, Math.PI / 2 - 0.01, 25, [4, 4, 4]),
  ];
  for (const cam of cases) {
    const camWorld = cameraWorldPosition(cam);
    const mv = buildModelView(cam);
    const viewOrigin = applyMat4(mv, camWorld);
    assert.ok(
      close(viewOrigin[0], 0) && close(viewOrigin[1], 0) && close(viewOrigin[2], 0),
      `cam=${JSON.stringify(cam)} → world ${JSON.stringify(camWorld)} → view ${JSON.stringify(viewOrigin)} (expected origin)`,
    );
  }
});

// ── applyLookAround preserves camera world position ────────────────
// The whole point of look-around: yaw/pitch change, camera doesn't
// move. We test across mixed starting orientations + mixed deltas.
test('applyLookAround: camera world position is preserved after rotation', () => {
  const drags: Array<[number, number]> = [
    [10, 0], [0, 10], [-10, 0], [0, -10],
    [50, 25], [-50, -25], [100, -200],
  ];
  const starts: CameraState[] = [
    makeCam(0, 0, 10, [0, 0, 0]),
    makeCam(0.5, 0.3, 10, [5, 2, 3]),
    makeCam(-1.2, -0.7, 25, [-10, 5, 8]),
    makeCam(Math.PI / 4, Math.PI / 6, 50, [100, 30, -40]),
  ];
  for (const start of starts) {
    for (const [dx, dy] of drags) {
      const cam = { ...start, target: [...start.target] as [number, number, number] };
      const before = cameraWorldPosition(cam);
      applyLookAround(cam, dx, dy, 0.005);
      const after = cameraWorldPosition(cam);
      assert.ok(
        close(before[0], after[0]) && close(before[1], after[1]) && close(before[2], after[2]),
        `start=${JSON.stringify(start)} dx=${dx} dy=${dy}: cam moved from ${JSON.stringify(before)} to ${JSON.stringify(after)}`,
      );
    }
  }
});

// ── applyLookAround: target ends up `distance` ahead of camera ─────
// Confirms the "what I'm looking at" semantic — subsequent orbit
// rotates around the new focal point.
test('applyLookAround: target sits distance·forward ahead of camera', () => {
  const cam = makeCam(0.2, 0.1, 30, [10, 5, -3]);
  applyLookAround(cam, 80, -40, 0.005);
  const camWorld = cameraWorldPosition(cam);
  const fwd = cameraForward(cam.yaw, cam.pitch);
  const expectedTarget: [number, number, number] = [
    camWorld[0] + cam.distance * fwd[0],
    camWorld[1] + cam.distance * fwd[1],
    camWorld[2] + cam.distance * fwd[2],
  ];
  assert.ok(close(cam.target[0], expectedTarget[0]));
  assert.ok(close(cam.target[1], expectedTarget[1]));
  assert.ok(close(cam.target[2], expectedTarget[2]));
});

// ── applyLookAround: distance is unchanged ─────────────────────────
test('applyLookAround: distance is invariant', () => {
  const cam = makeCam(0, 0, 17, [3, 4, 5]);
  applyLookAround(cam, 200, -100, 0.005);
  assert.equal(cam.distance, 17);
});

// ── applyLookAround: pitch clamps near ±π/2 (no flip-over) ─────────
test('applyLookAround: pitch is clamped to (-π/2, +π/2)', () => {
  const cam = makeCam(0, 0, 10, [0, 0, 0]);
  // Huge downward drag — would otherwise pitch to π or beyond.
  applyLookAround(cam, 0, 100_000, 0.005);
  assert.ok(cam.pitch < Math.PI / 2, `pitch=${cam.pitch} should be < π/2`);
  assert.ok(cam.pitch > 0, `pitch=${cam.pitch} should still be positive`);
  // And upward.
  const cam2 = makeCam(0, 0, 10, [0, 0, 0]);
  applyLookAround(cam2, 0, -100_000, 0.005);
  assert.ok(cam2.pitch > -Math.PI / 2);
  assert.ok(cam2.pitch < 0);
});
