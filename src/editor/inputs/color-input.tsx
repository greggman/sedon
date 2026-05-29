import { useCallback, useRef, useState } from 'react';
import { ColorPicker } from './color-picker.js';

// Swatch-button trigger. Clicking it pops the RGBA picker open
// (positioned next to the swatch); the swatch itself shows the
// current colour composited over a CSS checkerboard so alpha reads
// as transparency at a glance.
//
// Why a popup instead of `<input type="color">`? The native control
// is RGB only (no alpha) and platform-styled — different on every
// OS / browser, hard to match the editor's compact look. Most of
// our `Color` inputs are RGBA (water tints, fog, foliage colours
// with leaf transparency, etc.), so an alpha-aware picker is a
// recurring need rather than a one-off.

type Rgba = readonly [number, number, number, number];

interface ColorInputProps {
  value: Rgba;
  onChange: (next: [number, number, number, number]) => void;
}

function toByte(c: number): number {
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

export function ColorInput({ value, onChange }: ColorInputProps) {
  const [r, g, b, a] = value;
  const [open, setOpen] = useState(false);
  // Bounding rect captured at the moment the user clicks the swatch.
  // The picker uses it to anchor its popup just below. We snapshot
  // rather than re-measure on every render because the picker may
  // outlive the swatch's exact position (panel resize, etc.) and
  // a static anchor is plenty for click-to-edit.
  const anchorRectRef = useRef<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const onOpen = useCallback(() => {
    const el = buttonRef.current;
    if (!el) return;
    anchorRectRef.current = el.getBoundingClientRect();
    setOpen(true);
  }, []);

  const onClose = useCallback(() => { setOpen(false); }, []);

  const onPickerChange = useCallback((next: Rgba) => {
    onChange([next[0], next[1], next[2], next[3]]);
  }, [onChange]);

  // CSS-only solid colour over a checkerboard so the swatch reads
  // alpha at a glance. The button itself carries the checkerboard
  // background; an inner span carries the solid colour with alpha
  // applied, so when alpha is 0 the checkerboard shows through.
  const fill = `rgba(${toByte(r)}, ${toByte(g)}, ${toByte(b)}, ${a})`;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="sedon-colorinput nodrag"
        onClick={onOpen}
        // Don't let RF treat a colour-click as start-of-drag on the
        // node. `nodrag` covers most paths; stopping pointerdown is
        // belt-and-braces for the click→drag detection RF still does.
        onPointerDown={(e) => { e.stopPropagation(); }}
        aria-label="Edit colour"
      >
        <span className="sedon-colorinput-fill" style={{ background: fill }} />
      </button>
      {open && anchorRectRef.current && (
        <ColorPicker
          value={value}
          onChange={onPickerChange}
          onClose={onClose}
          anchorRect={anchorRectRef.current}
        />
      )}
    </>
  );
}
