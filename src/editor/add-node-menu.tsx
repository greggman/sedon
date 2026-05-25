import { useReactFlow } from '@xyflow/react';
import { useMemo, useState } from 'react';
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
  const rf = useReactFlow();
  const addNodeToStore = useEditorStore((s) => s.addNode);
  const registry = useRegistry();

  // Group node-defs by category from the runtime registry. Two kinds
  // are filtered out:
  //   • Internal-only (subgraph-input/*, subgraph-output/*) — they only
  //     make sense INSIDE a subgraph.
  //   • Subgraph wrapper instances (subgraph/<id>) — wrappers are
  //     authored as assets, and the Asset panel (drag-to-canvas drops
  //     them at the cursor) is the canonical path. Keeping them out of
  //     this menu means one rule across the whole app: "Add this kind"
  //     surfaces only the fixed library; project-defined wrappers
  //     belong to the Asset world.
  const grouped = useMemo(() => {
    const map = new Map<string, NodeDef[]>();
    for (const def of registry.list()) {
      if (isSubgraphInternalKind(def.id)) continue;
      if (isSubgraphInstanceKind(def.id)) continue;
      const list = map.get(def.category) ?? [];
      list.push(def);
      map.set(def.category, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [registry]);

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
        <div className="sedon-menu-popup sedon-add-node-popup">
          {grouped.map(([category, defs]) => (
            <div key={category}>
              <div className="sedon-add-node-category">{category}</div>
              {defs.map((def) => (
                <button
                  key={def.id}
                  type="button"
                  onClick={() => addNode(def.id)}
                  className="sedon-menu-item sedon-add-node-item"
                >
                  {def.id}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
