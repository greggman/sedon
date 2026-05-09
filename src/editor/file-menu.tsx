import { useReactFlow } from '@xyflow/react';
import { fromJSON, type Graph } from '../core/graph.js';
import { graphToRfEdges, graphToRfNodes } from './rf-conversion.js';
import { useEditorStore } from './store.js';

const SAVE_FORMAT_VERSION = 1;

interface SaveFile {
  formatVersion: typeof SAVE_FORMAT_VERSION;
  graph: Graph;
  rootNodeId: string;
}

export function FileMenu() {
  const rf = useReactFlow();
  const graph = useEditorStore((s) => s.graph);
  const rootNodeId = useEditorStore((s) => s.rootNodeId);
  const setGraph = useEditorStore((s) => s.setGraph);

  const onSave = () => {
    // Gather current positions from React Flow (the store doesn't track them)
    // and merge them into the graph's nodes for serialization.
    const positionsById = new Map(rf.getNodes().map((n) => [n.id, n.position]));
    const exported: Graph = {
      ...graph,
      nodes: graph.nodes.map((n) => {
        const pos = positionsById.get(n.id);
        return pos ? { ...n, position: pos } : n;
      }),
    };
    const file: SaveFile = {
      formatVersion: SAVE_FORMAT_VERSION,
      graph: exported,
      rootNodeId,
    };
    const json = JSON.stringify(file, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sedon-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onLoad = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as Partial<SaveFile>;
        if (parsed.formatVersion !== SAVE_FORMAT_VERSION) {
          throw new Error(
            `unsupported save file format ${parsed.formatVersion} (expected ${SAVE_FORMAT_VERSION})`,
          );
        }
        if (typeof parsed.rootNodeId !== 'string') {
          throw new Error('missing rootNodeId');
        }
        // fromJSON re-validates the inner graph version + shape.
        const loadedGraph = fromJSON(JSON.stringify(parsed.graph));

        setGraph(loadedGraph, parsed.rootNodeId);
        rf.setNodes(graphToRfNodes(loadedGraph));
        rf.setEdges(graphToRfEdges(loadedGraph));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-alert
        alert(`Failed to load: ${msg}`);
      }
    };
    input.click();
  };

  return (
    <div style={menuStyle}>
      <button type="button" onClick={onSave} style={buttonStyle} title="Download graph as JSON">
        Save
      </button>
      <button type="button" onClick={onLoad} style={buttonStyle} title="Load graph from JSON">
        Load
      </button>
    </div>
  );
}

const menuStyle: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  zIndex: 10,
  display: 'flex',
  gap: 4,
};

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
