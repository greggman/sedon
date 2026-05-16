import { layoutGraph, type NodeMeasurement } from './auto-layout.js';
import { getActiveCanvasRf } from './rf-registry.js';
import { useEditorStore } from './store.js';

// Re-flow node positions via rank-based layered layout. Reads measured
// node dimensions from the active canvas's React Flow instance (so
// wide preview-bearing nodes don't collide), runs layoutGraph, then
// writes new positions to the store via commitActivePositions. The
// store bump propagates through every NodeCanvas's syncCounter effect,
// so all canvases viewing this graph see the rearrangement.
//
// "Active canvas" is whatever DockView reports as active, or the most
// recently registered canvas otherwise — better than failing silently
// if focus happens to be in a different panel.
export function CleanupButton() {
  const onClick = () => {
    const rf = getActiveCanvasRf();
    if (!rf) return;
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
    useEditorStore.getState().commitActivePositions(positions);
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
