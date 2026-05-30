import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUpstreamOutput, useCanvasNode } from '../canvas-data.js';
import { acquireGpuDevice, type GpuDevice } from '../../render/device.js';
import { TexturePreview } from '../texture-preview.js';
import type { Texture2DValue } from '../../core/resources.js';
import type { Point } from '../../nodes/point-list.js';

// Two pieces, mirroring gradient-editor.tsx's split:
//   • PointListInput  — the in-row trigger: a small button with the
//                       current point count. Opens the popup on click.
//   • PointListPopup  — the full editor in a portalled popup: a
//                       draggable, resizable window with a top-down
//                       canvas that maps world XZ to screen pixels.
//                       The upstream `preview_texture` (if any) draws
//                       as the backdrop; an SVG overlay carries the
//                       draggable point handles and selection marquee.
//
// Standard editor mechanics:
//   • Click empty area  → add a point + select it.
//   • Drag empty area   → marquee box-select (shift = additive).
//   • Click handle      → select only it.
//   • Shift-click handle → toggle in selection.
//   • Drag any handle   → move all selected points as a group.
//   • Click segment line → insert a new point on the segment.
//   • Right-click handle → delete that one point.
//   • Delete key        → delete all selected.
//   • ⌘A                → select all.
//   • ⌘C / ⌘V           → copy / paste selected (popup-local clipboard).
//   • Esc / click-outside → close.
//
// Drag-batching: all handle drags accumulate into local state; one
// onChange (and therefore one undo entry) fires on pointerup. Without
// this, every pointermove during a drag becomes its own dispatchProject.

interface PointListInputProps {
  value: Point[];
  // Every point-list commit is a discrete user action — add, drag-end,
  // paste, delete, insert. Each should be its own undo entry rather
  // than merging into one big "this editor session" entry. We pass
  // `coalesce: false` on every call to opt out of the dispatcher's
  // per-(nodeId, name) coalescing rule (which exists to collapse
  // NumberInput scrub-pixel commands into one entry).
  onChange: (next: Point[], opts?: { coalesce?: boolean }) => void;
  nodeId: string;
  panelId: string | null;
}

const COMMIT_OPTS = { coalesce: false } as const;

interface PopupProps extends PointListInputProps {
  onClose: () => void;
  anchorRect: DOMRect;
}

// Module-level "last position / size" so a re-open of the editor lands
// back where the user left it (within the session), and a popup-local
// clipboard for copy/paste between same-session opens.
let lastPos: { x: number; y: number } | null = null;
let lastSize = { w: 504, h: 568 };
const moduleClipboard: { points: Point[] } = { points: [] };

const MIN_POPUP_W = 320;
const MIN_POPUP_H = 360;
const HEADER_H = 30;
const FOOTER_H = 26;
const PADDING = 8;
const DRAG_THRESHOLD = 4;

export function PointListInput({ value, onChange, nodeId, panelId }: PointListInputProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const anchorRectRef = useRef<DOMRect | null>(null);
  const onOpen = useCallback(() => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) anchorRectRef.current = r;
    setOpen(true);
  }, []);
  const onClose = useCallback(() => setOpen(false), []);
  const count = value.length;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="sedon-pointlist-trigger nodrag"
        onClick={onOpen}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label="Edit points"
      >
        {count} {count === 1 ? 'point' : 'points'} · Edit…
      </button>
      {open && anchorRectRef.current && (
        <PointListPopup
          value={value}
          onChange={onChange}
          onClose={onClose}
          anchorRect={anchorRectRef.current}
          nodeId={nodeId}
          panelId={panelId}
        />
      )}
    </>
  );
}

interface HandleDrag {
  pointerId: number;
  // Pointer position at drag-start, canvas px.
  startPx: { x: number; y: number };
  // Snapshot of `value` at drag-start. We translate the SELECTED
  // points by (currentPx - startPx → world delta) each move; non-
  // selected points pass through unchanged. Commit fires on pointerup.
  startPoints: Point[];
}

interface Marquee {
  pointerId: number;
  startPx: { x: number; y: number };
  currentPx: { x: number; y: number };
  // Selection to UNION the marquee's hit-set with on commit. Empty for
  // non-shift drags (marquee replaces selection); the existing selection
  // for shift-drag (marquee adds).
  baseline: ReadonlySet<number>;
}

function isTexture2D(v: unknown): v is Texture2DValue {
  return (
    typeof v === 'object' && v !== null
    && 'texture' in v && 'width' in v && 'height' in v
  );
}

