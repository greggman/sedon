import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

// Generic app-style menu bar primitive.
//
// Data model is a flat tree:
//   MenuBar [TopMenu]
//     TopMenu { label, items: MenuEntry[] }
//       MenuEntry =
//         | { kind: 'item',      label, shortcut?, disabled?, run() }
//         | { kind: 'separator' }
//         | { kind: 'submenu',   label, disabled?, items: MenuEntry[] }
//
// Behavior:
//   • Click a top-level label → opens its menu. While any top-level menu
//     is open, hovering siblings switches between them (the "hot" state).
//   • Hovering a submenu parent in an open menu opens its submenu after a
//     short delay; hovering elsewhere closes it after a short grace.
//   • Diagonal cursor handling: while the pointer is moving from the
//     parent menu *toward* the open submenu (inside the triangle formed
//     by the previous mouse position and the submenu's near-edge), the
//     submenu stays open even if the pointer crosses sibling items. This
//     is the standard "safe triangle" approximation used by every native
//     menu system.
//   • Click outside or press Esc closes everything.

export type MenuEntry = MenuLeaf | MenuSeparator | MenuSubmenu;

export interface MenuLeaf {
  kind: 'item';
  label: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

export interface MenuSeparator {
  kind: 'separator';
}

export interface MenuSubmenu {
  kind: 'submenu';
  label: string;
  disabled?: boolean;
  items: MenuEntry[];
}

export interface TopMenu {
  label: string;
  items: MenuEntry[];
}

interface MenuBarProps {
  menus: TopMenu[];
}

export function MenuBar({ menus }: MenuBarProps) {
  // `openIndex === null` → no menu is open and the bar is in "idle"
  // (click-to-open) mode. Once any menu opens, the bar is "hot" and a
  // hover over another top-level label switches to it without needing a
  // second click — same as macOS / Win32 menubars.
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpenIndex(null), []);

  // Click-outside dismissal. We listen on `mousedown` so the menu is
  // gone before any click target (e.g. a node in the canvas) processes
  // its own handler. The check inside the bar's subtree also covers
  // submenu popups via the React portal — they render outside barRef,
  // but we capture them by also pinning a ref to each popup root and
  // checking subtree-of-popup via dataset.menuPopupRoot.
  useEffect(() => {
    if (openIndex === null) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (barRef.current?.contains(target)) return;
      // Any element marked as a menu popup root keeps the menu alive.
      let n: HTMLElement | null = (target as HTMLElement);
      while (n) {
        if (n.dataset && n.dataset.menuPopupRoot === '1') return;
        n = n.parentElement;
      }
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openIndex, close]);

