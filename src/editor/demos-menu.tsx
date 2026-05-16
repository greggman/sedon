import { useReactFlow } from '@xyflow/react';
import { useRef, useState } from 'react';
import { confirmDiscardIfDirty } from './confirm-dirty.js';
import { DEMOS } from './demos/index.js';
import { buildRegistry } from './registry.js';
import { graphToRfEdges, graphToRfNodes } from './rf-conversion.js';
import { useDismiss } from './use-dismiss.js';
import { useEditorStore } from './store.js';

export function DemosMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(open, rootRef, () => setOpen(false));
  const rf = useReactFlow();
  const setGraph = useEditorStore((s) => s.setGraph);

  const loadDemo = (id: string) => {
    const demo = DEMOS.find((d) => d.id === id);
    if (!demo) return;
    if (!confirmDiscardIfDirty()) {
      setOpen(false);
      return;
    }
    const { graph, rootNodeId, subgraphs, cameras } = demo.build();
    setGraph(graph, rootNodeId, subgraphs, cameras);
    // Build the registry from the demo's subgraphs so edge colors resolve
    // against the same kinds the new graph references.
    const registry = buildRegistry(subgraphs ?? []);
    rf.setNodes(graphToRfNodes(graph));
    rf.setEdges(graphToRfEdges(graph, registry));
    // Frame the new graph after RF has applied the new nodes.
    requestAnimationFrame(() => rf.fitView({ padding: 0.2 }));
    setOpen(false);
  };

  return (
    <div className="sedon-demos-menu" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="sedon-toolbar-button"
        title="Load a demo scene"
      >
        Demos ▾
      </button>
      {open && (
        <div className="sedon-menu-popup sedon-demos-popup">
          {DEMOS.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => loadDemo(d.id)}
              className="sedon-menu-item sedon-demos-item"
            >
              {d.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
