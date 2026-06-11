// Blender-style camera gizmos overlay for the preview pane.
//
// Four widgets, stacked in a strip in the upper-left of each tile:
//   1. Orbit gizmo  — XYZ axes; drag the disc orbits, click an axis
//                     dot snaps the view down that axis (orthographic).
//   2. Dolly gizmo  — vertical drag dollies (distance / orthoHeight).
//   3. Pan gizmo    — drag pans the target along camera basis vectors.
//   4. Persp / Ortho toggle — single click swaps projection.
//
// The component mutates `cameraRef.current` in place (the same ref the
// renderer reads each frame) and calls `requestRender()` after every
// change. The SVG itself re-renders from rAF subscription so the axis
// dots track the live camera state.

import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { CameraState } from './store.js';
import { requestRender, subscribeRender } from './render-bus.js';
import { tweenCamera, AXIS_SNAPS, type CameraTweenHandle } from './camera-tween.js';

interface CameraGizmosProps {
  cameraRef: MutableRefObject<CameraState>;
  /** Called after the user lets go of a drag so the camera persists. */
  onCommit: () => void;
}

// Visual sizing. The orbit gizmo is a 76px square; the three controls
// below it are 28px each, laid out in a single row.
const ORBIT_SIZE = 76;
const ORBIT_R = 30;          // axis arm length in SVG units
const DOT_R = 7;             // axis dot radius
const CTRL_SIZE = 28;
const PERSP_FOV_Y = (60 * Math.PI) / 180;

// Axis colors — Blender convention (X red, Y green, Z blue).
const AXIS_COLORS: Record<string, { fill: string; outline: string }> = {
  X: { fill: '#e63946', outline: '#7a1f26' },
  Y: { fill: '#7ec850', outline: '#36622b' },
  Z: { fill: '#3a8dde', outline: '#1a4470' },
};

// Project a unit world-axis vector through (yaw, pitch) to view-space.
// Returns the (screenX, screenY, depth) tuple where +screenX is right,
// +screenY is DOWN (matches SVG), and depth>0 means behind the camera
// (back-facing dot), depth<0 means in front (front-facing dot).
function projectAxis(
  axis: [number, number, number],
  yaw: number,
  pitch: number,
): [number, number, number] {
  const [wx, wy, wz] = axis;
  // Ry(yaw): (x,y,z) → (x cosY + z sinY, y, -x sinY + z cosY)
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const vx = wx * cy + wz * sy;
  const vyTmp = wy;
  const vzTmp = -wx * sy + wz * cy;
  // Rx(pitch): (x,y,z) → (x, y cosP - z sinP, y sinP + z cosP)
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const vy = vyTmp * cp - vzTmp * sp;
  const vz = vyTmp * sp + vzTmp * cp;
  // SVG: +Y down, so flip vy when mapping to screen.
  return [vx, -vy, vz];
}

interface AxisProj {
  label: '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';
  axisChar: 'X' | 'Y' | 'Z';
  sign: 1 | -1;
  sx: number; // SVG x of the dot (relative to centre)
  sy: number;
  depth: number; // <0 = in front, >0 = behind
}

function buildAxisProjections(yaw: number, pitch: number): AxisProj[] {
  const dirs: { label: AxisProj['label']; axisChar: AxisProj['axisChar']; sign: AxisProj['sign']; v: [number, number, number] }[] = [
    { label: '+X', axisChar: 'X', sign:  1, v: [1, 0, 0] },
    { label: '-X', axisChar: 'X', sign: -1, v: [-1, 0, 0] },
    { label: '+Y', axisChar: 'Y', sign:  1, v: [0, 1, 0] },
    { label: '-Y', axisChar: 'Y', sign: -1, v: [0, -1, 0] },
    { label: '+Z', axisChar: 'Z', sign:  1, v: [0, 0, 1] },
    { label: '-Z', axisChar: 'Z', sign: -1, v: [0, 0, -1] },
  ];
  return dirs.map((d) => {
    const [sx, sy, depth] = projectAxis(d.v, yaw, pitch);
    return { label: d.label, axisChar: d.axisChar, sign: d.sign, sx, sy, depth };
  });
}

