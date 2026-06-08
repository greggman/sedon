import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUpstreamOutput, useCanvasNode } from '../canvas-data.js';
import { useRegistry } from '../registry.js';
import { useEditorStore } from '../store.js';
import { acquireGpuDevice, type GpuDevice } from '../../render/device.js';
import { TexturePreview } from '../texture-preview.js';
import type { Texture2DValue } from '../../core/resources.js';
import type { Point } from '../../nodes/point-list.js';
import {
  HANDLE_ALIGNED,
  HANDLE_AUTO,
  HANDLE_CORNER,
  HANDLE_FREE,
  autoHandleDeltas,
  readCurve2DPoints,
  sampleCurve2D,
} from '../../render/curve-2d.js';

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

// Drag-state for Bezier tangent handles (curve-2d only). One handle
// per anchor side (left / right) per selected FREE / ALIGNED anchor.
// Drag updates the corresponding tuple slots 3..6; on commit the
// onChange fires once (single undo entry like anchor drag).
interface TangentDrag {
  pointerId: number;
  anchorIdx: number;
  side: 'left' | 'right';
  // Snapshot of `value` at drag-start so we don't compound moves with
  // earlier in-flight state during the drag.
  startPoints: Point[];
  // Pointer position at drag-start in canvas px.
  startPx: { x: number; y: number };
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
  const [tangentDrag, setTangentDrag] = useState<TangentDrag | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  // Pointer-down state on the SVG: a click that hasn't yet moved past
  // the drag threshold. On pointerup without movement → add a point.
  const pendingClickRef = useRef<{ pointerId: number; x: number; y: number; shift: boolean } | null>(null);

  // Pull `world_size` from the node's inputValues OR — when the user
  // hasn't overridden it — from the NodeDef's `world_size` input's
  // declared default. Falling straight through to a hardcoded 40×40
  // made nodes whose authoring scale is sub-metre (curve-2d profiles
  // for furniture) invisible in the editor.
  const view = useCanvasNode(panelId, nodeId);
  const registry = useRegistry();
  const nodeDef = useMemo(
    () => (view?.node ? registry.get(view.node.kind) : undefined),
    [view, registry],
  );
  const worldSize = useMemo<[number, number]>(() => {
    const raw = view?.node.inputValues?.world_size;
    if (Array.isArray(raw) && typeof raw[0] === 'number' && typeof raw[1] === 'number') {
      return [raw[0], raw[1]];
    }
    const defDefault = nodeDef?.inputs.find((i) => i.name === 'world_size')?.default;
    if (Array.isArray(defDefault) && typeof defDefault[0] === 'number' && typeof defDefault[1] === 'number') {
      return [defDefault[0], defDefault[1]];
    }
    return [40, 40];
  }, [view, nodeDef]);
  // The point-list editor's vertical axis defaults to Y-DOWN (terrain-
  // path convention: top of canvas = far Z). curve-2d wants Y-UP
  // (top of canvas = top of the candlestick) — the input def can opt
  // in via `flipY` and we mirror the vertical mapping below.
  const flipY = useMemo(
    () => nodeDef?.inputs.find((i) => i.widget === 'point-list')?.flipY === true,
    [nodeDef],
  );
  // Opt-in: when the input def sets `bezierHandles`, the editor reads
  // each anchor's per-point handle type from tuple slot 1 (0=AUTO,
  // 1=CORNER, 2=FREE, 3=ALIGNED) and its left/right tangent deltas
  // from slots 3..6. The displayed curve is sampled through the
  // bezier so handle drags affect the visible shape, and selected
  // FREE/ALIGNED anchors render their two draggable tangent dots.
  const bezierHandles = useMemo(
    () => nodeDef?.inputs.find((i) => i.widget === 'point-list')?.bezierHandles === true,
    [nodeDef],
  );

  // Live upstream Texture2D for the backdrop.
  const upstream = useUpstreamOutput(panelId, nodeId, 'preview_texture');
  const texture = isTexture2D(upstream) ? upstream : null;

  const [gpu, setGpu] = useState<GpuDevice | null>(null);
  useEffect(() => { void acquireGpuDevice().then(setGpu); }, []);

  // Canvas dimensions derived from popup size minus chrome.
  const canvasW = Math.max(64, size.w - PADDING * 2);
  const canvasH = Math.max(64, size.h - HEADER_H - FOOTER_H - PADDING * 2);

