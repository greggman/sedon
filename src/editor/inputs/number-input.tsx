import { useEffect, useRef, useState } from 'react';

interface NumberInputProps {
  value: number;
  onChange: (next: number) => void;
  integer?: boolean;
  /**
   * Inclusive declared bounds from the InputDef. The widget clamps
   * drag-end / typed-commit values into [min, max] so the UI never
   * presents a value the evaluator would silently clip. Either side
   * is optional — pass only what's declared.
   */
  min?: number;
  max?: number;
}

// Cross-instance "start editing this NumberInput" registry. Keyed by
// the wrapper span's DOM element so Tab handlers can hop from one
// input to the next without prop-drilling a callback chain through
// VecInput → custom-node.tsx → every parent row. Scope of a Tab
// traversal is the nearest `.sedon-node` ancestor (i.e. one canvas
// node). Each NumberInput registers on mount, unregisters on
// unmount.
const numberInputStarters = new WeakMap<HTMLElement, () => void>();

function findSiblingNumberInput(
  current: HTMLElement,
  direction: 1 | -1,
): HTMLElement | null {
  // Scope: the nearest .sedon-node so Tab walks the inputs on this
  // node only. Wraps at the ends — past the last input goes back to
  // the first; before the first (Shift+Tab) goes to the last. Lets
  // the user iterate through translate/rotate/scale on a transform
  // without ever jumping to a different node, which felt random.
  const root = current.closest('.sedon-node') ?? document.body;
  const all = Array.from(root.querySelectorAll<HTMLElement>('[data-sedon-numinput]'));
  if (all.length === 0) return null;
  const idx = all.indexOf(current);
  if (idx < 0) return null;
  const next = (idx + direction + all.length) % all.length;
  return all[next] ?? null;
}

function clamp(v: number, min: number | undefined, max: number | undefined): number {
  let out = v;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
}

const DRAG_THRESHOLD = 3;

function stepFor(v: number, integer: boolean, modifier: 'fine' | 'normal' | 'coarse'): number {
  const m = modifier === 'fine' ? 0.1 : modifier === 'coarse' ? 10 : 1;
  if (integer) {
    return Math.max(1, Math.round(Math.abs(v) * 0.01)) * m;
  }
  return Math.max(0.001, Math.abs(v) * 0.005) * m;
}

function format(v: number, integer: boolean): string {
  if (integer) return Math.round(v).toString();
  if (!Number.isFinite(v)) return '0';
  const str = v.toFixed(3);
  // Strip trailing zeros and dangling decimal point.
  return str.replace(/\.?0+$/, '');
}

export function NumberInput({ value, onChange, integer = false, min, max }: NumberInputProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => format(value, integer));
  const inputRef = useRef<HTMLInputElement>(null);
  // Stable wrapper element — registered in `numberInputStarters` so
  // sibling NumberInputs can move Tab focus across without prop-
  // drilling. The wrapper stays mounted across the editing/display
  // toggle, so the DOM index used by `findSiblingNumberInput` is
  // stable too.
  const rootRef = useRef<HTMLSpanElement>(null);

  const startXRef = useRef(0);
  const startValueRef = useRef(value);
  const draggedRef = useRef(false);

  useEffect(() => {
    if (!editing) setText(format(value, integer));
  }, [value, integer, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Register this instance's "start editing" callback so a sibling's
  // Tab handler can flip us into edit mode. Re-run on mount; cleanup
  // on unmount.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    numberInputStarters.set(el, () => {
      setText(format(value, integer));
      setEditing(true);
    });
    return () => {
      numberInputStarters.delete(el);
    };
  }, [value, integer]);

  const commit = () => {
    const n = integer ? parseInt(text, 10) : parseFloat(text);
    if (Number.isFinite(n)) {
      const clamped = clamp(integer ? Math.round(n) : n, min, max);
      if (clamped !== value) onChange(clamped);
    }
    setEditing(false);
  };

  const handleTabNavigation = (shift: boolean) => {
    commit();
    const el = rootRef.current;
    if (!el) return;
    const sibling = findSiblingNumberInput(el, shift ? -1 : 1);
    if (sibling) {
      const start = numberInputStarters.get(sibling);
      if (start) start();
    }
  };

  return (
    <span ref={rootRef} data-sedon-numinput="" className="sedon-numinput-root">
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Tab') {
              // Manual Tab handling: commit + advance to the next
              // NumberInput on this node (or the previous one with
              // Shift+Tab). preventDefault stops the browser from
              // also moving focus elsewhere after our commit.
              e.preventDefault();
              handleTabNavigation(e.shiftKey);
            } else if (e.key === 'Escape') {
              setText(format(value, integer));
              setEditing(false);
            }
          }}
          className="sedon-numinput-edit"
        />
      ) : (
        <NumberInputSlider
          value={value}
          integer={integer}
          min={min}
          max={max}
          onChange={onChange}
          onStartEditing={() => {
            setText(format(value, integer));
            setEditing(true);
          }}
          startXRef={startXRef}
          startValueRef={startValueRef}
          draggedRef={draggedRef}
        />
      )}
    </span>
  );
}

interface NumberInputSliderProps {
  value: number;
  integer: boolean;
  min: number | undefined;
  max: number | undefined;
  onChange: (n: number) => void;
  onStartEditing: () => void;
  startXRef: React.MutableRefObject<number>;
  startValueRef: React.MutableRefObject<number>;
  draggedRef: React.MutableRefObject<boolean>;
}

function NumberInputSlider({
  value,
  integer,
  min,
  max,
  onChange,
  onStartEditing,
  startXRef,
  startValueRef,
  draggedRef,
}: NumberInputSliderProps) {
  return (
    <div
      role="slider"
      aria-valuenow={value}
      className="sedon-numinput-drag"
      title={
        integer
          ? 'drag to change · click to type · shift=coarse · ctrl=fine'
          : 'drag to change · click to type · shift=coarse · ctrl=fine'
      }
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        startXRef.current = e.clientX;
        startValueRef.current = value;
        draggedRef.current = false;
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const dx = e.clientX - startXRef.current;
        if (!draggedRef.current && Math.abs(dx) < DRAG_THRESHOLD) return;
        draggedRef.current = true;
        const modifier: 'fine' | 'normal' | 'coarse' = e.shiftKey
          ? 'coarse'
          : e.ctrlKey || e.metaKey
            ? 'fine'
            : 'normal';
        const step = stepFor(startValueRef.current, integer, modifier);
        const raw = startValueRef.current + dx * step;
        const next = clamp(integer ? Math.round(raw) : raw, min, max);
        if (next !== value) onChange(next);
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
        if (!draggedRef.current) {
          onStartEditing();
        }
      }}
    >
      {format(value, integer)}
    </div>
  );
}

