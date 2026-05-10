import { useReactFlow } from '@xyflow/react';
import { useState } from 'react';
import { DEMOS } from './demos/index.js';
import { graphToRfEdges, graphToRfNodes } from './rf-conversion.js';
import { useEditorStore } from './store.js';

export function DemosMenu() {
  const [open, setOpen] = useState(false);
  const rf = useReactFlow();
  const setGraph = useEditorStore((s) => s.setGraph);

  const loadDemo = (id: string) => {
    const demo = DEMOS.find((d) => d.id === id);
    if (!demo) return;
    const { graph, rootNodeId } = demo.build();
    setGraph(graph, rootNodeId);
    rf.setNodes(graphToRfNodes(graph));
    rf.setEdges(graphToRfEdges(graph));
    // Frame the new graph after RF has applied the new nodes.
    requestAnimationFrame(() => rf.fitView({ padding: 0.2 }));
    setOpen(false);
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={buttonStyle}
        title="Load a demo scene"
      >
        Demos ▾
      </button>
      {open && (
        <div style={popupStyle}>
          {DEMOS.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => loadDemo(d.id)}
              style={itemStyle}
            >
              {d.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  background: '#3a3a48',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: '#555',
  borderRadius: 4,
  color: '#ddd',
  fontSize: 12,
  padding: '6px 10px',
  cursor: 'pointer',
  fontFamily: 'system-ui, sans-serif',
};

const popupStyle: React.CSSProperties = {
  position: 'absolute',
  top: '100%',
  right: 0,
  marginTop: 4,
  background: '#22222a',
  border: '1px solid #555',
  borderRadius: 4,
  padding: '4px 0',
  minWidth: 160,
  fontSize: 12,
  fontFamily: 'system-ui, sans-serif',
  color: '#ddd',
  boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
};

const itemStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  background: 'transparent',
  border: 'none',
  textAlign: 'left',
  color: '#ddd',
  padding: '6px 14px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
};