  // View transform on top of the world↔canvas mapping. `viewZoom` is
  // a uniform scale (>1 = zoomed in), `viewOffset` is a screen-pixel
  // pan applied AFTER scaling. The "natural" un-transformed mapping
  // (zoom=1, offset=0,0) puts world (0,0) at the canvas centre with
  // worldSize[0]×worldSize[1] of world spanning the canvas — same as
  // before zoom/pan were added. Wheel rotates → cursor-centred zoom;
  // space-drag or middle-button drag → pan.
  const [viewZoom, setViewZoom] = useState(1);
  const [viewOffset, setViewOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const resetView = useCallback(() => {
    setViewZoom(1);
    setViewOffset({ x: 0, y: 0 });
  }, []);
  // "Show segment lines" toggle. Lines are meaningful for path / spline
  // authoring (terrain roads, lathe profiles) but read as random
  // spaghetti for scatter point lists (city building / lamp / car
  // positions, where the point ORDER is incidental). Default true to
  // match historical behavior; the footer button flips it. In bezier
  // mode (curve-2d) the toggle is ignored — the curve IS the output.
  const [showLines, setShowLines] = useState(true);

  // "Fit all" — frames every point in the current `value` with a small
  // pixel-margin of breathing room. Solves "I opened a 500-point city
  // scatter and see nothing" — the natural 40×40m canvas can't show
  // points hundreds of metres apart without manual zoom.
  // (Reads `value` and the mapping params; declared further down so
  // pxToWorld/worldToPx are unaffected.)

  // Pixel ↔ world mapping. World origin at canvas centre; X grows right.
  // Vertical axis: terrain-path mode (default) has Z growing DOWN the
  // screen (top = -Z, bottom = +Z) matching texture V=0 at the top;
  // curve-2d mode (`flipY`) has Y growing UP the screen (top = +Y,
  // bottom = -Y) matching the lathe's world Y-up orientation.
  // The view transform is composed on top: screen = baseScreen * zoom + offset.
  const pxToWorld = useCallback(
    (px: number, py: number): { x: number; z: number } => {
      const ux = (px - viewOffset.x) / viewZoom;
      const uy = (py - viewOffset.y) / viewZoom;
      const vy = uy / canvasH - 0.5;
      return {
        x: (ux / canvasW - 0.5) * worldSize[0],
        z: (flipY ? -vy : vy) * worldSize[1],
      };
    },
    [worldSize, canvasW, canvasH, viewZoom, viewOffset, flipY],
  );
  const worldToPx = useCallback(
    (x: number, z: number): { px: number; py: number } => {
      const ux = (x / worldSize[0] + 0.5) * canvasW;
      const vy = flipY ? -z / worldSize[1] + 0.5 : z / worldSize[1] + 0.5;
      const uy = vy * canvasH;
      return {
        px: ux * viewZoom + viewOffset.x,
        py: uy * viewZoom + viewOffset.y,
      };
    },
    [worldSize, canvasW, canvasH, viewZoom, viewOffset, flipY],
  );

  const eventToCanvasPx = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  // Frame all points: pick (zoom, offset) so every point fits inside
  // the canvas with a 10% margin. Empty list → reset to defaults.
  // Inverse of worldToPx for a chosen (zoom, offset) — see the
  // derivation in worldToPx above.
  const fitView = useCallback(() => {
    if (value.length === 0) {
      setViewZoom(1);
      setViewOffset({ x: 0, y: 0 });
      return;
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of value) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[2] < minZ) minZ = p[2];
      if (p[2] > maxZ) maxZ = p[2];
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    // Span — use a small floor so a single point doesn't try to fit at
    // infinite zoom. 1m floor matches the editor's typical click-add
    // granularity.
    const spanX = Math.max(1, maxX - minX);
    const spanZ = Math.max(1, maxZ - minZ);
    // worldSize[0]/spanX is the zoom that EXACTLY fits the X extent;
    // dividing by 1.1 gives a 10% margin on each side. min() so the
    // tighter axis decides.
    const fit = Math.min(worldSize[0] / spanX, worldSize[1] / spanZ) / 1.1;
    const newZoom = Math.min(20, Math.max(0.005, fit));
    // Offset to put (cx, cz) at the canvas centre.
    const ux = (cx / worldSize[0] + 0.5) * canvasW;
    const vy = flipY ? -cz / worldSize[1] + 0.5 : cz / worldSize[1] + 0.5;
    const uy = vy * canvasH;
    setViewZoom(newZoom);
    setViewOffset({
      x: canvasW / 2 - ux * newZoom,
      y: canvasH / 2 - uy * newZoom,
    });
  }, [value, worldSize, canvasW, canvasH, flipY]);

