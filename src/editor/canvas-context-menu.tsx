import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Right-click menu shown when the user clicks on the empty canvas
// pane (not on a node). For now it offers "Add Node…" which spawns
// the AddNodePicker at the click position; designed to grow as new
// pane-scoped actions show up (Paste at cursor, View settings, …).
//
// Mirrors NodeContextMenu's dismissal contract: CAPTURE-phase
// window listener that walks the click's ancestor chain looking for
// `data-menu-popup-root`. Portal'd into document.body so
// `position: fixed` actually pins to the viewport instead of being
// trapped inside ReactFlow's transformed subtree.

export type CanvasContextMenuItem =
  | {
      kind?: 'item';
      label: string;
      /** False = render dimmed and ignore clicks. */
      enabled?: boolean;
      /** Free-form hint shown next to the label (shortcut, etc.). */
      hint?: string;
      run: () => void;
    }
  | { kind: 'separator' };

interface CanvasContextMenuProps {
  x: number;
  y: number;
  items: CanvasContextMenuItem[];
  onClose: () => void;
}

export function CanvasContextMenu({ x, y, items, onClose }: CanvasContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let nx = x;
    let ny = y;
    if (nx + w > window.innerWidth - 4) nx = Math.max(4, window.innerWidth - w - 4);
    if (ny + h > window.innerHeight - 4) ny = Math.max(4, window.innerHeight - h - 4);
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      let n: HTMLElement | null = e.target as HTMLElement | null;
      while (n) {
        if (n.dataset && n.dataset.menuPopupRoot === '1') return;
        n = n.parentElement;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="sedon-menu-popup sedon-menubar-submenu nodrag nopan"
      data-menu-popup-root="1"
      style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 1000 }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        if (it.kind === 'separator') {
          return <div key={`sep-${i}`} className="sedon-menu-separator" />;
        }
        return (
          <div
            key={`${it.label}-${i}`}
            className="sedon-menu-row"
            onMouseUp={() => {
              if (it.enabled === false) return;
              it.run();
              onClose();
            }}
          >
            <span className="sedon-menu-row-label">{it.label}</span>
            {it.hint && <span className="sedon-menu-row-shortcut">{it.hint}</span>}
            {it.enabled === false && (
              // Same dim-and-block pattern the menubar uses: a
              // pointer-events overlay greys the row out while
              // intercepting clicks. CSS in editor.css keys off
              // this child via :has().
              <span className="sedon-menu-row-disabled-overlay" aria-hidden="true" />
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
