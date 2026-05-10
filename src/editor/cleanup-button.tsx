import { useReactFlow } from '@xyflow/react';
import { layoutGraph, type NodeMeasurement } from './auto-layout.js';
import { useEditorStore } from './store.js';

// Re-flow node positions via rank-based layered layout. Reads measured
// node dimensions from React Flow (so wide preview-bearing nodes don't
// collide), runs layoutGraph, and writes new positions back. Doesn't touch
// the graph topology — just node positions, same as a manual drag would.
export function CleanupButton() {
  const rf = useReactFlow();

  const onClick = () => {
    const graph = useEditorStore.getState().graph;
    const rfNodes = rf.getNodes();

    const measured = new Map<string, NodeMeasurement | undefined>();
    for (const n of rfNodes) {
      const m = n.measured;
      if (!m) {
        measured.set(n.id, undefined);
        continue;
      }
      const entry: NodeMeasurement = {};
      if (m.width !== undefined) entry.width = m.width;
      if (m.height !== undefined) entry.height = m.height;
      measured.set(n.id, entry);
    }

    const positions = layoutGraph(graph, measured);

    rf.setNodes((current) =>
      current.map((n) => {
        const pos = positions.get(n.id);
        return pos ? { ...n, position: pos } : n;
      }),
    );

    // Frame the new layout.
    requestAnimationFrame(() => rf.fitView({ padding: 0.2 }));
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className="sedon-toolbar-button"
      title="Auto-arrange nodes"
    >
      Cleanup
    </button>
  );
}
