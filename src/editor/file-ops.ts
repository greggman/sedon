import type { SerializedDockview } from 'dockview';
import { confirmDiscardIfDirty } from './confirm-dirty.js';
import { getDockviewApi } from './dockview-handle.js';
import { useLayoutStore } from './layout-store.js';
import {
  parseSaveFile,
  SAVE_FORMAT_VERSION,
  serializeSaveFile,
  type LayoutData,
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

  // Workspace layout: DockView's serialized panel/group tree plus the
  // layout-store's panel-keyed state. Restoring all of this on load
  // brings back the user's full editing setup (which panels exist,
  // which graph each is showing, the view in each panel).
  const dockApi = getDockviewApi();
  const layoutData: LayoutData = {};
  if (state.currentEditingId !== 'main') {
    layoutData.currentEditingId = state.currentEditingId;
  }
  if (dockApi) {
    layoutData.dockview = dockApi.toJSON();
  }
  if (Object.keys(layout.canvasGraphIds).length > 0) {
    layoutData.canvasGraphIds = layout.canvasGraphIds;
  }
  if (Object.keys(layout.pinnedGraphIds).length > 0) {
    layoutData.pinnedGraphIds = layout.pinnedGraphIds;
  }
  if (Object.keys(layout.canvasViewports).length > 0) {
    layoutData.canvasViewports = layout.canvasViewports;
  }
  if (Object.keys(layout.previewCameras).length > 0) {
    layoutData.previewCameras = layout.previewCameras;
  }
  const hasLayout = Object.keys(layoutData).length > 0;

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
    ...(hasLayout ? { layout: layoutData } : {}),
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

      // Workspace layout restore. Order matters:
      //
      //   1. Wholesale-replace the layout-store's panel-keyed maps with
      //      the saved values (or empty if absent). This drops any
      //      orphans from the previous session and pre-positions
      //      pinnedGraphIds / canvasViewports / previewCameras to match
      //      the panels DockView is about to recreate. recentCanvas*
      //      LRU maps are cleared so the loaded project's viewports/
      //      cameras become the new defaults.
      //   2. Call dockApi.fromJSON. DockView fires onDidRemovePanel
      //      for each existing panel — our App listener clears that
      //      panel's canvasGraphIds entry (but not the others). So
      //      after fromJSON, canvasGraphIds may be partially cleared.
      //   3. Re-set canvasGraphIds from the saved value. dockview's
      //      panel-mounts haven't reached React yet (synchronous
      //      block), so each new panel's auto-pin effect sees the
      //      restored value and skips its own default.
      //   4. setActiveEditing for currentEditingId.
      const dockApi = getDockviewApi();
      useLayoutStore.setState({
        canvasGraphIds: layout?.canvasGraphIds ?? {},
        pinnedGraphIds: layout?.pinnedGraphIds ?? {},
        canvasViewports: layout?.canvasViewports ?? {},
        previewCameras: layout?.previewCameras ?? {},
        recentCanvasViewports: {},
        recentPreviewCameras: {},
      });
      if (dockApi && layout?.dockview) {
        dockApi.fromJSON(layout.dockview as SerializedDockview);
        // onDidRemovePanel during fromJSON cleared canvasGraphIds for
        // every removed panel. Reapply.
        if (layout.canvasGraphIds) {
          useLayoutStore.setState({ canvasGraphIds: layout.canvasGraphIds });
        }
      }
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
