import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NumberInput } from './number-input.js';

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
//   │  [RGBA] [0-1]           │    RGB at α=0) to fully opaque
//   │  R 0.5  G 0.25  B 0.1   │    (α=1), composited over a
//   │  A 1.0  HEX  #80401a    │    checkerboard.
//   └─────────────────────────┘
//
// Internal state model is HSV + alpha. RGB→HSV happens once on open
// (from the prop value) and on hex / channel-input commits; everything
// else (drag the SV box / hue / alpha) stays in HSV so dragging into
// a desaturated zone doesn't lose the active hue.
//
// Channel editors below are NumberInput-style drag-to-scrub controls.
// Two top-row toggles select the display:
//   - mode: RGBA (R/G/B/A) vs HSLA (H/S/L/A) — HSLA is derived from
//     HSV by L = V·(1−S/2) and friends; the H component is shared.
//   - unit: 0-1 floats vs whatever "byte-ish" integers each channel
//     naturally wants (R/G/B/A: 0–255; H: 0–360; S/L: 0–100). Picking
//     "0-255" as the toggle label is a small lie for HSLA channels but
//     it's the obvious mental model: "switch to integer-ish units."
//
// Toggle preferences persist module-globally so reopening the picker
// in the same session remembers the user's choice.

type Rgba = readonly [number, number, number, number];

type ColorMode = 'rgba' | 'hsla';
type ColorUnit = 'float' | 'byte';

// Session-persistent toggle preferences. Module-level so re-mounting
// the picker (open/close/open) preserves the user's last choice.
let savedMode: ColorMode = 'rgba';
let savedUnit: ColorUnit = 'float';

interface ColorPickerProps {
  value: Rgba;
  onChange: (next: Rgba) => void;
  onClose: () => void;
  /** Bounding rect of the trigger swatch — the popup positions itself relative to this. */
  anchorRect: DOMRect;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
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

// HSV ↔ HSL share H (the same 0–1 wheel position) but differ on the
// saturation/lightness axes. The standard formulas:
//   L  = V · (1 − S_v/2)
//   S_l = L ∈ {0, 1} ? 0 : (V − L) / min(L, 1−L)
// and inversely:
//   V  = L + S_l · min(L, 1−L)
//   S_v = V == 0 ? 0 : 2·(1 − L/V)
function hsvToHsl(h: number, sv: number, v: number): [number, number, number] {
  const l = v * (1 - sv / 2);
  const sl = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
  return [h, sl, l];
}
function hslToHsv(h: number, sl: number, l: number): [number, number, number] {
  const v = l + sl * Math.min(l, 1 - l);
  const sv = v === 0 ? 0 : 2 * (1 - l / v);
  return [h, sv, v];
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

  // Display-mode toggles (kept in sync with module-globals via the
  // setters below so reopening the picker carries the choice over).
  const [mode, setModeState] = useState<ColorMode>(savedMode);
  const [unit, setUnitState] = useState<ColorUnit>(savedUnit);
  const setMode = (m: ColorMode) => { savedMode = m; setModeState(m); };
  const setUnit = (u: ColorUnit) => { savedUnit = u; setUnitState(u); };

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

  // Apply a normalised (0–1) channel value back to internal HSV state.
  // Branches on (mode, channel); RGBA-channel writes RGB→HSV-convert
  // first, HSLA-channel writes HSL→HSV-convert.
  const applyChannel01 = (channel: 0 | 1 | 2 | 3, v01: number) => {
    v01 = clamp01(v01);
    if (channel === 3) {
      setAlpha(v01);
      emit(hue, sat, val, v01);
      return;
    }
    if (mode === 'rgba') {
      const nr = channel === 0 ? v01 : r;
      const ng = channel === 1 ? v01 : g;
      const nb = channel === 2 ? v01 : b;
      const [nh, ns, nv] = rgbToHsv(nr, ng, nb);
      setHue(nh); setSat(ns); setVal(nv);
      emit(nh, ns, nv, alpha);
    } else {
      const [hh, sl, ll] = hsvToHsl(hue, sat, val);
      const nh = channel === 0 ? v01 : hh;
      const nsl = channel === 1 ? v01 : sl;
      const nll = channel === 2 ? v01 : ll;
      const [hv, sv, vv] = hslToHsv(nh, nsl, nll);
      setHue(hv); setSat(sv); setVal(vv);
      emit(hv, sv, vv, alpha);
    }
  };

  // Channel layout: label, displayed value, integer (drag step pivot),
  // and the channel index for the apply callback. The displayed value
  // is computed from the current internal HSV+α according to (mode,
  // unit); on change we invert back through applyChannel01.
  interface ChannelSpec {
    label: string;
    value: number;
    integer: boolean;
    /** Scale factor: displayed = stored01 * scale. */
    scale: number;
  }
  const [hs, ss, ls] = mode === 'hsla' ? hsvToHsl(hue, sat, val) : [0, 0, 0];
  const channels: ChannelSpec[] = (() => {
    if (mode === 'rgba') {
      if (unit === 'float') {
        return [
          { label: 'R', value: r, integer: false, scale: 1 },
          { label: 'G', value: g, integer: false, scale: 1 },
          { label: 'B', value: b, integer: false, scale: 1 },
          { label: 'A', value: alpha, integer: false, scale: 1 },
        ];
      }
      return [
        { label: 'R', value: toByte(r), integer: true, scale: 255 },
        { label: 'G', value: toByte(g), integer: true, scale: 255 },
        { label: 'B', value: toByte(b), integer: true, scale: 255 },
        { label: 'A', value: toByte(alpha), integer: true, scale: 255 },
      ];
    }
    // HSLA
    if (unit === 'float') {
      return [
        { label: 'H', value: hs, integer: false, scale: 1 },
        { label: 'S', value: ss, integer: false, scale: 1 },
        { label: 'L', value: ls, integer: false, scale: 1 },
        { label: 'A', value: alpha, integer: false, scale: 1 },
      ];
    }
    // HSLA bytes: H 0-360°, S/L 0-100%, A 0-255.
    return [
      { label: 'H', value: Math.round(hs * 360), integer: true, scale: 360 },
      { label: 'S', value: Math.round(ss * 100), integer: true, scale: 100 },
      { label: 'L', value: Math.round(ls * 100), integer: true, scale: 100 },
      { label: 'A', value: toByte(alpha), integer: true, scale: 255 },
    ];
  })();

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

  // Position the popup just below the anchor, clamped to the viewport.
  const POPUP_W = 220;
  const POPUP_H = 320;
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

      <div className="sedon-color-toggles">
        <button
          type="button"
          className="sedon-color-toggle"
          onClick={() => setMode(mode === 'rgba' ? 'hsla' : 'rgba')}
          title="toggle RGBA / HSLA channel display"
        >
          {mode === 'rgba' ? 'RGBA' : 'HSLA'}
        </button>
        <button
          type="button"
          className="sedon-color-toggle"
          onClick={() => setUnit(unit === 'float' ? 'byte' : 'float')}
          title="toggle 0–1 floats / integer units (0–255, 0–360°, 0–100%)"
        >
          {unit === 'float' ? '0–1' : '0–255'}
        </button>
      </div>

      <div className="sedon-color-bytes">
        {channels.map((ch, i) => (
          <label key={ch.label} className="sedon-color-byte">
            <span>{ch.label}</span>
            <NumberInput
              value={ch.value}
              integer={ch.integer}
              onChange={(n) => applyChannel01(i as 0 | 1 | 2 | 3, n / ch.scale)}
            />
          </label>
        ))}
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
