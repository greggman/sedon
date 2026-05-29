import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Popover RGBA picker. Layout:
//
//   ┌─────────────────────────┐
//   │                         │  ← SV (saturation × value) square,
//   │   ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒   │    background composited over a
//   │   ▒  current colour ▒   │    checkerboard so alpha reads as
//   │   ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒   │    transparency.
//   │                         │
//   ├─────────────────────────┤
//   │  ━━━━━━━━━━━━━━━━━━━━   │  ← Hue slider (rainbow gradient).
//   ├─────────────────────────┤
//   │  ░░░░░░░░██████████     │  ← Alpha slider: track gradient
//   ├─────────────────────────┤    from fully transparent (current
//   │  R [255] G [128] B [..] │    RGB at α=0) to fully opaque
//   │  A [255]  HEX [#ff80…]  │    (α=1), composited over a
//   └─────────────────────────┘    checkerboard.
//
// Internal state model is HSV + alpha. RGB→HSV happens once on open
// (from the prop value) and on hex / R/G/B-input commits; everything
// else (drag the SV box / hue / alpha) stays in HSV so dragging into
// a desaturated zone doesn't lose the active hue.

type Rgba = readonly [number, number, number, number];

interface ColorPickerProps {
  value: Rgba;
  onChange: (next: Rgba) => void;
  onClose: () => void;
  /** Bounding rect of the trigger swatch — the popup positions itself relative to this. */
  anchorRect: DOMRect;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    case 5: return [v, p, q];
  }
  return [0, 0, 0];
}

