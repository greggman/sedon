// rAF-driven camera tween for gizmo axis snaps. The preview's input
// system mutates `cameraRef.current` directly and calls
// `requestRender()`; this helper does the same on each frame so the
// existing per-tile dirty short-circuit fires.
//
// Only the orbit fields (yaw, pitch, distance, orthoHeight, target)
// are tweened. `mode` is set up-front because switching projection
// mid-tween looks broken.

import type { CameraState } from './store.js';

export interface TweenTarget {
  yaw?: number;
  pitch?: number;
  distance?: number;
  orthoHeight?: number;
  target?: [number, number, number];
  mode?: 'persp' | 'ortho';
  snapBackToPerspOnOrbit?: boolean;
}

export interface CameraTweenHandle {
  /** Stop the tween where it is. Safe to call multiple times. */
  cancel: () => void;
  /** Promise that resolves when the tween completes OR is cancelled. */
  done: Promise<void>;
}

// Cubic ease-in-out: snappy start/end, soft middle. Standard 3t²-2t³.
function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

// Tween yaw along the shortest angular arc so a small visible jump
// never traverses the long way around the sphere.
function shortAngle(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return from + delta;
}

/**
 * Tween the live camera (the mutable ref shared with the renderer)
 * toward `to` over `durationMs`. Calls `onFrame` each rAF so the
 * caller can `requestRender()`. Returns a handle whose `cancel()`
 * stops the tween in place.
 */
export function tweenCamera(
  cam: CameraState,
  to: TweenTarget,
  durationMs: number,
  onFrame: () => void,
): CameraTweenHandle {
  // mode flips immediately — animating projection types looks wrong.
  if (to.mode !== undefined) cam.mode = to.mode;
  // snapBackToPerspOnOrbit also flips immediately; it's a flag, not
  // a continuous quantity.
  if (to.snapBackToPerspOnOrbit !== undefined) cam.snapBackToPerspOnOrbit = to.snapBackToPerspOnOrbit;

  // Snapshot of where we start and the targets we'll lerp to. We
  // resolve the yaw target against the shortest-arc rule once, up
  // front, so a mid-tween yaw read can't drift across the seam.
  const startYaw = cam.yaw;
  const endYaw = to.yaw !== undefined ? shortAngle(startYaw, to.yaw) : startYaw;
  const startPitch = cam.pitch;
  const endPitch = to.pitch ?? startPitch;
  const startDist = cam.distance;
  const endDist = to.distance ?? startDist;
  const startOH = cam.orthoHeight;
  const endOH = to.orthoHeight ?? startOH;
  const startTarget: [number, number, number] = [
    cam.target[0], cam.target[1], cam.target[2],
  ];
  const endTarget: [number, number, number] = to.target ?? startTarget;

  // rAF identity isn't preserved by `Date.now`-style clocks (which
  // we don't have anyway), so we use rAF's own timestamp.
  let raf = 0;
  let startTs = -1;
  let cancelled = false;
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });

  const step = (now: number) => {
    if (cancelled) { resolve(); return; }
    if (startTs < 0) startTs = now;
    const t = Math.min(1, (now - startTs) / durationMs);
    const k = ease(t);
    cam.yaw = startYaw + (endYaw - startYaw) * k;
    cam.pitch = startPitch + (endPitch - startPitch) * k;
    cam.distance = startDist + (endDist - startDist) * k;
    if (endOH !== undefined && startOH !== undefined) {
      cam.orthoHeight = startOH + (endOH - startOH) * k;
    } else if (endOH !== undefined) {
      cam.orthoHeight = endOH * k + (cam.orthoHeight ?? endOH) * (1 - k);
    }
    cam.target[0] = startTarget[0] + (endTarget[0] - startTarget[0]) * k;
    cam.target[1] = startTarget[1] + (endTarget[1] - startTarget[1]) * k;
    cam.target[2] = startTarget[2] + (endTarget[2] - startTarget[2]) * k;
    onFrame();
    if (t < 1) {
      raf = requestAnimationFrame(step);
    } else {
      resolve();
    }
  };
  raf = requestAnimationFrame(step);

  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      cancelAnimationFrame(raf);
      resolve();
    },
    done,
  };
}

// Axis snap targets, indexed by axis label. The renderer's modelView
// is `T(0,0,-d) * Rx(pitch) * Ry(yaw) * T(-target)`. Inverting it
// puts the camera at world position
//     target + d * (cos(pitch)·sin(yaw), sin(pitch), cos(pitch)·cos(yaw))
// so the (yaw, pitch) pairs below place the camera on the named axis
// looking back at the target. Labels match Blender's gizmo dots:
// `+X` is the "Right view" (camera on +X), `+Y` is "Top view", etc.
export const AXIS_SNAPS: Record<string, { yaw: number; pitch: number }> = {
  '+X': { yaw:  Math.PI / 2, pitch: 0 },
  '-X': { yaw: -Math.PI / 2, pitch: 0 },
  '+Y': { yaw: 0,            pitch:  Math.PI / 2 - 0.001 },
  '-Y': { yaw: 0,            pitch: -Math.PI / 2 + 0.001 },
  '+Z': { yaw: 0,            pitch: 0 },
  '-Z': { yaw: Math.PI,      pitch: 0 },
};
