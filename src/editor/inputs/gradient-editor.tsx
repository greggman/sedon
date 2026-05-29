import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GradientStop } from '../../nodes/ramp.js';
import { ColorPicker } from './color-picker.js';

// Two pieces here:
//   • GradientInput — the in-row trigger: a small gradient swatch
//     (over a checkerboard so alpha reads) that opens the popup on
//     click. Same UX shape as ColorInput so the editor's input rows
//     stay uniform-height; the gradient editor's chrome only appears
//     when you ask for it.
//   • GradientPopup — the full editor in a portalled popup: live
//     gradient bar + draggable stop markers. Click bar to add a stop,
//     drag to move, double-click to recolour (via the same RGBA
//     picker as the Color input), Delete to remove (down to 1 stop).

type Rgba = readonly [number, number, number, number];

interface GradientInputProps {
  value: GradientStop[];
  onChange: (next: GradientStop[]) => void;
}

interface GradientPopupProps {
  value: GradientStop[];
  onChange: (next: GradientStop[]) => void;
  onClose: () => void;
  anchorRect: DOMRect;
}

const MIN_STOPS = 1;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function toByte(c: number): number {
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

function rgbaCss(rgba: Rgba): string {
  return `rgba(${toByte(rgba[0])}, ${toByte(rgba[1])}, ${toByte(rgba[2])}, ${rgba[3]})`;
}

// How many intermediate samples we drop between a stop pair when its
// midpoint differs from 0.5. CSS `linear-gradient(...)` is
// piecewise-linear between named stops, so to APPROXIMATE the
// smooth power-curve midpoint remap (see nodes/ramp.ts) we sample
// the curve at N points and emit each as its own colour stop. 5
// inserted samples is enough to read as smooth at typical bar
// widths; cost is a slightly longer CSS string.
const MIDPOINT_PREVIEW_SAMPLES = 5;

// Build the linear-gradient CSS string. Endpoints stay anchored.
// Mirrors the on-GPU LINEAR interpolation mode (Smooth / Constant
// modes still preview as linear here — close enough for authoring).
function gradientCss(stops: GradientStop[]): string {
  if (stops.length === 0) return '#000';
  if (stops.length === 1) return rgbaCss(stops[0]!.color);
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]!;
    parts.push(`${rgbaCss(s.color)} ${(s.position * 100).toFixed(2)}%`);
    const next = sorted[i + 1];
    if (!next) continue;
    const m = s.midpoint;
    if (m === undefined || m <= 0 || m >= 1 || m === 0.5) continue;
    // Power-curve remap, same as the eval. exponent k chosen so
    // m^k = 0.5; local ∈ [0, 1] is mapped to local^k before
    // lerping between the bracketing colours.
    const k = Math.log(0.5) / Math.log(m);
    for (let j = 1; j <= MIDPOINT_PREVIEW_SAMPLES; j++) {
      const local = j / (MIDPOINT_PREVIEW_SAMPLES + 1);
      const tCurve = Math.pow(local, k);
      const pos = s.position + local * (next.position - s.position);
      const col: Rgba = [
        s.color[0] + (next.color[0] - s.color[0]) * tCurve,
        s.color[1] + (next.color[1] - s.color[1]) * tCurve,
        s.color[2] + (next.color[2] - s.color[2]) * tCurve,
        s.color[3] + (next.color[3] - s.color[3]) * tCurve,
      ];
      parts.push(`${rgbaCss(col)} ${(pos * 100).toFixed(2)}%`);
    }
  }
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

// Sample the linear-interpolation gradient at parameter `t`, kept
// local so we can compute the "add a stop without changing the
// gradient" colour without importing the eval module.
function sampleLinearAtT(stops: GradientStop[], t: number): Rgba {
  if (stops.length === 0) return [0, 0, 0, 1];
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  if (sorted.length === 1) return sorted[0]!.color;
  if (t <= sorted[0]!.position) return sorted[0]!.color;
  if (t >= sorted[sorted.length - 1]!.position) return sorted[sorted.length - 1]!.color;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (t >= a.position && t <= b.position) {
      const span = b.position - a.position;
      const local = span > 0 ? (t - a.position) / span : 0;
      return [
        a.color[0] + (b.color[0] - a.color[0]) * local,
        a.color[1] + (b.color[1] - a.color[1]) * local,
        a.color[2] + (b.color[2] - a.color[2]) * local,
        a.color[3] + (b.color[3] - a.color[3]) * local,
      ];
    }
  }
  return sorted[sorted.length - 1]!.color;
}

