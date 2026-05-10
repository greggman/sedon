import { useReactFlow } from '@xyflow/react';
import { useState } from 'react';
import { CORE_NODES } from '../nodes/index.js';
import type { NodeDef } from '../core/node-def.js';
import { useEditorStore } from './store.js';

interface AddNodeMenuProps {
  // Ref to the container that hosts both the canvas and this menu, so we can
  // map "viewport center" to flow coordinates for the new node's position.
  canvasRef: React.RefObject<HTMLElement | null>;
}

const grouped = (() => {
  const map = new Map<string, NodeDef[]>();
  for (const def of CORE_NODES) {
    const list = map.get(def.category) ?? [];
    list.push(def);
    map.set(def.category, list);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
})();

export function AddNodeMenu({ canvasRef }: AddNodeMenuProps) {
  const [open, setOpen] = useState(false);
  const rf = useReactFlow();
  const addNodeToStore = useEditorStore((s) => s.addNode);

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
    <div style={{ position: 'absolute', top: 8, left: 8, zIndex: 10 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={buttonStyle}
      >
        + Add Node
      </button>
      {open && (
        <div style={popupStyle}>
          {grouped.map(([category, defs]) => (
            <div key={category}>
              <div style={categoryStyle}>{category}</div>
              {defs.map((def) => (
                <button
                  key={def.id}
                  type="button"
                  onClick={() => addNode(def.id)}
                  style={itemStyle}
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

const buttonStyle: React.CSSProperties = {
  background: '#3a3a48',
  border: '1px solid #555',
  borderRadius: 4,
  color: '#ddd',
  fontSize: 12,
  padding: '6px 10px',
  cursor: 'pointer',
  fontFamily: 'system-ui, sans-serif',
};

const popupStyle: React.CSSProperties = {
  marginTop: 4,
  background: '#22222a',
  border: '1px solid #555',
  borderRadius: 4,
  padding: '4px 0',
  minWidth: 200,
  maxHeight: 'calc(100vh - 60px)',
  overflowY: 'auto',
  fontSize: 12,
  fontFamily: 'system-ui, sans-serif',
  color: '#ddd',
  boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
};

const categoryStyle: React.CSSProperties = {
  padding: '6px 10px 2px',
  color: '#888',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const itemStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  background: 'transparent',
  border: 'none',
  textAlign: 'left',
  color: '#ddd',
  padding: '4px 14px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
};