function toByte(c: number): number {
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

function toHexByte(c: number): string {
  return toByte(c).toString(16).padStart(2, '0');
}

function rgbaToHex(r: number, g: number, b: number, a: number): string {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}${toHexByte(a)}`;
}

function hexToRgba(hex: string): Rgba | null {
  // Accept #rgb, #rrggbb, #rgba, #rrggbbaa (with or without leading #).
  const s = hex.trim().replace(/^#/, '');
  let r: number, g: number, b: number, a = 1;
  if (s.length === 3 || s.length === 4) {
    if (!/^[0-9a-f]+$/i.test(s)) return null;
    r = parseInt(s[0]! + s[0]!, 16) / 255;
    g = parseInt(s[1]! + s[1]!, 16) / 255;
    b = parseInt(s[2]! + s[2]!, 16) / 255;
    if (s.length === 4) a = parseInt(s[3]! + s[3]!, 16) / 255;
  } else if (s.length === 6 || s.length === 8) {
    if (!/^[0-9a-f]+$/i.test(s)) return null;
    r = parseInt(s.slice(0, 2), 16) / 255;
    g = parseInt(s.slice(2, 4), 16) / 255;
    b = parseInt(s.slice(4, 6), 16) / 255;
    if (s.length === 8) a = parseInt(s.slice(6, 8), 16) / 255;
  } else {
    return null;
  }
  return [r, g, b, a];
}

// Convert a pointer event's clientX/clientY into a 0-1 position along
// the (width or height) of the target element. Used identically by the
// SV box, hue slider, and alpha slider — they all map pointer drag to
// a normalised coordinate.
function pointerNorm(target: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = target.getBoundingClientRect();
  return {
    x: clamp01((clientX - rect.left) / rect.width),
    y: clamp01((clientY - rect.top) / rect.height),
  };
}

export function ColorPicker({ value, onChange, onClose, anchorRect }: ColorPickerProps) {
  // HSV + alpha internal state. Initialise from the prop value once; the
  // user's editing session owns the state thereafter, and we only push
  // changes outward via onChange.
  const [r0, g0, b0, a0] = value;
  const initialHsv = useMemo(() => rgbToHsv(r0, g0, b0), [r0, g0, b0]);
  const [hue, setHue] = useState(initialHsv[0]);
  const [sat, setSat] = useState(initialHsv[1]);
  const [val, setVal] = useState(initialHsv[2]);
  const [alpha, setAlpha] = useState(a0);

  // Derived RGB (for rendering hex input + the alpha-track gradient end).
  const [r, g, b] = useMemo(() => hsvToRgb(hue, sat, val), [hue, sat, val]);

  // Push the most recent value out whenever any of the four sliders move.
  const emit = useCallback((nh: number, ns: number, nv: number, na: number) => {
    const [rr, gg, bb] = hsvToRgb(nh, ns, nv);
    onChange([rr, gg, bb, na]);
  }, [onChange]);

  // Click-outside-to-close. Listen on the document for pointerdown
  // events that miss the popup; the picker stops propagation on its
  // own pointerdowns so they don't trigger this.
  const popupRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDocPointerDown(e: PointerEvent) {
      const popup = popupRef.current;
      if (!popup) return;
      if (e.target instanceof Node && popup.contains(e.target)) return;
      onClose();
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => { document.removeEventListener('pointerdown', onDocPointerDown); };
  }, [onClose]);

  // Escape closes too.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => { document.removeEventListener('keydown', onKeyDown, true); };
  }, [onClose]);

  // SV box drag — pointerdown captures the pointer so dragging out of
  // the box keeps updating. Same pattern for hue and alpha.
  function makeDragHandler(
    apply: (nx: number, ny: number) => void,
  ): (e: React.PointerEvent<HTMLDivElement>) => void {
    return (e) => {
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const update = (clientX: number, clientY: number) => {
        const { x, y } = pointerNorm(el, clientX, clientY);
        apply(x, y);
      };
      update(e.clientX, e.clientY);
      const onMove = (ev: PointerEvent) => {
        if (el.hasPointerCapture(ev.pointerId)) update(ev.clientX, ev.clientY);
      };
      const onUp = (ev: PointerEvent) => {
        el.releasePointerCapture(ev.pointerId);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
  }

  const svDown = makeDragHandler((nx, ny) => {
    setSat(nx);
    setVal(1 - ny);
    emit(hue, nx, 1 - ny, alpha);
  });
  const hueDown = makeDragHandler((nx) => {
    setHue(nx);
    emit(nx, sat, val, alpha);
  });
  const alphaDown = makeDragHandler((nx) => {
    setAlpha(nx);
    emit(hue, sat, val, nx);
  });

  // Numeric input editing. Hex is the easy one (single text field).
  // R/G/B/A inputs commit on blur or Enter — keeping them controlled
  // from local string state lets the user type intermediate values
  // (e.g. clear and retype) without the parsed-zero flash.
  const hexValue = rgbaToHex(r, g, b, alpha);
  const [hexDraft, setHexDraft] = useState(hexValue);
  const [hexEditing, setHexEditing] = useState(false);
  useEffect(() => { if (!hexEditing) setHexDraft(hexValue); }, [hexValue, hexEditing]);

  function commitHex(s: string): void {
    const parsed = hexToRgba(s);
    if (!parsed) return;
    const [nh, ns, nv] = rgbToHsv(parsed[0], parsed[1], parsed[2]);
    setHue(nh);
    setSat(ns);
    setVal(nv);
    setAlpha(parsed[3]);
    emit(nh, ns, nv, parsed[3]);
  }

  // R/G/B/A byte editors.
  const renderByteInput = (label: string, channel: 'r' | 'g' | 'b' | 'a') => {
    const current = channel === 'r' ? toByte(r)
                  : channel === 'g' ? toByte(g)
                  : channel === 'b' ? toByte(b)
                  : toByte(alpha);
    return (
      <label className="sedon-color-byte">
        <span>{label}</span>
        <input
          type="number"
          min={0}
          max={255}
          step={1}
          value={current}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (!Number.isFinite(n)) return;
            const v01 = clamp01(n / 255);
            if (channel === 'a') {
              setAlpha(v01);
              emit(hue, sat, val, v01);
            } else {
              const nr = channel === 'r' ? v01 : r;
              const ng = channel === 'g' ? v01 : g;
              const nb = channel === 'b' ? v01 : b;
              const [nh, ns, nv] = rgbToHsv(nr, ng, nb);
              setHue(nh);
              setSat(ns);
              setVal(nv);
              emit(nh, ns, nv, alpha);
            }
          }}
        />
      </label>
    );
  };

  // Position the popup just below the anchor, clamped to the viewport.
  const POPUP_W = 220;
  const POPUP_H = 280;
  const left = Math.min(
    Math.max(8, anchorRect.left),
    window.innerWidth - POPUP_W - 8,
  );
  const top = Math.min(
    anchorRect.bottom + 4,
    window.innerHeight - POPUP_H - 8,
  );

  // Hue at full saturation/value for the SV-box gradient endpoint —
  // converts the H-only ring into the bright corner of the SV plane.
  const hueRgb = hsvToRgb(hue, 1, 1);
  const hueCss = `rgb(${toByte(hueRgb[0])}, ${toByte(hueRgb[1])}, ${toByte(hueRgb[2])})`;
  const currentRgba = `rgba(${toByte(r)}, ${toByte(g)}, ${toByte(b)}, ${alpha})`;

  return createPortal(
    <div
      ref={popupRef}
      className="sedon-color-popup"
      style={{ left, top }}
      // The picker lives in a node-canvas — stop pointer events from
      // bubbling out and triggering RF's node-drag / node-select.
      onPointerDown={(e) => { e.stopPropagation(); }}
      onClick={(e) => { e.stopPropagation(); }}
    >
      <div
        className="sedon-color-sv"
        style={{
          background:
            `linear-gradient(to bottom, transparent, black), ` +
            `linear-gradient(to right, white, ${hueCss})`,
        }}
        onPointerDown={svDown}
      >
        <div className="sedon-color-sv-cursor" style={{ left: `${sat * 100}%`, top: `${(1 - val) * 100}%` }} />
      </div>

      <div className="sedon-color-hue" onPointerDown={hueDown}>
        <div className="sedon-color-hue-cursor" style={{ left: `${hue * 100}%` }} />
      </div>

      <div className="sedon-color-alpha-row">
        <div className="sedon-color-current-swatch">
          <div className="sedon-color-current-fill" style={{ background: currentRgba }} />
        </div>
        <div className="sedon-color-alpha-checker">
          <div
            className="sedon-color-alpha"
            style={{
              background:
                `linear-gradient(to right, ` +
                `rgba(${toByte(r)}, ${toByte(g)}, ${toByte(b)}, 0), ` +
                `rgba(${toByte(r)}, ${toByte(g)}, ${toByte(b)}, 1))`,
            }}
            onPointerDown={alphaDown}
          >
            <div className="sedon-color-alpha-cursor" style={{ left: `${alpha * 100}%` }} />
          </div>
        </div>
      </div>

      <div className="sedon-color-bytes">
        {renderByteInput('R', 'r')}
        {renderByteInput('G', 'g')}
        {renderByteInput('B', 'b')}
        {renderByteInput('A', 'a')}
      </div>

      <label className="sedon-color-hex">
        <span>HEX</span>
        <input
          type="text"
          value={hexDraft}
          onFocus={() => setHexEditing(true)}
          onChange={(e) => {
            setHexDraft(e.target.value);
            // Commit immediately if the typed value parses — gives
            // live preview during paste; the field stays focused.
            const parsed = hexToRgba(e.target.value);
            if (parsed) commitHex(e.target.value);
          }}
          onBlur={(e) => {
            setHexEditing(false);
            const parsed = hexToRgba(e.target.value);
            if (parsed) commitHex(e.target.value);
            else setHexDraft(hexValue);
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </label>
    </div>,
    document.body,
  );
}