// In-row trigger: a small gradient swatch button. Opening behaviour
// mirrors ColorInput's picker swatch — snapshot the swatch's
// bounding rect on click and hand it to the popup as an anchor.
export function GradientInput({ value, onChange }: GradientInputProps) {
  const [open, setOpen] = useState(false);
  const anchorRectRef = useRef<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const onOpen = useCallback(() => {
    const el = buttonRef.current;
    if (!el) return;
    anchorRectRef.current = el.getBoundingClientRect();
    setOpen(true);
  }, []);

  const onClose = useCallback(() => { setOpen(false); }, []);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="sedon-gradientinput nodrag"
        onClick={onOpen}
        onPointerDown={(e) => { e.stopPropagation(); }}
        aria-label="Edit gradient"
      >
        <span className="sedon-gradientinput-fill" style={{ background: gradientCss(value) }} />
      </button>
      {open && anchorRectRef.current && (
        <GradientPopup
          value={value}
          onChange={onChange}
          onClose={onClose}
          anchorRect={anchorRectRef.current}
        />
      )}
    </>
  );
}

interface DragState {
  /** Drag target. `kind === 'mid'` adjusts the stop's midpoint to the next stop. */
  kind: 'stop' | 'mid';
  stopIndex: number;
  pointerId: number;
}