  // Displayed points: during a handle-drag, the selected points are
  // translated by the live delta; everything else is unchanged. Commit
  // fires on pointerup as a single onChange. The drag-time positions
  // live in `draggedPoints` so each pointermove can update them
  // without going through React's state-batching of the parent.
  const [draggedPoints, setDraggedPoints] = useState<Point[] | null>(null);
  const points = draggedPoints ?? value;

  // Whether the curve is closed (curve-2d only). Read off the node's
  // inputValues so the editor shows the wrap-around segment + treats
  // index 0's neighbours as wraparound for AUTO-tangent computation.
  const closed = bezierHandles && view?.node.inputValues?.closed === true;

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
      // Spread `...p.slice(3)` to preserve any trailing per-anchor
      // metadata (e.g. curve-2d's Bezier handle deltas) that the
      // existing point's tuple carries beyond `[x, y, z]`.
      const inserted = moduleClipboard.points.map((p) => [p[0] + offsetWorld, p[1], p[2] + offsetWorld, ...p.slice(3)] as Point);
      const baseLen = value.length;
      const next = [...value, ...inserted];
      onChange(next, COMMIT_OPTS);
      const newSel = new Set<number>();
      for (let i = 0; i < inserted.length; i++) newSel.add(baseLen + i);
      setSelection(newSel);
      return;
    }
    // Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y = redo.
    // Handled here (not just at the canvas window-level) so the popup
    // works in any host — including doc pages, which don't mount the
    // main NodeCanvas and therefore have no other undo binding.
    // stopPropagation prevents the canvas's window-level handler from
    // double-firing when both are mounted.
    if (mod && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      useEditorStore.getState().undo();
      return;
    }
    if (mod && (((e.key === 'z' || e.key === 'Z') && e.shiftKey) || e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      e.stopPropagation();
      useEditorStore.getState().redo();
      return;
    }
    // T cycles handle type for every selected anchor (curve-2d). The
    // cycle decreases smoothness on each press:
    //   AUTO → ALIGNED → FREE → CORNER → AUTO
    // AUTO and ALIGNED both produce smooth curves (AUTO infers
    // tangents from neighbours, ALIGNED uses user-driven but
    // collinear handles); FREE allows independent handles
    // (controllable kinks); CORNER zeroes both handles for a hard
    // kink. AUTO → ALIGNED bakes the on-the-fly Catmull-Rom handles
    // into stored deltas so the curve shape doesn't pop the moment
    // the anchor becomes user-driven.
    if (bezierHandles && !mod && (e.key === 't' || e.key === 'T')) {
      if (selection.size === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const n = value.length;
      const next: Point[] = value.map((p, i) => {
        if (!selection.has(i)) return p;
        const rawType = typeof p[1] === 'number' ? p[1] : HANDLE_AUTO;
        const cur = rawType === HANDLE_CORNER || rawType === HANDLE_FREE || rawType === HANDLE_ALIGNED
          ? rawType
          : HANDLE_AUTO;
        const nextType = cur === HANDLE_AUTO ? HANDLE_ALIGNED
          : cur === HANDLE_ALIGNED ? HANDLE_FREE
          : cur === HANDLE_FREE ? HANDLE_CORNER
          : HANDLE_AUTO;
        // Bake AUTO handles into deltas when promoting out of AUTO so
        // the curve doesn't jump. The stored deltas are harmless in
        // CORNER / AUTO (the sampler ignores them) and resurface when
        // the user cycles back to ALIGNED / FREE — cheap continuity.
        let lDx = typeof p[3] === 'number' ? p[3] : 0;
        let lDy = typeof p[4] === 'number' ? p[4] : 0;
        let rDx = typeof p[5] === 'number' ? p[5] : 0;
        let rDy = typeof p[6] === 'number' ? p[6] : 0;
        if (cur === HANDLE_AUTO) {
          const prev = closed
            ? value[(i - 1 + n) % n]!
            : value[Math.max(0, i - 1)]!;
          const nxt = closed
            ? value[(i + 1) % n]!
            : value[Math.min(n - 1, i + 1)]!;
          const d = autoHandleDeltas(
            { x: prev[0], y: prev[2] },
            { x: nxt[0], y: nxt[2] },
          );
          lDx = d.leftDx; lDy = d.leftDy; rDx = d.rightDx; rDy = d.rightDy;
        }
        return [p[0], nextType, p[2], lDx, lDy, rDx, rDy] as Point;
      });
      onChange(next, COMMIT_OPTS);
      return;
    }
  }, [onClose, selection, value, onChange, worldSize, bezierHandles, closed]);

  // ─ View transform: zoom (wheel) + pan (space-drag / middle-drag) ─

  // Whether the space key is held — drives whether a left-button drag
  // on the canvas pans the view rather than adding / marquee-selecting.
  // Tracked at the window level so it works regardless of which inner
  // element has focus inside the popup.
  const [spaceHeld, setSpaceHeld] = useState(false);
  useEffect(() => {
    function down(e: KeyboardEvent) {
      // Don't capture space when the user is typing in an input
      // (e.g. the editor doesn't have any today, but future ones
      // might — the test keeps the affordance from going wrong if
      // someone adds a text field later).
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.code === 'Space') {
        e.preventDefault(); // stop page-scroll
        setSpaceHeld(true);
      }
    }
    function up(e: KeyboardEvent) {
      if (e.code === 'Space') setSpaceHeld(false);
    }
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Active pan drag. Tracks pointer id + the starting cursor position
  // + the offset value at drag-start, so we can update offset = start
  // + (cursorNow - cursorAtStart) each move.
  const [panState, setPanState] = useState<{
    pointerId: number;
    startPx: { x: number; y: number };
    startOffset: { x: number; y: number };
  } | null>(null);

  // Wheel handler: zoom centred on the cursor. The world coord under
  // the cursor stays put through the zoom change, so the user can
  // "magnify" a specific spot without it sliding off-screen.
  //
  // Attached via native addEventListener with `passive: false` rather
  // than React's onWheel — React's synthetic wheel listener is passive
  // by default (so e.preventDefault() throws), and we need to
  // preventDefault to keep the page from scrolling under the popup
  // while the cursor is over the SVG.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = svg.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;
      const factor = (e.deltaY < 0 ? 1.01 : 1 / 1.01);
      setViewZoom((prevZoom) => {
        // Lower bound at 0.005 so a 40×40m canvas can fit point lists
        // hundreds of metres across (city scatters span ~1100m, so the
        // worst case needs ≈30× zoom-out). Upper bound at 20× matches
        // the wheel sensitivity for path-detail work.
        const newZoom = Math.min(20, Math.max(0.005, prevZoom * factor));
        const ratio = newZoom / prevZoom;
        // Solve for the new offset such that the world coord currently
        // under the cursor still maps to the cursor position.
        //   newOffset = cursor - (cursor - prevOffset) * (newZoom / prevZoom)
        setViewOffset((prevOff) => ({
          x: cursorX - (cursorX - prevOff.x) * ratio,
          y: cursorY - (cursorY - prevOff.y) * ratio,
        }));
        return newZoom;
      });
    };
    svg.addEventListener('wheel', handler, { passive: false });
    return () => svg.removeEventListener('wheel', handler);
  }, []);

  // ─ SVG canvas interactions ────────────────────────────────────────

  // Mouse-down on the SVG (empty area). Could become any of:
  //   • Middle button OR (left + space)        → pan the view.
  //   • Quick click (no movement, no shift)    → add a point.
  //   • Drag (movement past threshold)         → marquee.
  //   • Click with shift, no movement          → no-op.
  const onCanvasPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (e.target !== e.currentTarget) return; // a handle or segment caught it
    const isPan = e.button === 1 || (e.button === 0 && spaceHeld);
    if (isPan) {
      e.preventDefault();
      e.stopPropagation();
      const { x, y } = eventToCanvasPx(e.clientX, e.clientY);
      setPanState({
        pointerId: e.pointerId,
        startPx: { x, y },
        startOffset: { ...viewOffset },
      });
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    e.stopPropagation();
    const { x, y } = eventToCanvasPx(e.clientX, e.clientY);
    pendingClickRef.current = { pointerId: e.pointerId, x, y, shift: e.shiftKey };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [eventToCanvasPx, spaceHeld, viewOffset]);

  const onCanvasPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (panState && panState.pointerId === e.pointerId) {
      const { x, y } = eventToCanvasPx(e.clientX, e.clientY);
      setViewOffset({
        x: panState.startOffset.x + (x - panState.startPx.x),
        y: panState.startOffset.y + (y - panState.startPx.y),
      });
      return;
    }
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
  }, [marquee, selection, eventToCanvasPx, panState]);

  const onCanvasPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (panState && panState.pointerId === e.pointerId) {
      e.currentTarget.releasePointerCapture(e.pointerId);
      setPanState(null);
      return;
    }
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
  }, [marquee, value, onChange, pxToWorld, worldToPx, panState]);

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
      // Divide by zoom so a 100-px drag at 2× zoom moves the point
      // half a world unit, not a full one. Otherwise drags get
      // twitchy in zoomed-in views and sluggish in zoomed-out ones.
      const dxWorld = (dxPx / (canvasW * viewZoom)) * worldSize[0];
      // In flipY mode the vertical axis is inverted, so dragging the
      // pointer DOWN should DECREASE world Y, not increase it.
      const dzWorld = (dyPx / (canvasH * viewZoom)) * worldSize[1] * (flipY ? -1 : 1);
      const next = handleDrag.startPoints.map((p, i) =>
        // Preserve trailing slots (curve-2d handle deltas) — they
        // belong to this anchor and don't change when the anchor's
        // position changes.
        selection.has(i) ? ([p[0] + dxWorld, p[1], p[2] + dzWorld, ...p.slice(3)] as Point) : p,
      );
      setDraggedPoints(next);
    },
    [handleDrag, selection, eventToCanvasPx, canvasW, canvasH, worldSize, viewZoom, flipY],
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

  // ─ Bezier tangent-handle drag (curve-2d only) ─────────────────────
  // Convert a pointer-px delta into a world-space delta, matching the
  // anchor-drag math (zoom-aware, flipY-aware).
  const pxDeltaToWorld = useCallback((dxPx: number, dyPx: number) => {
    const dxWorld = (dxPx / (canvasW * viewZoom)) * worldSize[0];
    const dzWorld = (dyPx / (canvasH * viewZoom)) * worldSize[1] * (flipY ? -1 : 1);
    return { dxWorld, dzWorld };
  }, [canvasW, canvasH, viewZoom, worldSize, flipY]);

  const onTangentPointerDown = useCallback(
    (idx: number, side: 'left' | 'right', e: React.PointerEvent<SVGCircleElement>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      const { x, y } = eventToCanvasPx(e.clientX, e.clientY);
      setTangentDrag({
        pointerId: e.pointerId,
        anchorIdx: idx,
        side,
        startPx: { x, y },
        startPoints: value.map((p) => [...p] as Point),
      });
    },
    [value, eventToCanvasPx],
  );

  const onTangentPointerMove = useCallback(
    (e: React.PointerEvent<SVGCircleElement>) => {
      if (!tangentDrag || tangentDrag.pointerId !== e.pointerId) return;
      const { x, y } = eventToCanvasPx(e.clientX, e.clientY);
      const { dxWorld, dzWorld } = pxDeltaToWorld(
        x - tangentDrag.startPx.x,
        y - tangentDrag.startPx.y,
      );
      const idx = tangentDrag.anchorIdx;
      const start = tangentDrag.startPoints[idx];
      if (!start) return;
      // For AUTO-mode anchors, dragging a handle PROMOTES the anchor
      // to ALIGNED — Illustrator / Affinity convention: touching a
      // smooth point's handle keeps it smooth (the two handles stay
      // collinear automatically), and breaking smoothness is an
      // explicit act (T-cycle to FREE). We bake the current AUTO
      // handle deltas as the starting values so the curve shape
      // doesn't pop on the first pointermove. ALIGNED stays ALIGNED;
      // FREE stays FREE; CORNER doesn't render handles in the first
      // place, so it never reaches this code.
      const rawType = typeof start[1] === 'number' ? start[1] : HANDLE_AUTO;
      let baseType = rawType === HANDLE_CORNER || rawType === HANDLE_FREE || rawType === HANDLE_ALIGNED
        ? rawType
        : HANDLE_AUTO;
      let baseL: { dx: number; dy: number };
      let baseR: { dx: number; dy: number };
      if (baseType === HANDLE_AUTO) {
        const n = tangentDrag.startPoints.length;
        const prev = closed
          ? tangentDrag.startPoints[(idx - 1 + n) % n]!
          : tangentDrag.startPoints[Math.max(0, idx - 1)]!;
        const next = closed
          ? tangentDrag.startPoints[(idx + 1) % n]!
          : tangentDrag.startPoints[Math.min(n - 1, idx + 1)]!;
        const auto = autoHandleDeltas(
          { x: prev[0], y: prev[2] },
          { x: next[0], y: next[2] },
        );
        baseL = { dx: auto.leftDx, dy: auto.leftDy };
        baseR = { dx: auto.rightDx, dy: auto.rightDy };
        // Promote to ALIGNED — the user is taking control of the
        // tangent direction but the curve stays smooth through the
        // anchor (Illustrator / Affinity convention).
        baseType = HANDLE_ALIGNED;
      } else {
        baseL = {
          dx: typeof start[3] === 'number' ? start[3] : 0,
          dy: typeof start[4] === 'number' ? start[4] : 0,
        };
        baseR = {
          dx: typeof start[5] === 'number' ? start[5] : 0,
          dy: typeof start[6] === 'number' ? start[6] : 0,
        };
      }
      // Apply the drag delta to whichever side the user grabbed.
      let newL = baseL;
      let newR = baseR;
      if (tangentDrag.side === 'left') {
        newL = { dx: baseL.dx + dxWorld, dy: baseL.dy + dzWorld };
        // ALIGNED: keep the OTHER handle collinear, preserving its
        // current length. (Blender's "Aligned" — direction couples,
        // length doesn't.) The right handle's new direction is the
        // opposite of the new left handle's direction.
        if (baseType === HANDLE_ALIGNED) {
          const lLen = Math.hypot(newL.dx, newL.dy);
          if (lLen > 1e-9) {
            const rLen = Math.hypot(baseR.dx, baseR.dy);
            newR = { dx: -newL.dx / lLen * rLen, dy: -newL.dy / lLen * rLen };
          }
        }
      } else {
        newR = { dx: baseR.dx + dxWorld, dy: baseR.dy + dzWorld };
        if (baseType === HANDLE_ALIGNED) {
          const rLen = Math.hypot(newR.dx, newR.dy);
          if (rLen > 1e-9) {
            const lLen = Math.hypot(baseL.dx, baseL.dy);
            newL = { dx: -newR.dx / rLen * lLen, dy: -newR.dy / rLen * lLen };
          }
        }
      }
      const next: Point[] = tangentDrag.startPoints.map((p, i) => {
        if (i !== idx) return p;
        return [p[0], baseType, p[2], newL.dx, newL.dy, newR.dx, newR.dy] as Point;
      });
      setDraggedPoints(next);
    },
    [tangentDrag, eventToCanvasPx, pxDeltaToWorld, closed],
  );

  const onTangentPointerUp = useCallback(
    (e: React.PointerEvent<SVGCircleElement>) => {
      if (!tangentDrag || tangentDrag.pointerId !== e.pointerId) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      if (draggedPoints) onChange(draggedPoints, COMMIT_OPTS);
      setDraggedPoints(null);
      setTangentDrag(null);
    },
    [tangentDrag, draggedPoints, onChange],
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
  // Bezier curve mode: sample the curve through the bezier so the
  // displayed line matches the actual output (handles affect the
  // visible shape). Terrain-path mode keeps the original straight-
  // segment polyline — same as before bezier mode was added. `closed`
  // is hoisted above the drag handlers so they can wrap neighbour
  // lookups for AUTO-tangent computation.
  const pathD = useMemo(() => {
    if (bezierHandles) {
      const parsed = readCurve2DPoints(points);
      if (parsed.length < 2) {
        // Nothing to draw — a single anchor renders only as a dot.
        return '';
      }
      const samples = sampleCurve2D(parsed, { samplesPerSegment: 24, closed });
      const parts: string[] = [];
      const n = samples.length / 3;
      for (let i = 0; i < n; i++) {
        const wx = samples[i * 3]!;
        const wy = samples[i * 3 + 1]!;
        const { px, py } = worldToPx(wx, wy);
        parts.push(`${i === 0 ? 'M' : 'L'}${px},${py}`);
      }
      if (closed) parts.push('Z');
      return parts.join(' ');
    }
    return handlePositions
      .map((h, i) => `${i === 0 ? 'M' : 'L'}${h.px},${h.py}`)
      .join(' ');
    // We depend on `points` (which already covers x/y/handleType/deltas
    // and changes whenever anchors move), `worldToPx` (zoom/pan), and
    // `closed`. `handlePositions` is recomputed every render so it's
    // safe to read from the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, worldToPx, closed, bezierHandles]);

  // For bezierHandles mode: compute per-anchor resolved handle deltas
  // for every selected anchor that needs handles drawn (FREE / ALIGNED
  // use the stored deltas; AUTO points get a faint live preview using
  // the same Catmull-Rom formula the sampler uses; CORNER is omitted).
  // Each entry is `{ idx, type, anchorPx, leftPx, rightPx }` with
  // anchorPx / leftPx / rightPx already in screen-pixel space.
  type HandleVis = {
    idx: number;
    type: number;
    anchorPx: { px: number; py: number };
    leftPx: { px: number; py: number };
    rightPx: { px: number; py: number };
  };
  const handleVis = useMemo<HandleVis[]>(() => {
    if (!bezierHandles) return [];
    const n = points.length;
    if (n === 0) return [];
    const out: HandleVis[] = [];
    for (const idx of selection) {
      if (idx < 0 || idx >= n) continue;
      const p = points[idx]!;
      const rawType = typeof p[1] === 'number' ? p[1] : HANDLE_AUTO;
      const type = rawType === HANDLE_CORNER || rawType === HANDLE_FREE || rawType === HANDLE_ALIGNED
        ? rawType
        : HANDLE_AUTO;
      if (type === HANDLE_CORNER) continue;
      let lDx: number, lDy: number, rDx: number, rDy: number;
      if (type === HANDLE_AUTO) {
        // Live preview: same math as the sampler. Endpoints of an
        // open curve clamp to themselves, so the AUTO preview is a
        // zero-length handle at the very first / last point — which
        // visually disappears, matching the sampler's straight-line-
        // into-endpoint behavior.
        const prev = closed
          ? points[(idx - 1 + n) % n]!
          : points[Math.max(0, idx - 1)]!;
        const next = closed
          ? points[(idx + 1) % n]!
          : points[Math.min(n - 1, idx + 1)]!;
        const d = autoHandleDeltas(
          { x: prev[0], y: prev[2] },
          { x: next[0], y: next[2] },
        );
        lDx = d.leftDx; lDy = d.leftDy; rDx = d.rightDx; rDy = d.rightDy;
      } else {
        lDx = (typeof p[3] === 'number' ? p[3] : 0);
        lDy = (typeof p[4] === 'number' ? p[4] : 0);
        rDx = (typeof p[5] === 'number' ? p[5] : 0);
        rDy = (typeof p[6] === 'number' ? p[6] : 0);
      }
      out.push({
        idx,
        type,
        anchorPx: worldToPx(p[0], p[2]),
        leftPx: worldToPx(p[0] + lDx, p[2] + lDy),
        rightPx: worldToPx(p[0] + rDx, p[2] + rDy),
      });
    }
    return out;
  }, [bezierHandles, points, selection, worldToPx, closed]);

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
          <div
            className="sedon-pointlist-backdrop"
            // Apply the view transform to the texture backdrop too, so
            // the heightfield / preview image zooms + pans in lockstep
            // with the handles. `transform-origin: 0 0` so the math
            // matches `worldToPx` (which scales around the canvas top-
            // left, then offsets).
            style={{
              transform: `translate(${viewOffset.x}px, ${viewOffset.y}px) scale(${viewZoom})`,
              transformOrigin: '0 0',
            }}
          >
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
          // Make the SVG keyboard-focusable so the wheel handler stays
          // active without the user clicking first — pan via space
          // toggles based on window-level keydown; zoom needs a wheel
          // event with the pointer inside the SVG, which it gets even
          // without focus. (Cursor changes when space is held to hint
          // pan-mode is available.)
          style={spaceHeld || panState ? { cursor: 'grab' } : undefined}
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
              none) so handles take priority. Hidden when `showLines`
              is off and we're not in bezier mode — scatter point
              lists don't have meaningful segment ordering.
              The bezier curve itself stays visible regardless of the
              toggle because it IS the node's output. */}
          {(showLines || bezierHandles) && handlePositions.map((h, i) => {
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
          {pathD && (showLines || bezierHandles) && (
            <path d={pathD} className="sedon-pointlist-segments" />
          )}
          {/* Bezier tangent handles for selected anchors (curve-2d).
              Rendered BEFORE the anchors so the anchor circle sits on
              top when they overlap. Each anchor contributes up to two
              draggable dots + a thin line back to its anchor. */}
          {handleVis.map((v) => (
            <g key={`tan-${v.idx}`}>
              <line
                x1={v.anchorPx.px} y1={v.anchorPx.py}
                x2={v.leftPx.px}    y2={v.leftPx.py}
                className={'sedon-pointlist-tangent-line' + (v.type === HANDLE_AUTO ? ' sedon-pointlist-tangent-line--auto' : '')}
              />
              <line
                x1={v.anchorPx.px} y1={v.anchorPx.py}
                x2={v.rightPx.px}   y2={v.rightPx.py}
                className={'sedon-pointlist-tangent-line' + (v.type === HANDLE_AUTO ? ' sedon-pointlist-tangent-line--auto' : '')}
              />
              <circle
                cx={v.leftPx.px} cy={v.leftPx.py} r={5}
                className={'sedon-pointlist-tangent' + (v.type === HANDLE_AUTO ? ' sedon-pointlist-tangent--auto' : '')}
                onPointerDown={(e) => onTangentPointerDown(v.idx, 'left', e)}
                onPointerMove={onTangentPointerMove}
                onPointerUp={onTangentPointerUp}
              >
                <title>left handle · drag to shape the incoming tangent</title>
              </circle>
              <circle
                cx={v.rightPx.px} cy={v.rightPx.py} r={5}
                className={'sedon-pointlist-tangent' + (v.type === HANDLE_AUTO ? ' sedon-pointlist-tangent--auto' : '')}
                onPointerDown={(e) => onTangentPointerDown(v.idx, 'right', e)}
                onPointerMove={onTangentPointerMove}
                onPointerUp={onTangentPointerUp}
              >
                <title>right handle · drag to shape the outgoing tangent</title>
              </circle>
            </g>
          ))}
          {handlePositions.map((h, i) => {
            const rawType = bezierHandles && typeof points[i]![1] === 'number' ? points[i]![1] as number : HANDLE_AUTO;
            const typeClass = !bezierHandles ? ''
              : rawType === HANDLE_CORNER ? ' sedon-pointlist-handle--corner'
              : rawType === HANDLE_FREE ? ' sedon-pointlist-handle--free'
              : rawType === HANDLE_ALIGNED ? ' sedon-pointlist-handle--aligned'
              : ' sedon-pointlist-handle--auto';
            return (
              <circle
                key={i}
                cx={h.px}
                cy={h.py}
                r={7}
                className={
                  'sedon-pointlist-handle'
                  + typeClass
                  + (selection.has(i) ? ' sedon-pointlist-handle--selected' : '')
                  + (handleDrag?.pointerId !== undefined && selection.has(i) ? ' sedon-pointlist-handle--dragging' : '')
                }
                onPointerDown={(e) => onHandlePointerDown(i, e)}
                onPointerMove={onHandlePointerMove}
                onPointerUp={onHandlePointerUp}
                onContextMenu={(e) => onHandleContextMenu(i, e)}
              >
                <title>{
                  bezierHandles
                    ? `#${i} (${points[i]![0].toFixed(2)}, ${points[i]![2].toFixed(2)}) · ${rawType === HANDLE_CORNER ? 'corner' : rawType === HANDLE_FREE ? 'free' : rawType === HANDLE_ALIGNED ? 'aligned' : 'auto'}\nT=cycle handle type, drag=move, right-click=delete`
                    : `#${i} (${points[i]![0].toFixed(2)}, ${points[i]![2].toFixed(2)})\nclick to select, shift-click to add, drag to move, right-click to delete`
                }</title>
              </circle>
            );
          })}
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
        <span>{bezierHandles
          ? 'click=add · drag=marquee · ⇧+click=toggle · T=cycle handle · ⌘C/⌘V · Del=remove · wheel=zoom · space-drag=pan'
          : 'click=add · drag=marquee · ⇧+click=toggle · ⌘C/⌘V · Del=remove · wheel=zoom · space-drag=pan'}</span>
        <button
          type="button"
          className="sedon-pointlist-reset-view"
          onClick={fitView}
          onPointerDown={(e) => e.stopPropagation()}
          title="Frame all points in the canvas"
        >
          fit
        </button>
        {!bezierHandles && (
          <button
            type="button"
            className="sedon-pointlist-reset-view"
            onClick={() => setShowLines((v) => !v)}
            onPointerDown={(e) => e.stopPropagation()}
            title="Toggle the segment polyline connecting consecutive points (off when the point order is incidental — scatter, not path)"
          >
            {showLines ? 'lines: on' : 'lines: off'}
          </button>
        )}
        {(viewZoom !== 1 || viewOffset.x !== 0 || viewOffset.y !== 0) && (
          <button
            type="button"
            className="sedon-pointlist-reset-view"
            onClick={resetView}
            onPointerDown={(e) => e.stopPropagation()}
            title="Reset zoom + pan"
          >
            reset ({viewZoom.toFixed(2)}×)
          </button>
        )}
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