function clampPopupPos(
  x: number, y: number, w: number, h: number,
): { x: number; y: number } {
  return {
    x: Math.min(Math.max(8, x), window.innerWidth - w - 8),
    y: Math.min(Math.max(8, y), window.innerHeight - h - 8),
  };
}

function PointListPopup({ value, onChange, onClose, anchorRect, nodeId, panelId }: PopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Popup position + size. Seeded from module-level state so re-opens
  // remember the user's choice within a session.
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    if (lastPos) return clampPopupPos(lastPos.x, lastPos.y, lastSize.w, lastSize.h);
    return clampPopupPos(anchorRect.left, anchorRect.bottom + 4, lastSize.w, lastSize.h);
  });
  const [size, setSize] = useState(lastSize);
  useEffect(() => { lastPos = pos; }, [pos]);
  useEffect(() => { lastSize = size; }, [size]);

  // Selection (transient — never persisted into inputValues).
  const [selection, setSelection] = useState<ReadonlySet<number>>(new Set());
  // Re-clamp selection if `value` shrinks externally (undo, paste, etc.).
  useEffect(() => {
    setSelection((sel) => {
      const next = new Set<number>();
      for (const i of sel) if (i < value.length) next.add(i);
      return next.size === sel.size ? sel : next;
    });
  }, [value.length]);

  // Drag state — both handle drag and marquee. Mutually exclusive.
  const [handleDrag, setHandleDrag] = useState<HandleDrag | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  // Pointer-down state on the SVG: a click that hasn't yet moved past
  // the drag threshold. On pointerup without movement → add a point.
  const pendingClickRef = useRef<{ pointerId: number; x: number; y: number; shift: boolean } | null>(null);

  // Pull `world_size` directly off the node's inputValues.
  const view = useCanvasNode(panelId, nodeId);
  const worldSize = useMemo<[number, number]>(() => {
    const raw = view?.node.inputValues?.world_size;
    if (Array.isArray(raw) && typeof raw[0] === 'number' && typeof raw[1] === 'number') {
      return [raw[0], raw[1]];
    }
    return [40, 40];
  }, [view]);

  // Live upstream Texture2D for the backdrop.
  const upstream = useUpstreamOutput(panelId, nodeId, 'preview_texture');
  const texture = isTexture2D(upstream) ? upstream : null;

  const [gpu, setGpu] = useState<GpuDevice | null>(null);
  useEffect(() => { void acquireGpuDevice().then(setGpu); }, []);

  // Canvas dimensions derived from popup size minus chrome.
  const canvasW = Math.max(64, size.w - PADDING * 2);
  const canvasH = Math.max(64, size.h - HEADER_H - FOOTER_H - PADDING * 2);

  // Pixel ↔ world mapping. World origin at canvas centre; X grows right,
  // Z grows DOWN the screen (top of canvas = -Z, bottom = +Z). Matches
  // the convention of texture V=0 sitting at the top of the canvas.
  const pxToWorld = useCallback(
    (px: number, py: number): { x: number; z: number } => ({
      x: (px / canvasW - 0.5) * worldSize[0],
      z: (py / canvasH - 0.5) * worldSize[1],
    }),
    [worldSize, canvasW, canvasH],
  );
  const worldToPx = useCallback(
    (x: number, z: number): { px: number; py: number } => ({
      px: (x / worldSize[0] + 0.5) * canvasW,
      py: (z / worldSize[1] + 0.5) * canvasH,
    }),
    [worldSize, canvasW, canvasH],
  );

  const eventToCanvasPx = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  // Displayed points: during a handle-drag, the selected points are
  // translated by the live delta; everything else is unchanged. Commit
  // fires on pointerup as a single onChange. The drag-time positions
  // live in `draggedPoints` so each pointermove can update them
  // without going through React's state-batching of the parent.
  const [draggedPoints, setDraggedPoints] = useState<Point[] | null>(null);
  const points = draggedPoints ?? value;

  // ─ Click-outside / Escape / keyboard ──────────────────────────────
  useEffect(() => {
    function onDocPointerDown(e: PointerEvent) {
      const popup = popupRef.current;
      if (!popup) return;
      if (e.target instanceof Node && popup.contains(e.target)) return;
      onClose();
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [onClose]);

  // Auto-focus on open so the popup's onKeyDown receives shortcuts
  // immediately. Without this the user has to click into the popup
  // before Cmd+A / Delete / Esc work — and worse, those shortcuts then
  // fall through to the window-level canvas handlers (which think the
  // canvas is active and select every node in the graph).
  useEffect(() => {
    popupRef.current?.focus();
  }, []);

  // Keyboard shortcuts, scoped to the popup being focused. Every match
  // calls BOTH `preventDefault` (so the browser doesn't act on the
  // shortcut — Cmd+A selecting page text, etc.) AND `stopPropagation`
  // (so the canvas's window-level Cmd+A / Cmd+C / Cmd+V handlers in
  // app.tsx don't ALSO fire and select every node in the graph).
  const onPopupKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selection.size === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const next = value.filter((_, i) => !selection.has(i));
      onChange(next, COMMIT_OPTS);
      setSelection(new Set());
      return;
    }
    if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      e.stopPropagation();
      setSelection(new Set(value.map((_, i) => i)));
      return;
    }
    if (mod && (e.key === 'c' || e.key === 'C')) {
      if (selection.size === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const picked: Point[] = [];
      for (let i = 0; i < value.length; i++) {
        if (selection.has(i)) picked.push([...value[i]!] as Point);
      }
      moduleClipboard.points = picked;
      return;
    }
    if (mod && (e.key === 'v' || e.key === 'V')) {
      if (moduleClipboard.points.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const offsetWorld = worldSize[0] * 0.05; // small visible nudge so paste isn't on top of source
      const inserted = moduleClipboard.points.map((p) => [p[0] + offsetWorld, p[1], p[2] + offsetWorld] as Point);
      const baseLen = value.length;
      const next = [...value, ...inserted];
      onChange(next, COMMIT_OPTS);
      const newSel = new Set<number>();
      for (let i = 0; i < inserted.length; i++) newSel.add(baseLen + i);
      setSelection(newSel);
      return;
    }
  }, [onClose, selection, value, onChange, worldSize]);

  // ─ SVG canvas interactions ────────────────────────────────────────

  // Mouse-down on the SVG (empty area). Could become any of:
  //   • Quick click (no movement, no shift)  → add a point.
  //   • Drag (movement past threshold)       → marquee.
  //   • Click with shift, no movement        → no-op.
  const onCanvasPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    if (e.target !== e.currentTarget) return; // a handle or segment caught it
    e.stopPropagation();
    const { x, y } = eventToCanvasPx(e.clientX, e.clientY);
    pendingClickRef.current = { pointerId: e.pointerId, x, y, shift: e.shiftKey };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [eventToCanvasPx]);

  const onCanvasPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const pending = pendingClickRef.current;
    if (pending && pending.pointerId === e.pointerId && !marquee) {
      const { x, y } = eventToCanvasPx(e.clientX, e.clientY);
      const dx = x - pending.x, dy = y - pending.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        // Promote to marquee.
        setMarquee({
          pointerId: e.pointerId,
          startPx: { x: pending.x, y: pending.y },
          currentPx: { x, y },
          baseline: pending.shift ? new Set(selection) : new Set(),
        });
        pendingClickRef.current = null;
      }
      return;
    }
    if (marquee && marquee.pointerId === e.pointerId) {
      const { x, y } = eventToCanvasPx(e.clientX, e.clientY);
      setMarquee({ ...marquee, currentPx: { x, y } });
    }
  }, [marquee, selection, eventToCanvasPx]);

  const onCanvasPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const pending = pendingClickRef.current;
    if (pending && pending.pointerId === e.pointerId) {
      // True click — add a point at the click position, unless shift was held.
      if (!pending.shift) {
        const { x, z } = pxToWorld(pending.x, pending.y);
        const next: Point[] = [...value, [x, 0, z]];
        onChange(next, COMMIT_OPTS);
        setSelection(new Set([value.length])); // select the newly added
      }
      pendingClickRef.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
      return;
    }
    if (marquee && marquee.pointerId === e.pointerId) {
      // Commit marquee: hit-test every point's screen pos against the rect.
      const x0 = Math.min(marquee.startPx.x, marquee.currentPx.x);
      const x1 = Math.max(marquee.startPx.x, marquee.currentPx.x);
      const y0 = Math.min(marquee.startPx.y, marquee.currentPx.y);
      const y1 = Math.max(marquee.startPx.y, marquee.currentPx.y);
      const hit = new Set<number>(marquee.baseline);
      for (let i = 0; i < value.length; i++) {
        const { px, py } = worldToPx(value[i]![0], value[i]![2]);
        if (px >= x0 && px <= x1 && py >= y0 && py <= y1) hit.add(i);
      }
      setSelection(hit);
      setMarquee(null);
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, [marquee, value, onChange, pxToWorld, worldToPx]);

  // ─ Handle drag ────────────────────────────────────────────────────
  const onHandlePointerDown = useCallback(
    (idx: number, e: React.PointerEvent<SVGCircleElement>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      // Selection update: shift toggles; plain click replaces (unless
      // the handle is already in the selection, in which case keep it).
      let nextSel: Set<number>;
      if (e.shiftKey) {
        nextSel = new Set(selection);
        if (nextSel.has(idx)) nextSel.delete(idx);
        else nextSel.add(idx);
      } else if (selection.has(idx)) {
        nextSel = new Set(selection); // keep group
      } else {
        nextSel = new Set([idx]);
      }
      setSelection(nextSel);
      const { x, y } = eventToCanvasPx(e.clientX, e.clientY);
      // Start dragging only if SOMETHING is selected (it always is after
      // the assignment above). Snapshot start positions for the live
      // translate; commit on pointerup.
      setHandleDrag({
        pointerId: e.pointerId,
        startPx: { x, y },
        startPoints: value.map((p) => [...p] as Point),
      });
    },
    [selection, value, eventToCanvasPx],
  );

  const onHandlePointerMove = useCallback(
    (e: React.PointerEvent<SVGCircleElement>) => {
      if (!handleDrag || handleDrag.pointerId !== e.pointerId) return;
      const { x, y } = eventToCanvasPx(e.clientX, e.clientY);
      const dxPx = x - handleDrag.startPx.x;
      const dyPx = y - handleDrag.startPx.y;
      const dxWorld = (dxPx / canvasW) * worldSize[0];
      const dzWorld = (dyPx / canvasH) * worldSize[1];
      const next = handleDrag.startPoints.map((p, i) =>
        selection.has(i) ? ([p[0] + dxWorld, p[1], p[2] + dzWorld] as Point) : p,
      );
      setDraggedPoints(next);
    },
    [handleDrag, selection, eventToCanvasPx, canvasW, canvasH, worldSize],
  );

  const onHandlePointerUp = useCallback(
    (e: React.PointerEvent<SVGCircleElement>) => {
      if (!handleDrag || handleDrag.pointerId !== e.pointerId) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      // Commit the drag — single onChange, single undo entry.
      if (draggedPoints) onChange(draggedPoints, COMMIT_OPTS);
      setDraggedPoints(null);
      setHandleDrag(null);
    },
    [handleDrag, draggedPoints, onChange],
  );

  const onHandleContextMenu = useCallback(
    (idx: number, e: React.MouseEvent<SVGCircleElement>) => {
      e.preventDefault();
      e.stopPropagation();
      onChange(value.filter((_, i) => i !== idx), COMMIT_OPTS);
      // Re-index selection: drop idx, decrement higher indices.
      setSelection((sel) => {
        const next = new Set<number>();
        for (const i of sel) {
          if (i < idx) next.add(i);
          else if (i > idx) next.add(i - 1);
        }
        return next;
      });
    },
    [value, onChange],
  );

  // ─ Segment click (insert between) ─────────────────────────────────
  const onSegmentPointerDown = useCallback(
    (segIdx: number, e: React.PointerEvent<SVGLineElement>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      // Insert a new point at the click position, between segIdx and
      // segIdx+1, and select it for an immediate drag.
      const { x: px, y: py } = eventToCanvasPx(e.clientX, e.clientY);
      const { x, z } = pxToWorld(px, py);
      const insertAt = segIdx + 1;
      const next: Point[] = [
        ...value.slice(0, insertAt),
        [x, 0, z] as Point,
        ...value.slice(insertAt),
      ];
      onChange(next, COMMIT_OPTS);
      // Match "click on empty space to add" UX: the new point becomes
      // the sole selection, so the user can immediately drag it or
      // continue building a chain. Keeping the prior selection here
      // felt sticky.
      setSelection(new Set([insertAt]));
    },
    [eventToCanvasPx, pxToWorld, value, onChange],
  );

  // ─ Header drag (move popup) ───────────────────────────────────────
  const popupDragRef = useRef<{ pointerId: number; offset: { x: number; y: number } } | null>(null);
  const onHeaderPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest('button')) return; // header buttons
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    popupDragRef.current = {
      pointerId: e.pointerId,
      offset: { x: e.clientX - pos.x, y: e.clientY - pos.y },
    };
  }, [pos]);
  const onHeaderPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = popupDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    setPos(clampPopupPos(e.clientX - d.offset.x, e.clientY - d.offset.y, size.w, size.h));
  }, [size]);
  const onHeaderPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = popupDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    popupDragRef.current = null;
  }, []);

  // ─ Resize handle ──────────────────────────────────────────────────
  const resizeRef = useRef<{ pointerId: number; start: { x: number; y: number }; startSize: { w: number; h: number } } | null>(null);
  const onResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeRef.current = {
      pointerId: e.pointerId,
      start: { x: e.clientX, y: e.clientY },
      startSize: { ...size },
    };
  }, [size]);
  const onResizePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== e.pointerId) return;
    const dx = e.clientX - r.start.x;
    const dy = e.clientY - r.start.y;
    const nextW = Math.max(MIN_POPUP_W, Math.min(window.innerWidth - pos.x - 8, r.startSize.w + dx));
    const nextH = Math.max(MIN_POPUP_H, Math.min(window.innerHeight - pos.y - 8, r.startSize.h + dy));
    setSize({ w: nextW, h: nextH });
  }, [pos]);
  const onResizePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    resizeRef.current = null;
  }, []);

  // ─ Render ─────────────────────────────────────────────────────────
  const handlePositions = points.map((p) => worldToPx(p[0], p[2]));
  const pathD = handlePositions
    .map((h, i) => `${i === 0 ? 'M' : 'L'}${h.px},${h.py}`)
    .join(' ');

  return createPortal(
    <div
      ref={popupRef}
      className="sedon-pointlist-popup"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
      tabIndex={0}
      onKeyDown={onPopupKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className="sedon-pointlist-header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
      >
        <span>{value.length} points · {worldSize[0]}×{worldSize[1]}m · {selection.size} selected</span>
        <button
          type="button"
          className="sedon-pointlist-close"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
          aria-label="Close"
        >×</button>
      </div>
      <div
        className="sedon-pointlist-canvas"
        style={{ width: canvasW, height: canvasH }}
      >
        {gpu && texture ? (
          <div className="sedon-pointlist-backdrop">
            <TexturePreview device={gpu.device} value={texture} width={canvasW} height={canvasH} />
          </div>
        ) : (
          <div className="sedon-pointlist-backdrop sedon-pointlist-backdrop--empty" />
        )}
        <svg
          ref={svgRef}
          className="sedon-pointlist-svg"
          width={canvasW}
          height={canvasH}
          viewBox={`0 0 ${canvasW} ${canvasH}`}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
        >
          {/* Centre crosshair so 'world 0,0' is unambiguous. */}
          <line x1={canvasW / 2} y1={0} x2={canvasW / 2} y2={canvasH} className="sedon-pointlist-axis" />
          <line x1={0} y1={canvasH / 2} x2={canvasW} y2={canvasH / 2} className="sedon-pointlist-axis" />
          {/* Segment lines. Two passes: a thick invisible hit-target
              that catches clicks for insert-between, and a thin
              visible stroke that doesn't intercept (pointer-events
              none) so handles take priority. */}
          {handlePositions.map((h, i) => {
            const next = handlePositions[i + 1];
            if (!next) return null;
            return (
              <line
                key={`hit-${i}`}
                x1={h.px} y1={h.py} x2={next.px} y2={next.py}
                className="sedon-pointlist-segment-hit"
                onPointerDown={(e) => onSegmentPointerDown(i, e)}
              />
            );
          })}
          {pathD && (
            <path d={pathD} className="sedon-pointlist-segments" />
          )}
          {handlePositions.map((h, i) => (
            <circle
              key={i}
              cx={h.px}
              cy={h.py}
              r={7}
              className={
                'sedon-pointlist-handle'
                + (selection.has(i) ? ' sedon-pointlist-handle--selected' : '')
                + (handleDrag?.pointerId !== undefined && selection.has(i) ? ' sedon-pointlist-handle--dragging' : '')
              }
              onPointerDown={(e) => onHandlePointerDown(i, e)}
              onPointerMove={onHandlePointerMove}
              onPointerUp={onHandlePointerUp}
              onContextMenu={(e) => onHandleContextMenu(i, e)}
            >
              <title>{`#${i} (${points[i]![0].toFixed(2)}, ${points[i]![2].toFixed(2)})\nclick to select, shift-click to add, drag to move, right-click to delete`}</title>
            </circle>
          ))}
          {marquee && (
            <rect
              x={Math.min(marquee.startPx.x, marquee.currentPx.x)}
              y={Math.min(marquee.startPx.y, marquee.currentPx.y)}
              width={Math.abs(marquee.currentPx.x - marquee.startPx.x)}
              height={Math.abs(marquee.currentPx.y - marquee.startPx.y)}
              className="sedon-pointlist-marquee"
            />
          )}
        </svg>
      </div>
      <div className="sedon-pointlist-footer">
        click=add · drag=marquee · ⇧+click=toggle · ⌘C/⌘V · Del=remove
      </div>
      <div
        className="sedon-pointlist-resize"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        title="Drag to resize"
      />
    </div>,
    document.body,
  );
}