function GradientPopup({ value, onChange, onClose, anchorRect }: GradientPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<number>(-1);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [pickerStop, setPickerStop] = useState<number | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);

  const sortedStops = useMemo(
    () => [...value].sort((a, b) => a.position - b.position),
    [value],
  );

  // Re-clamp selection if the source array shrinks externally.
  useEffect(() => {
    if (selected >= sortedStops.length) setSelected(-1);
  }, [sortedStops.length, selected]);

  // Click-outside-to-close. The RGBA sub-picker is portalled separately
  // and we skip closing while it's open so picking a colour for a stop
  // doesn't dismiss the gradient editor underneath.
  useEffect(() => {
    function onDocPointerDown(e: PointerEvent) {
      if (pickerStop !== null) return;
      const popup = popupRef.current;
      if (!popup) return;
      if (e.target instanceof Node && popup.contains(e.target)) return;
      onClose();
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => { document.removeEventListener('pointerdown', onDocPointerDown); };
  }, [onClose, pickerStop]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && pickerStop === null) {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => { document.removeEventListener('keydown', onKeyDown, true); };
  }, [onClose, pickerStop]);

  const pointerToT = useCallback((clientX: number): number => {
    const bar = barRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    return clamp01((clientX - rect.left) / rect.width);
  }, []);

  const updateStop = useCallback((idx: number, patch: Partial<GradientStop>) => {
    const next = sortedStops.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    onChange(next);
  }, [sortedStops, onChange]);

  const onBarPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // The bar has an inner fill div that catches every click first,
    // so a `target === currentTarget` check rejected legitimate adds.
    // Markers live in a SIBLING `.sedon-gradient-stops` row (not
    // inside the bar) and stop propagation on their own pointerdown
    // — they never reach this handler — so we don't need to filter
    // here at all.
    e.stopPropagation();
    const t = pointerToT(e.clientX);
    const colour = sampleLinearAtT(sortedStops, t);
    const newStop: GradientStop = {
      position: t,
      color: [colour[0], colour[1], colour[2], colour[3]],
    };
    const next = [...sortedStops, newStop];
    next.sort((a, b) => a.position - b.position);
    onChange(next);
    setSelected(next.indexOf(newStop));
  }, [pointerToT, sortedStops, onChange]);

  const onMarkerPointerDown = useCallback((idx: number, e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSelected(idx);
    setDrag({ kind: 'stop', stopIndex: idx, pointerId: e.pointerId });
  }, []);

  // Mid-point markers: each pair of adjacent stops gets a diamond
  // between them whose horizontal position represents the midpoint
  // (where the 50/50 colour mix happens). The diamond's range is the
  // ENTIRE bar (so users can drag freely); the value is constrained
  // to (0, 1) of the segment between its bracketing stops.
  const onMidPointerDown = useCallback((idx: number, e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSelected(-1);
    setDrag({ kind: 'mid', stopIndex: idx, pointerId: e.pointerId });
  }, []);

  const onMarkerPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.stopPropagation();
    const t = pointerToT(e.clientX);
    if (drag.kind === 'stop') {
      updateStop(drag.stopIndex, { position: t });
    } else {
      // mid: clamp to between the two bracketing stops, store as
      // fraction of the segment (NOT global t).
      const a = sortedStops[drag.stopIndex];
      const b = sortedStops[drag.stopIndex + 1];
      if (!a || !b) return;
      const span = b.position - a.position;
      if (span <= 0) return;
      const local = clamp01((t - a.position) / span);
      // Keep midpoint inside the (0, 1) interior so the remap stays
      // invertible — at 0 or 1 the piecewise mapping collapses.
      const clamped = Math.max(0.02, Math.min(0.98, local));
      updateStop(drag.stopIndex, { midpoint: clamped });
    }
  }, [drag, pointerToT, updateStop, sortedStops]);

  const onMarkerPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    setDrag(null);
  }, [drag]);

  const onMidDoubleClick = useCallback((idx: number, e: React.MouseEvent<HTMLDivElement>) => {
    // Double-click resets midpoint to the linear default (no remap).
    // `exactOptionalPropertyTypes` doesn't accept `{ midpoint: undefined }`
    // as a partial — delete the key by rebuilding the next array with
    // midpoint omitted on this stop.
    e.stopPropagation();
    const next = sortedStops.map((s, i) => {
      if (i !== idx) return s;
      const clone: GradientStop = { position: s.position, color: s.color };
      return clone;
    });
    onChange(next);
  }, [sortedStops, onChange]);

  const onMarkerDoubleClick = useCallback((idx: number, e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    setPickerStop(idx);
    setPickerAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
  }, []);

  const onPickerChange = useCallback((next: Rgba) => {
    if (pickerStop === null) return;
    updateStop(pickerStop, { color: [next[0], next[1], next[2], next[3]] });
  }, [pickerStop, updateStop]);

  const onPickerClose = useCallback(() => {
    setPickerStop(null);
    setPickerAnchor(null);
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected >= 0) {
      if (sortedStops.length <= MIN_STOPS) return;
      e.preventDefault();
      e.stopPropagation();
      const next = sortedStops.filter((_, i) => i !== selected);
      onChange(next);
      setSelected(-1);
    }
  }, [selected, sortedStops, onChange]);

  // Position the popup just below the anchor swatch, clamped to viewport.
  const POPUP_W = 280;
  const POPUP_H = 80;
  const left = Math.min(
    Math.max(8, anchorRect.left),
    window.innerWidth - POPUP_W - 8,
  );
  const top = Math.min(
    anchorRect.bottom + 4,
    window.innerHeight - POPUP_H - 8,
  );

  return createPortal(
    <div
      ref={popupRef}
      className="sedon-gradient-popup"
      style={{ left, top, width: POPUP_W }}
      tabIndex={0}
      onPointerDown={(e) => { e.stopPropagation(); }}
      onClick={(e) => { e.stopPropagation(); }}
      onKeyDown={onKeyDown}
    >
      <div className="sedon-gradient-editor">
        <div
          ref={barRef}
          className="sedon-gradient-bar"
          onPointerDown={onBarPointerDown}
        >
          <div className="sedon-gradient-bar-fill" style={{ background: gradientCss(sortedStops) }} />
        </div>
        <div className="sedon-gradient-stops">
          {sortedStops.map((stop, idx) => {
            const next = sortedStops[idx + 1];
            // Per-pair midpoint diamond. Position defaults to the
            // geometric middle (mid = 0.5) and slides toward either
            // end as the user drags. Only rendered for non-final
            // stops; the last stop has nothing to mix with.
            const mid = stop.midpoint ?? 0.5;
            const midPos = next ? stop.position + mid * (next.position - stop.position) : null;
            return (
              <div key={idx} style={{ display: 'contents' }}>
                <div
                  className={
                    'sedon-gradient-stop' + (idx === selected ? ' sedon-gradient-stop--selected' : '')
                  }
                  style={{ left: `${stop.position * 100}%` }}
                  onPointerDown={(e) => onMarkerPointerDown(idx, e)}
                  onPointerMove={onMarkerPointerMove}
                  onPointerUp={onMarkerPointerUp}
                  onDoubleClick={(e) => onMarkerDoubleClick(idx, e)}
                  title={`${(stop.position * 100).toFixed(1)}% — double-click to recolour, Delete to remove`}
                >
                  <div
                    className="sedon-gradient-stop-swatch"
                    style={{ background: rgbaCss(stop.color) }}
                  />
                </div>
                {midPos !== null && (
                  <div
                    className="sedon-gradient-mid"
                    style={{ left: `${midPos * 100}%` }}
                    onPointerDown={(e) => onMidPointerDown(idx, e)}
                    onPointerMove={onMarkerPointerMove}
                    onPointerUp={onMarkerPointerUp}
                    onDoubleClick={(e) => onMidDoubleClick(idx, e)}
                    title={`midpoint ${(mid * 100).toFixed(0)}% — drag to bias the mix, double-click to reset`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {pickerStop !== null && pickerAnchor && (
        <ColorPicker
          value={sortedStops[pickerStop]!.color}
          onChange={onPickerChange}
          onClose={onPickerClose}
          anchorRect={pickerAnchor}
        />
      )}
    </div>,
    document.body,
  );
}
