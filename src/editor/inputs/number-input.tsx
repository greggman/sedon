import { useEffect, useRef, useState } from 'react';

interface NumberInputProps {
  value: number;
  onChange: (next: number) => void;
  integer?: boolean;
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

export function NumberInput({ value, onChange, integer = false }: NumberInputProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => format(value, integer));
  const inputRef = useRef<HTMLInputElement>(null);

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

  const commit = () => {
    const n = integer ? parseInt(text, 10) : parseFloat(text);
    if (Number.isFinite(n) && n !== value) {
      onChange(integer ? Math.round(n) : n);
    }
    setEditing(false);
  };

  if (editing) {
    return (
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
          } else if (e.key === 'Escape') {
            setText(format(value, integer));
            setEditing(false);
          }
        }}
        className="sedon-numinput-edit"
      />
    );
  }

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
        const next = integer ? Math.round(raw) : raw;
        if (next !== value) onChange(next);
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
        if (!draggedRef.current) {
          setText(format(value, integer));
          setEditing(true);
        }
      }}
    >
      {format(value, integer)}
    </div>
  );
}