// Hit-test the orbit gizmo's axis dots. Returns the matched axis
// label (front-facing dots win) or null if the click is in the disc
// background.
function hitTestAxisDots(
  localX: number, // gizmo-local pixel coords, origin = SVG (0,0)
  localY: number,
  axes: AxisProj[],
): AxisProj['label'] | null {
  const cx = ORBIT_SIZE / 2;
  const cy = ORBIT_SIZE / 2;
  // Front-first so a front-facing dot covering a back-facing one wins.
  const sorted = [...axes].sort((a, b) => a.depth - b.depth);
  for (const ax of sorted) {
    const dx = localX - (cx + ax.sx * ORBIT_R);
    const dy = localY - (cy + ax.sy * ORBIT_R);
    if (Math.hypot(dx, dy) <= DOT_R + 2) return ax.label;
  }
  return null;
}

export function CameraGizmos({ cameraRef, onCommit }: CameraGizmosProps) {
  // Force a re-render on every animation tick so the axis dots track
  // the live camera. Reading cameraRef inside the render is fine —
  // subscribeRender fires on each frame the camera changed.
  const [, bumpRender] = useState(0);
  useEffect(() => {
    return subscribeRender(() => bumpRender((n) => (n + 1) & 0x7fffffff));
  }, []);

  // Any active tween. Cancel on user input so clicks during animation
  // feel responsive.
  const tweenRef = useRef<CameraTweenHandle | null>(null);
  const cancelTween = () => {
    tweenRef.current?.cancel();
    tweenRef.current = null;
  };

  // Did the user just snap to an axis? If so, the next orbit drag
  // flips the projection back to perspective (matches Blender).
  const recentlySnappedRef = useRef(false);

  const cam = cameraRef.current;
  const axes = buildAxisProjections(cam.yaw, cam.pitch);

  // ────────────────────────────────────────────────────────────────
  // Orbit gizmo pointer handling.
  //
  // Blender behavior: pressing on an axis dot does NOT snap
  // immediately. If the user releases without moving (a true click),
  // we snap to that axis on pointerup. If they drag past a small
  // threshold, the pending snap is abandoned and we orbit instead —
  // dragging a dot just rotates the view, same as dragging the disc.
  //
  // `pendingDot` carries the candidate snap target; once it's set
  // the move handler waits to see whether this becomes a click or
  // a drag. Pressing on disc background sets `pendingDot=null` and
  // orbits immediately (no threshold).
  // ────────────────────────────────────────────────────────────────
  const orbitDragRef = useRef<{
    pointerId: number;
    lastX: number;
    lastY: number;
    downX: number;
    downY: number;
    pendingDot: AxisProj['label'] | null;
  } | null>(null);
  const CLICK_DRAG_THRESHOLD_PX = 4;

  const fireAxisSnap = (label: AxisProj['label']) => {
    const snap = AXIS_SNAPS[label]!;
    const c = cameraRef.current;
    const fovY = PERSP_FOV_Y;
    const orthoH = c.orthoHeight ?? c.distance * 2 * Math.tan(fovY / 2);
    tweenRef.current = tweenCamera(
      c,
      { yaw: snap.yaw, pitch: snap.pitch, mode: 'ortho', orthoHeight: orthoH },
      180,
      () => requestRender(),
    );
    tweenRef.current.done.then(() => {
      tweenRef.current = null;
      onCommit();
    });
    recentlySnappedRef.current = true;
  };

  const onOrbitPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    cancelTween();
    const rect = e.currentTarget.getBoundingClientRect();
    const lx = e.clientX - rect.left;
    const ly = e.clientY - rect.top;
    const dotHit = hitTestAxisDots(lx, ly, axes);
    e.preventDefault();
    e.stopPropagation();
    // React 17+: stopPropagation only halts SYNTHETIC bubbling. The
    // preview pane's grid attaches `pointerdown` via addEventListener
    // (native), which fires DURING DOM bubbling — before React's
    // synthetic dispatch even starts. Without the line below, the
    // grid steals the pointer (orbit-drag) and our pointerup never
    // reaches the gizmo, so click handlers (and per-control drags)
    // silently miss.
    e.nativeEvent.stopPropagation();
    orbitDragRef.current = {
      pointerId: e.pointerId,
      lastX: e.clientX,
      lastY: e.clientY,
      downX: e.clientX,
      downY: e.clientY,
      pendingDot: dotHit,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const onOrbitPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = orbitDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    // If a snap is pending, hold off on orbiting until the pointer
    // crosses the drag threshold. Once crossed, drop the pending snap
    // and treat the rest of the gesture as an orbit drag.
    if (drag.pendingDot) {
      const total = Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY);
      if (total < CLICK_DRAG_THRESHOLD_PX) return;
      drag.pendingDot = null;
      // First orbit drag after an axis snap flips ortho → persp
      // (matches Blender). Reset the marker now that the user is
      // committing to a drag instead of a click.
      if (recentlySnappedRef.current && cameraRef.current.mode === 'ortho') {
        cameraRef.current.mode = 'persp';
      }
      recentlySnappedRef.current = false;
    }
    const c = cameraRef.current;
    const sens = 0.01;
    // Horizontal sign matches the canvas-orbit handler in preview.tsx.
    c.yaw -= dx * sens;
    c.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, c.pitch + dy * sens));
    requestRender();
  };
  const onOrbitPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = orbitDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    orbitDragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (drag.pendingDot) {
      // True click on a dot — fire the snap now.
      fireAxisSnap(drag.pendingDot);
      return;
    }
    onCommit();
  };

  // ────────────────────────────────────────────────────────────────
  // Dolly gizmo. Vertical drag → exponential distance/orthoHeight.
  // ────────────────────────────────────────────────────────────────
  const dollyDragRef = useRef<{ pointerId: number; lastY: number } | null>(null);
  const onDollyDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    cancelTween();
    e.preventDefault();
    e.stopPropagation();
    // React 17+: stopPropagation only halts SYNTHETIC bubbling. The
    // preview pane's grid attaches `pointerdown` via addEventListener
    // (native), which fires DURING DOM bubbling — before React's
    // synthetic dispatch even starts. Without the line below, the
    // grid steals the pointer (orbit-drag) and our pointerup never
    // reaches the gizmo, so click handlers (and per-control drags)
    // silently miss.
    e.nativeEvent.stopPropagation();
    dollyDragRef.current = { pointerId: e.pointerId, lastY: e.clientY };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const onDollyMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dollyDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dy = e.clientY - drag.lastY;
    drag.lastY = e.clientY;
    const c = cameraRef.current;
    // Same exponential feel as the wheel handler, but per-pixel.
    const factor = Math.exp(dy * 0.01);
    if (c.mode === 'ortho') {
      const baseH = c.orthoHeight ?? c.distance * 2 * Math.tan(PERSP_FOV_Y / 2);
      c.orthoHeight = Math.max(0.01, Math.min(10000, baseH * factor));
    } else {
      c.distance = Math.max(0.5, Math.min(2500, c.distance * factor));
    }
    requestRender();
  };
  const onDollyUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dollyDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dollyDragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    onCommit();
  };

  // ────────────────────────────────────────────────────────────────
  // Pan gizmo. Drag → translate target along camera basis vectors.
  // ────────────────────────────────────────────────────────────────
  const panDragRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);
  const onPanDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    cancelTween();
    e.preventDefault();
    e.stopPropagation();
    // React 17+: stopPropagation only halts SYNTHETIC bubbling. The
    // preview pane's grid attaches `pointerdown` via addEventListener
    // (native), which fires DURING DOM bubbling — before React's
    // synthetic dispatch even starts. Without the line below, the
    // grid steals the pointer (orbit-drag) and our pointerup never
    // reaches the gizmo, so click handlers (and per-control drags)
    // silently miss.
    e.nativeEvent.stopPropagation();
    panDragRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const onPanMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    const c = cameraRef.current;
    // Camera basis from yaw/pitch (matches preview.tsx's pan math).
    const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
    const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    // Right = Ry(yaw) * (1,0,0) ignoring pitch (pitch is about right axis).
    const rightX = cy, rightY = 0, rightZ = -sy;
    // Up = Rx(pitch) * Ry(yaw) * (0,1,0). After Ry, (0,1,0) stays. After
    // Rx(pitch): (0, cosP, sinP). Express in world by inverse rotations:
    // World up = Ry(-yaw) * Rx(-pitch) * (0, cosP, sinP), but simpler:
    // up_world = (sinP * sinY,  cosP, sinP * cosY)? Let me re-derive on
    // paper. The pan sensitivity dominates so a small constant error in
    // basis direction wouldn't be visible; the existing preview pan uses
    // the modelView row vectors directly. Easiest: same idea here.
    const upX = sp * sy;
    const upY = cp;
    const upZ = sp * cy;
    const sens = (c.mode === 'ortho' ? (c.orthoHeight ?? 1) : c.distance) * 0.0025;
    c.target[0] -= rightX * dx * sens;
    c.target[1] -= rightY * dx * sens;
    c.target[2] -= rightZ * dx * sens;
    c.target[0] += upX * dy * sens;
    c.target[1] += upY * dy * sens;
    c.target[2] += upZ * dy * sens;
    requestRender();
  };
  const onPanUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    panDragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    onCommit();
  };

  // ────────────────────────────────────────────────────────────────
  // Persp/Ortho toggle.
  // ────────────────────────────────────────────────────────────────
  const onModeClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // React 17+: stopPropagation only halts SYNTHETIC bubbling. The
    // preview pane's grid attaches `pointerdown` via addEventListener
    // (native), which fires DURING DOM bubbling — before React's
    // synthetic dispatch even starts. Without the line below, the
    // grid steals the pointer (orbit-drag) and our pointerup never
    // reaches the gizmo, so click handlers (and per-control drags)
    // silently miss.
    e.nativeEvent.stopPropagation();
    cancelTween();
    const c = cameraRef.current;
    if (c.mode === 'ortho') {
      c.mode = 'persp';
    } else {
      c.mode = 'ortho';
      // Preserve visible size: pick orthoHeight that matches what the
      // perspective frustum showed at the target plane.
      if (c.orthoHeight === undefined) {
        c.orthoHeight = c.distance * 2 * Math.tan(PERSP_FOV_Y / 2);
      }
    }
    recentlySnappedRef.current = false;
    requestRender();
    onCommit();
  };

  const cx = ORBIT_SIZE / 2;
  const cyOrb = ORBIT_SIZE / 2;
  // Sort axes for draw order: back dots first, front dots on top.
  const sortedAxes = [...axes].sort((a, b) => b.depth - a.depth);

  const isOrtho = cam.mode === 'ortho';

  return (
    <div
      className="sedon-camera-gizmos"
    >
      {/* Orbit gizmo */}
      <svg
        className="sedon-gizmo-orbit"
        width={ORBIT_SIZE}
        height={ORBIT_SIZE}
        viewBox={`0 0 ${ORBIT_SIZE} ${ORBIT_SIZE}`}
        onPointerDown={onOrbitPointerDown}
        onPointerMove={onOrbitPointerMove}
        onPointerUp={onOrbitPointerUp}
        onPointerCancel={onOrbitPointerUp}
      >
        <g className="sedon-gizmo-orbit-frame">
          {/* Background disc — drag area when not on a dot. */}
          <circle cx={cx} cy={cyOrb} r={ORBIT_R + 4} className="sedon-gizmo-disc" />
          {/* Axis arms, sorted back-to-front. Each is a line from centre
              out to its dot, colored by axis. Back-facing arms are dimmer. */}
          {sortedAxes.map((ax) => {
            const dotX = cx + ax.sx * ORBIT_R;
            const dotY = cyOrb + ax.sy * ORBIT_R;
            const isFront = ax.depth <= 0;
            const col = AXIS_COLORS[ax.axisChar]!;
            return (
              <g className={isFront ? "sedon-gizmo-axis-front" : "sedon-gizmo-axis-back"} key={ax.label}>
                {/* Arm only drawn for the positive direction; negative is
                    a dot only, like Blender. */}
                {ax.sign === 1 && (
                  <line
                    x1={cx} y1={cyOrb}
                    x2={dotX} y2={dotY}
                    stroke={col.fill}
                    strokeWidth={2.5}
                    strokeLinecap="round"
                  />
                )}
                <g className="sedon-gizmo-axis-dot-outline">
                  <circle
                    cx={dotX} cy={dotY}
                    r={DOT_R}
                    fill={ax.sign === 1 ? col.fill : 'transparent'}
                    stroke={col.fill}
                    strokeWidth={2}
                  />
                  <text
                    x={dotX} y={dotY}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={9}
                    fontWeight={700}
                    pointerEvents="none"
                    className={ax.sign === 1 ? "sedon-gizmo-axis-label-positive" : "sedon-gizmo-axis-label-negative"}
                  >{ax.axisChar}</text>
                </g>
              </g>
            );
          })}
        </g>
      </svg>

      <div className="sedon-gizmo-row">
        {/* Dolly */}
        <svg
          className="sedon-gizmo-ctrl"
          width={CTRL_SIZE} height={CTRL_SIZE}
          viewBox="0 0 28 28"
          onPointerDown={onDollyDown}
          onPointerMove={onDollyMove}
          onPointerUp={onDollyUp}
          onPointerCancel={onDollyUp}
        >
          <title>Dolly (drag vertically)</title>
          <circle cx={14} cy={14} r={13} className="sedon-gizmo-bg" />
          {/* Magnifying-glass icon */}
          <circle cx={12} cy={12} r={5} fill="none" stroke="#ddd" strokeWidth={2} />
          <line x1={16} y1={16} x2={21} y2={21} stroke="#ddd" strokeWidth={2.5} strokeLinecap="round" />
          <line x1={9.5} y1={12} x2={14.5} y2={12} stroke="#ddd" strokeWidth={1.5} strokeLinecap="round" />
          <line x1={12} y1={9.5} x2={12} y2={14.5} stroke="#ddd" strokeWidth={1.5} strokeLinecap="round" />
        </svg>

        {/* Pan */}
        <svg
          className="sedon-gizmo-ctrl"
          width={CTRL_SIZE} height={CTRL_SIZE}
          viewBox="0 0 28 28"
          onPointerDown={onPanDown}
          onPointerMove={onPanMove}
          onPointerUp={onPanUp}
          onPointerCancel={onPanUp}
        >
          <title>Pan (drag)</title>
          <circle cx={14} cy={14} r={13} className="sedon-gizmo-bg" />
          {/* 4-way arrow cross */}
          <path
            d="M14 4 L17 8 L15 8 L15 13 L20 13 L20 11 L24 14 L20 17 L20 15 L15 15 L15 20 L17 20 L14 24 L11 20 L13 20 L13 15 L8 15 L8 17 L4 14 L8 11 L8 13 L13 13 L13 8 L11 8 Z"
            fill="#ddd"
          />
        </svg>

        {/* Persp/Ortho toggle */}
        <svg
          className={`sedon-gizmo-ctrl ${isOrtho ? 'is-active' : ''}`}
          width={CTRL_SIZE} height={CTRL_SIZE}
          viewBox="0 0 28 28"
          onClick={onModeClick}
        >
          <title>{isOrtho ? 'Switch to perspective' : 'Switch to orthographic'}</title>
          <circle cx={14} cy={14} r={13} className="sedon-gizmo-bg" />
          {isOrtho ? (
            // Orthographic glyph: parallel rectangle stack.
            <g stroke="#ddd" strokeWidth={1.7} fill="none">
              <rect x={6} y={9}  width={16} height={10} />
              <rect x={9} y={6}  width={16} height={10} />
            </g>
          ) : (
            // Perspective glyph: trapezoid (foreshortened rectangle).
            <g stroke="#ddd" strokeWidth={1.7} fill="none">
              <path d="M5 21 L23 21 L19 9 L9 9 Z" />
              <line x1={9} y1={9} x2={5} y2={21} />
              <line x1={19} y1={9} x2={23} y2={21} />
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}