  return (
    <div className="sedon-menubar" ref={barRef}>
      {menus.map((menu, i) => {
        const isOpen = openIndex === i;
        return (
          <div key={menu.label} className="sedon-menubar-item-wrap">
            <button
              type="button"
              className={
                isOpen
                  ? 'sedon-menubar-item sedon-menubar-item--open'
                  : 'sedon-menubar-item'
              }
              onClick={() => setOpenIndex(isOpen ? null : i)}
              // Once the bar is "hot" (something is open), hovering a
              // sibling top-level item flips to it. Don't activate on
              // hover in the idle state — the user expects a click.
              onMouseEnter={() => {
                if (openIndex !== null && openIndex !== i) setOpenIndex(i);
              }}
            >
              {menu.label}
            </button>
            {isOpen && (
              <Menu
                items={menu.items}
                anchor="below"
                onCommit={close}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Menu (popup): renders a list of MenuEntry, handles its own active
// item + open submenu state.
// ─────────────────────────────────────────────────────────────────────

interface MenuProps {
  items: MenuEntry[];
  /** 'below' for top-level menus (drops down from the bar);
   *  'right' for submenus (flies out from the parent item). */
  anchor: 'below' | 'right';
  /** Bounding rect of the parent item — used as the anchor for 'right'. */
  parentRect?: DOMRect | undefined;
  /** Called when the entire menu chain should close (after a click on a leaf). */
  onCommit: () => void;
}

function Menu({ items, anchor, parentRect, onCommit }: MenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Index of the entry whose submenu is currently open (or pending open).
  const [openSubIndex, setOpenSubIndex] = useState<number | null>(null);
  const [subRect, setSubRect] = useState<DOMRect | undefined>(undefined);
  // Tracks the open / close timers so the safe-triangle logic can cancel.
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  // Position the popup. For 'below' (top-level) we anchor under the
  // sedon-menubar-item-wrap parent and let CSS handle absolute layout
  // (top: 100% etc). For 'right' (submenu) the popup is portal-less and
  // lives inside its parent row; we compute left/top in JS so it can
  // flow off-screen-right and we can flip if needed.
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    if (anchor === 'below') {
      setStyle(undefined);
      return;
    }
    if (!parentRect) return;
    const el = rootRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // Default: open to the right, top-aligned with the parent row.
    let left = parentRect.right;
    let top = parentRect.top;
    // Flip left if it would clip the viewport.
    if (left + w > window.innerWidth - 4) {
      left = Math.max(4, parentRect.left - w);
    }
    // Clamp vertical so the bottom doesn't fall off.
    if (top + h > window.innerHeight - 4) {
      top = Math.max(4, window.innerHeight - h - 4);
    }
    setStyle({ position: 'fixed', left, top });
  }, [anchor, parentRect]);

  // Last cursor positions. Used by the safe-triangle: when the mouse
  // moves off a parent row but the next move heads toward the open
  // submenu's near edge, defer closing.
  const lastPoint = useRef<{ x: number; y: number } | null>(null);

  // Safe-triangle check. Returns true iff the cursor at (x, y) is
  // moving toward the submenu (i.e. within the triangle formed by the
  // previous mouse position and the submenu's near-edge top/bottom).
  // If yes, we *don't* immediately switch the open submenu when the
  // cursor crosses a sibling item.
  const isHeadingToSubmenu = useCallback(
    (x: number, y: number): boolean => {
      if (!subRect || !lastPoint.current) return false;
      const lx = lastPoint.current.x;
      const ly = lastPoint.current.y;
      // The submenu's near edge is the side facing the parent menu.
      // Both 'below' anchors and the right-side submenu we anchor to a
      // parent row → the submenu's near edge is its LEFT in the common
      // case. If we ever flip a submenu to the left of its parent, the
      // near edge would be RIGHT; check both.
      const subFromRight = subRect.left > lx;
      const nearX = subFromRight ? subRect.left : subRect.right;
      const nearTopX = nearX;
      const nearTopY = subRect.top;
      const nearBottomX = nearX;
      const nearBottomY = subRect.bottom;
      return pointInTriangle(
        x, y,
        lx, ly,
        nearTopX, nearTopY,
        nearBottomX, nearBottomY,
      );
    },
    [subRect],
  );

  const handleRowMouseMove = useCallback((e: React.MouseEvent) => {
    lastPoint.current = { x: e.clientX, y: e.clientY };
  }, []);

  // Hover-open logic with safe-triangle override.
  const onRowEnter = useCallback(
    (index: number, entry: MenuEntry, rowRect: DOMRect, e: React.MouseEvent) => {
      // If the cursor is heading toward the currently-open submenu, do
      // nothing — the existing submenu stays open until the user either
      // arrives at it or comes to rest outside the triangle.
      if (
        openSubIndex !== null
        && openSubIndex !== index
        && isHeadingToSubmenu(e.clientX, e.clientY)
      ) {
        return;
      }
      if (openTimer.current !== null) {
        window.clearTimeout(openTimer.current);
        openTimer.current = null;
      }
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      if (entry.kind === 'submenu' && !entry.disabled) {
        // Small delay so a quick mouse-fly across the menu doesn't
        // flash every submenu. macOS uses ~250ms; 150ms feels snappier
        // for a desktop app menu.
        openTimer.current = window.setTimeout(() => {
          setOpenSubIndex(index);
          setSubRect(rowRect);
        }, 150);
      } else {
        // Hover over a leaf / separator → close any open submenu
        // (after a grace period so a diagonal move still works).
        if (openSubIndex !== null) {
          closeTimer.current = window.setTimeout(() => {
            setOpenSubIndex(null);
            setSubRect(undefined);
          }, 250);
        }
      }
    },
    [openSubIndex, isHeadingToSubmenu],
  );

  const onRowLeave = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);

  // When the user clicks a leaf, propagate "everything closes" upward.
  const runLeaf = useCallback(
    (entry: MenuLeaf) => {
      if (entry.disabled) return;
      entry.run();
      onCommit();
    },
    [onCommit],
  );

  // Clean up timers on unmount.
  useEffect(() => () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);

  // 'below' top-level popups sit inside their menubar-item-wrap; we
  // don't fix-position them so CSS owns left/top. Submenus use a portal
  // -ish fixed position calculated above.
  const className = anchor === 'below'
    ? 'sedon-menu-popup sedon-menubar-popup'
    : 'sedon-menu-popup sedon-menubar-submenu';

  return (
    <div
      ref={rootRef}
      className={className}
      style={style}
      data-menu-popup-root="1"
      onMouseMove={handleRowMouseMove}
    >
      {items.map((entry, i) => {
        if (entry.kind === 'separator') {
          return <div key={`sep-${i}`} className="sedon-menu-separator" />;
        }
        const isSub = entry.kind === 'submenu';
        const submenuOpenHere = isSub && openSubIndex === i;
        return (
          <MenuRow
            key={`${entry.kind}-${entry.label}-${i}`}
            entry={entry}
            highlighted={submenuOpenHere}
            onEnter={(rect, ev) => onRowEnter(i, entry, rect, ev)}
            onLeave={onRowLeave}
            onClick={() => {
              if (entry.kind === 'item') runLeaf(entry);
            }}
          >
            {submenuOpenHere && entry.kind === 'submenu' && (
              <Menu
                items={entry.items}
                anchor="right"
                parentRect={subRect}
                onCommit={onCommit}
              />
            )}
          </MenuRow>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// MenuRow: a single row inside a popup. Handles hover/enter/leave +
// renders any nested submenu via children.
// ─────────────────────────────────────────────────────────────────────

interface MenuRowProps {
  entry: MenuLeaf | MenuSubmenu;
  highlighted: boolean;
  onEnter: (rect: DOMRect, e: React.MouseEvent) => void;
  onLeave: () => void;
  onClick: () => void;
  children?: ReactNode;
}

function MenuRow({
  entry,
  highlighted,
  onEnter,
  onLeave,
  onClick,
  children,
}: MenuRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const isSub = entry.kind === 'submenu';
  return (
    <div
      ref={rowRef}
      className={
        highlighted
          ? 'sedon-menu-row sedon-menu-row--active'
          : 'sedon-menu-row'
      }
      onMouseEnter={(e) => {
        const rect = rowRef.current?.getBoundingClientRect();
        if (rect) onEnter(rect, e);
      }}
      onMouseLeave={onLeave}
      onClick={() => {
        if (!entry.disabled && entry.kind === 'item') onClick();
      }}
    >
      <span className="sedon-menu-row-label">{entry.label}</span>
      {entry.kind === 'item' && entry.shortcut && (
        <span className="sedon-menu-row-shortcut">{entry.shortcut}</span>
      )}
      {isSub && <span className="sedon-menu-row-chevron">▸</span>}
      {entry.disabled && (
        <span className="sedon-menu-row-disabled-overlay" aria-hidden="true" />
      )}
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Geometry helper. Point-in-triangle via barycentric sign check; degenerate
// triangles (zero area) yield false, which is the right default.
// ─────────────────────────────────────────────────────────────────────

function pointInTriangle(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}
