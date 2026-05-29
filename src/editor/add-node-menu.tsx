import { useReactFlow } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NodeDef } from '../core/node-def.js';
import { isSubgraphInstanceKind, isSubgraphInternalKind } from '../core/subgraph.js';
import { useRegistry } from './registry.js';
import { useEditorStore } from './store.js';

interface AddNodeMenuProps {
  // Ref to the container that hosts both the canvas and this menu, so we can
  // map "viewport center" to flow coordinates for the new node's position.
  canvasRef: React.RefObject<HTMLElement | null>;
}

export function AddNodeMenu({ canvasRef }: AddNodeMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const rf = useReactFlow();
  const addNodeToStore = useEditorStore((s) => s.addNode);
  const registry = useRegistry();

  // All visible node-defs from the runtime registry, sorted by category
  // then id. Two kinds are filtered out:
  //   • Internal-only (subgraph-input/*, subgraph-output/*) — they only
  //     make sense INSIDE a subgraph.
  //   • Subgraph wrapper instances (subgraph/<id>) — wrappers are
  //     authored as assets, and the Asset panel (drag-to-canvas drops
  //     them at the cursor) is the canonical path. Keeping them out of
  //     this menu means one rule across the whole app: "Add this kind"
  //     surfaces only the fixed library; project-defined wrappers
  //     belong to the Asset world.
  const allDefs = useMemo(() => {
    const defs: NodeDef[] = [];
    for (const def of registry.list()) {
      if (isSubgraphInternalKind(def.id)) continue;
      if (isSubgraphInstanceKind(def.id)) continue;
      defs.push(def);
    }
    defs.sort((a, b) =>
      a.category === b.category ? a.id.localeCompare(b.id) : a.category.localeCompare(b.category),
    );
    return defs;
  }, [registry]);

  // Tokenized substring filter (same shape as command-palette): each
  // whitespace-delimited token must appear somewhere in either the id
  // or the category. Lets users type "tex blend" → finds blend nodes
  // categorised under Texture.
  const filtered = useMemo<NodeDef[]>(() => {
    const q = query.toLowerCase().trim();
    if (!q) return allDefs;
    const tokens = q.split(/\s+/).filter(Boolean);
    return allDefs.filter((d) => {
      const haystack = `${d.id} ${d.category}`.toLowerCase();
      return tokens.every((t) => haystack.includes(t));
    });
  }, [allDefs, query]);

  // Reset state + focus the input every time the menu opens.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Snap selection to the top whenever the filter changes — Enter
  // should run the most relevant result, not whatever was selected before.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Click outside the popup closes the menu. The button toggle handler
  // runs first when clicking the button itself, so closing here on a
  // button click would race; bail when the target is inside the menu
  // container at all.
  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: PointerEvent) {
      const root = popupRef.current?.parentElement;
      if (!root) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => { document.removeEventListener('pointerdown', onDocPointerDown); };
  }, [open]);

  // Scroll the active item into view as the user arrows through the
  // filtered list — otherwise navigating off-screen leaves the cursor
  // invisible behind the scroll boundary.
  useEffect(() => {
    if (!open) return;
    const popup = popupRef.current;
    if (!popup) return;
    const active = popup.querySelector<HTMLElement>('.sedon-add-node-item--active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const addNode = (kind: string) => {
    const id = crypto.randomUUID();
    let position = { x: 100, y: 100 };
    const el = canvasRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      position = rf.screenToFlowPosition({
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
      });
    }
    rf.addNodes({ id, type: 'sedon', position, data: { kind } });
    addNodeToStore({ id, kind });
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
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

  // Walk the sorted+filtered defs once, emitting a category header
  // every time the category changes. The flat order matches `filtered`,
  // so the activeIndex into `filtered` lines up with the rendered items.
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
        // mousedown rather than click — the filter input has focus, and
        // a click would race the input's blur handlers.
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

  return (
    <div className="sedon-add-node-menu">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="sedon-toolbar-button"
      >
        + Add Node
      </button>
      {open && (
        <div ref={popupRef} className="sedon-menu-popup sedon-add-node-popup">
          <input
            ref={inputRef}
            type="text"
            className="sedon-add-node-filter"
            placeholder="Filter…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="sedon-add-node-results">
            {filtered.length === 0 ? (
              <div className="sedon-add-node-empty">No matching nodes</div>
            ) : (
              rows
            )}
          </div>
        </div>
      )}
    </div>
  );
}
