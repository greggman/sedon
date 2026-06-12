import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NodeDef } from '../core/node-def.js';
import { isSubgraphInstanceKind, isSubgraphInternalKind } from '../core/subgraph.js';
import { createCoreTypeRegistry } from '../core/types.js';
import { addNodeAtFlowPosition, getSelectedEdgeSpliceConstraint } from './commands.js';
import { useRegistry } from './registry.js';

// Portal'd, position-aware Add-Node picker. Same search-and-filter UX
// that the canvas's toolbar "+ Add Node" button shows; reused by the
// canvas right-click context menu so right-click → Add Node → pick
// lands at the cursor instead of canvas center.
//
// Renders into document.body so `position: fixed` actually anchors
// to the viewport even when the spawning element lives inside
// ReactFlow's `transform: translate(...)` subtree (which would
// otherwise create a containing block for fixed positioning).

interface AddNodePickerProps {
  /** Screen-space anchor point for the popup's top-left. The popup
   *  clamps itself inside the viewport if the anchor would push it
   *  off-screen. */
  anchorX: number;
  anchorY: number;
  /** Flow-coordinate position for the new node — typically the
   *  matching screen point passed through
   *  `rf.screenToFlowPosition`. The toolbar variant passes the
   *  canvas center; the context-menu variant passes the click. */
  flowX: number;
  flowY: number;
  onClose: () => void;
}

export function AddNodePicker({
  anchorX,
  anchorY,
  flowX,
  flowY,
  onClose,
}: AddNodePickerProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const registry = useRegistry();

  // Snapshot the splice constraint at mount: if the user has exactly
  // one edge selected when the picker opens, restrict the candidate
  // list to nodes that could actually splice between the wire's
  // endpoints (has an input that accepts the source's output type
  // AND an output that produces the target's input type). When no
  // edge is selected, the constraint is null and the full registry
  // shows.
  const spliceConstraint = useMemo(() => getSelectedEdgeSpliceConstraint(), []);

  const allDefs = useMemo(() => {
    const defs: NodeDef[] = [];
    for (const def of registry.list()) {
      if (isSubgraphInternalKind(def.id)) continue;
      if (isSubgraphInstanceKind(def.id)) continue;
      defs.push(def);
    }
    if (spliceConstraint) {
      // Same compatibility rule the splice path uses: source's output
      // → candidate input (input check), candidate output → target's
      // input (output check). Both must pass for the node to be
      // spliceable. createCoreTypeRegistry is the cheap singleton
      // also used by tryInsertOnSelectedEdge; the type table is
      // module-static so this is a quick lookup.
      const types = createCoreTypeRegistry();
      const filtered = defs.filter((d) => {
        const acceptsFrom = d.inputs.some((i) =>
          types.isCompatible(spliceConstraint.fromType, i.type),
        );
        const producesTo = d.outputs.some((o) =>
          types.isCompatible(o.type, spliceConstraint.toType),
        );
        return acceptsFrom && producesTo;
      });
      filtered.sort((a, b) =>
        a.category === b.category ? a.id.localeCompare(b.id) : a.category.localeCompare(b.category),
      );
      return filtered;
    }
    defs.sort((a, b) =>
      a.category === b.category ? a.id.localeCompare(b.id) : a.category.localeCompare(b.category),
    );
    return defs;
  }, [registry, spliceConstraint]);

  // Tokenized substring filter — same shape as the command palette.
  const filtered = useMemo<NodeDef[]>(() => {
    const q = query.toLowerCase().trim();
    if (!q) return allDefs;
    const tokens = q.split(/\s+/).filter(Boolean);
    return allDefs.filter((d) => {
      const haystack = `${d.id} ${d.category}`.toLowerCase();
      return tokens.every((t) => haystack.includes(t));
    });
  }, [allDefs, query]);

  // Auto-focus the input every mount so the user can type immediately.
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  // Snap selection to the top whenever the filter changes — Enter
  // should run the most relevant result.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Outside click + Escape dismissal. CAPTURE-phase listener so
  // ReactFlow's pane handlers don't swallow the event before we see
  // it. Walks the ancestor chain looking for `data-menu-popup-root`
  // so clicks inside the picker keep it alive.
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

  // Scroll the active item into view as the user arrows through the
  // filtered list.
  useEffect(() => {
    const popup = popupRef.current;
    if (!popup) return;
    const active = popup.querySelector<HTMLElement>('.sedon-add-node-item--active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  // Clamp the anchor inside the viewport once we know our size.
  const [pos, setPos] = useState({ x: anchorX, y: anchorY });
  useEffect(() => {
    const el = popupRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let nx = anchorX;
    let ny = anchorY;
    if (nx + w > window.innerWidth - 4) nx = Math.max(4, window.innerWidth - w - 4);
    if (ny + h > window.innerHeight - 4) ny = Math.max(4, window.innerHeight - h - 4);
    setPos({ x: nx, y: ny });
  }, [anchorX, anchorY]);

  const addNode = (kind: string) => {
    // Goes through addNodeAtFlowPosition so the drop-on-wire
    // behaviour fires when a single edge is selected — same code
    // path as the toolbar/palette add. Falls back to a plain add
    // at (flowX, flowY) otherwise.
    addNodeAtFlowPosition(kind, flowX, flowY);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const def = filtered[activeIndex];
      if (def) addNode(def.id);
    }
  };

  let lastCategory: string | null = null;
  const rows: React.ReactNode[] = [];
  filtered.forEach((def, i) => {
    if (def.category !== lastCategory) {
      rows.push(
        <div key={`cat:${def.category}`} className="sedon-add-node-category">{def.category}</div>,
      );
      lastCategory = def.category;
    }
    const active = i === activeIndex;
    rows.push(
      <button
        key={def.id}
        type="button"
        onMouseEnter={() => setActiveIndex(i)}
        // mousedown rather than click — the filter input has focus,
        // and a click would race the input's blur handlers.
        onMouseDown={(e) => {
          e.preventDefault();
          addNode(def.id);
        }}
        className={`sedon-menu-item sedon-add-node-item${active ? ' sedon-add-node-item--active' : ''}`}
      >
        {def.id}
      </button>,
    );
  });

  return createPortal(
    <div
      ref={popupRef}
      className="sedon-menu-popup sedon-add-node-popup"
      data-menu-popup-root="1"
      style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 1000 }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <input
        ref={inputRef}
        type="text"
        className="sedon-add-node-filter"
        placeholder="Filter…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {spliceConstraint && (
        // Small hint that the result set is restricted to splice-
        // eligible kinds — without this, "where's the node I just
        // added?" becomes a guessing game when an edge is selected.
        <div className="sedon-add-node-constraint">
          Splice {spliceConstraint.fromType} → {spliceConstraint.toType}
        </div>
      )}
      <div className="sedon-add-node-results">
        {filtered.length === 0 ? (
          <div className="sedon-add-node-empty">No matching nodes</div>
        ) : (
          rows
        )}
      </div>
    </div>,
    document.body,
  );
}
