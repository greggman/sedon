import { confirmDiscardIfDirty } from './confirm-dirty.js';
import {
  parseSaveFile,
  SAVE_FORMAT_VERSION,
  serializeSaveFile,
  type SaveFile,
} from './save-load.js';
import { useEditorStore } from './store.js';

// Project-level Save / Load. Pure store operations now — no React Flow
// dependency. Per-panel ReactFlowProviders mean there's no longer a
// single "the canvas" the toolbar can sample; instead, NodeCanvas
// commits drag-stop positions to the store continuously, so by the
// time the user clicks Save the store already reflects every drag.
// On Load we bump syncCounter via setGraph; each canvas's existing
// sync effect picks up the new graph and re-renders its RF state.

export function saveProject(): void {
  const state = useEditorStore.getState();
  const file: SaveFile = {
    formatVersion: SAVE_FORMAT_VERSION,
    project: {
      graph: state.mainGraph,
      rootNodeId: state.mainRootNodeId,
      subgraphs: state.subgraphs,
      ...(state.folders.length > 0 ? { folders: state.folders } : {}),
      ...(Object.keys(state.cameras).length > 0 ? { cameras: state.cameras } : {}),
      ...(Object.keys(state.viewports).length > 0 ? { viewports: state.viewports } : {}),
    },
    ...(state.currentEditingId !== 'main'
      ? { layout: { currentEditingId: state.currentEditingId } }
      : {}),
  };
  const json = serializeSaveFile(file);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sedon-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
  useEditorStore.getState().markClean();
}

export function loadProject(): void {
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
      const { project, layout } = parsed;
      const store = useEditorStore.getState();
      store.setGraph(
        project.graph,
        project.rootNodeId,
        project.subgraphs,
        project.cameras,
        project.viewports,
        project.folders,
      );
      if (layout?.currentEditingId && layout.currentEditingId !== 'main') {
        useEditorStore.getState().setActiveEditing(layout.currentEditingId);
      }
      // No rf.setNodes/setEdges here: setGraph bumps syncCounter and
      // every NodeCanvas re-syncs its RF state from the new store
      // graph + the rebuilt registry.
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // eslint-disable-next-line no-alert
      alert(`Failed to load: ${msg}`);
    }
  };
  input.click();
}
