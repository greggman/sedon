// Camera input math for the preview's orbit camera. Extracted from
// preview.tsx so the trickier bits (look-around target slide,
// camera-position derivation) can be unit-tested independently of the
// React / pointer-event scaffolding.
//
// All functions operate on a plain `{ yaw, pitch, distance, target }`
// shape that matches store.ts's `CameraState`. They mutate `target`
// in place for the look-around path (and only `target`'s elements,
// not the array reference) so callers can keep a single CameraState
// object across the editing session.

import type { CameraState } from './store.js';

// Pitch clamp — keeps the camera from rolling over the pole and
// looking at itself upside-down. Matches the existing orbit handler.
const PITCH_EPS = 0.01;
const PITCH_MAX = Math.PI / 2 - PITCH_EPS;

/**
 * Camera FORWARD direction in world space — the unit vector from the
 * camera toward the orbit target.
 *
 * The render path's view matrix is
 *   modelView = T(0,0,-d) · Rx(pitch) · Ry(yaw) · T(-target)
 * (see preview-tile.tsx / scene-preview.tsx). With this codebase's
 * left-handed Ry convention, R = Rx(pitch)·Ry(yaw) has
 *   row2(R) = (cos p · sin y, sin p, cos p · cos y).
 * Camera looks down view -Z, so world forward = -row2(R).
 */
export function cameraForward(yaw: number, pitch: number): [number, number, number] {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return [-cp * sy, -sp, -cp * cy];
}

/**
 * World-space camera position derived from orbit parameters.
 *   camera = target − distance · forward
 */
export function cameraWorldPosition(cam: CameraState): [number, number, number] {
  const f = cameraForward(cam.yaw, cam.pitch);
  return [
    cam.target[0] - cam.distance * f[0],
    cam.target[1] - cam.distance * f[1],
    cam.target[2] - cam.distance * f[2],
  ];
}

/**
 * FPS-style mouse-look: rotate the view in place. `dx` / `dy` are
 * pointer-delta pixels (same units the existing orbit drag uses);
 * `sens` is radians/pixel. The camera's WORLD position is preserved
 * exactly; `cam.target` slides to sit `distance` ahead of the camera
 * along the new view direction so subsequent orbit / pan gestures
 * start from the new viewpoint.
 *
 * Mutates cam.yaw / pitch / target. Distance is unchanged.
 */
export function applyLookAround(cam: CameraState, dx: number, dy: number, sens: number): void {
  // Snapshot the world camera position BEFORE changing yaw/pitch so we
  // can pin target to keep that position constant.
  const cam0 = cameraWorldPosition(cam);

  cam.yaw += dx * sens;
  cam.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, cam.pitch + dy * sens));

  // target = camera + distance · newForward
  const f = cameraForward(cam.yaw, cam.pitch);
  cam.target[0] = cam0[0] + cam.distance * f[0];
  cam.target[1] = cam0[1] + cam.distance * f[1];
  cam.target[2] = cam0[2] + cam.distance * f[2];
}
