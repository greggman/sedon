import { useReactFlow } from '@xyflow/react';
import { confirmDiscardIfDirty } from './confirm-dirty.js';
import { buildRegistry } from './registry.js';
import { graphToRfEdges, graphToRfNodes } from './rf-conversion.js';
import {
  parseSaveFile,
  SAVE_FORMAT_VERSION,
  serializeSaveFile,
  type SaveFile,
} from './save-load.js';
import { useEditorStore } from './store.js';

export function FileMenu() {
  const rf = useReactFlow();
  const setGraph = useEditorStore((s) => s.setGraph);
  const markClean = useEditorStore((s) => s.markClean);
  const commitActivePositions = useEditorStore((s) => s.commitActivePositions);

  const onSave = () => {
    // First, sync the active graph's drag-positions back to the store so
    // they get serialized. Whichever graph is currently being edited (main
    // or a subgraph) sees its positions persisted.
    const activePositions = new Map(
      rf.getNodes().map((n) => [n.id, n.position]),
    );
    commitActivePositions(activePositions);

    // Read MAIN graph + subgraphs from the store (NOT the active graph,
    // which may be a subgraph the user is currently editing — Save always
    // serializes the whole project).
    const state = useEditorStore.getState();
    const file: SaveFile = {
      formatVersion: SAVE_FORMAT_VERSION,
      graph: state.mainGraph,
      rootNodeId: state.mainRootNodeId,
      subgraphs: state.subgraphs,
    };
    const json = serializeSaveFile(file);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sedon-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    markClean();
  };

  const onLoad = () => {
    if (!confirmDiscardIfDirty()) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = parseSaveFile(text);
        setGraph(parsed.graph, parsed.rootNodeId, parsed.subgraphs);
        const registry = buildRegistry(parsed.subgraphs);
        rf.setNodes(graphToRfNodes(parsed.graph));
        rf.setEdges(graphToRfEdges(parsed.graph, registry));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-alert
        alert(`Failed to load: ${msg}`);
      }
    };
    input.click();
  };

  return (
    <>
      <button type="button" onClick={onSave} className="sedon-toolbar-button" title="Download graph as JSON">
        Save
      </button>
      <button type="button" onClick={onLoad} className="sedon-toolbar-button" title="Load graph from JSON">
        Load
      </button>
    </>
  );
}
