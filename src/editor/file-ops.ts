import { confirmDiscardIfDirty } from './confirm-dirty.js';
import { useLayoutStore } from './layout-store.js';
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
  // Pans / zooms / orbit gestures during this session go to the layout
  // store's per-graph LRU maps (so multi-pane viewport state stays
  // independent at runtime). For persistence we merge those over the
  // editor store's project maps — runtime wins because it reflects the
  // user's current view. Graphs only seen in a previous session (in
  // project maps, but not touched this session) are preserved.
  const layout = useLayoutStore.getState();
  const cameras = { ...state.cameras, ...layout.recentPreviewCameras };
  const viewports = { ...state.viewports, ...layout.recentCanvasViewports };
  const file: SaveFile = {
    formatVersion: SAVE_FORMAT_VERSION,
    project: {
      graph: state.mainGraph,
      rootNodeId: state.mainRootNodeId,
      subgraphs: state.subgraphs,
      ...(state.folders.length > 0 ? { folders: state.folders } : {}),
      ...(Object.keys(cameras).length > 0 ? { cameras } : {}),
      ...(Object.keys(viewports).length > 0 ? { viewports } : {}),
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
      // Clear runtime LRU maps so the loaded project's viewports/cameras
      // become the new defaults. Without this, stale entries from the
      // previous session would shadow the loaded values (recentCanvas/
      // PreviewCameras win over projectViewports / projectCameras in
      // each panel's lookup chain). Per-panel state stays — existing
      // panels keep their identity but will re-seed from the new
      // project on next access.
      useLayoutStore.setState({
        recentCanvasViewports: {},
        recentPreviewCameras: {},
      });
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
