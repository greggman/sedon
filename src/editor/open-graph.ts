import { getDockviewApi } from './dockview-handle.js';
import { useLayoutStore } from './layout-store.js';
import { useEditorStore } from './store.js';

// "Open graph X in a canvas / preview pane." Used by the asset view and
// (eventually) other navigation affordances. Routes to the
// last-active panel of the requested kind, or creates a fresh panel via
// the DockView API if none exists.
//
// This is what keeps double-click in the asset view from disturbing
// OTHER canvases / previews — the per-panel pinning state (in
// layout-store) is what each panel reads from to know which graph to
// show, and we only update one panel's entry here.

function freshPanelId(component: string): string {
  return `${component}-${crypto.randomUUID().slice(0, 8)}`;
}

function defaultTitleForGraph(graphId: string): string {
  if (graphId === 'main') return 'Main';
  const sg = useEditorStore.getState().subgraphs.find((s) => s.id === graphId);
  return sg?.label ?? graphId;
}

/**
 * Open `graphId` in the most-recently-active canvas pane, creating one
 * if no canvas pane currently exists. Also flips the editor store's
 * `currentEditingId` so edits in this graph route to the right backing
 * (subgraphs[i].graph or mainGraph).
 */
export function openGraphInCanvas(graphId: string): void {
  const dockApi = getDockviewApi();
  const layout = useLayoutStore.getState();
  let panelId = layout.lastActiveCanvasPanelId;
  // Validate that the recorded last-active canvas still exists — a user
  // might have closed it since we recorded the id.
  if (panelId && dockApi && !dockApi.getPanel(panelId)) {
    panelId = null;
  }
  if (!panelId) {
    if (!dockApi) return;
    const fresh = freshPanelId('node-canvas');
    dockApi.addPanel({ id: fresh, component: 'node-canvas', title: 'Canvas' });
    panelId = fresh;
  } else {
    // Bring the existing canvas to focus so the user sees the change.
    dockApi?.getPanel(panelId)?.api.setActive();
  }
  layout.setCanvasGraphId(panelId, graphId);
  useEditorStore.getState().setActiveEditing(graphId);
}

/**
 * Pin `graphId` into the most-recently-active preview pane, creating
 * one if no preview exists. Unlike the canvas path, the editor store's
 * currentEditingId is NOT touched — previews don't drive editing.
 */
export function openGraphInPreview(graphId: string): void {
  const dockApi = getDockviewApi();
  const layout = useLayoutStore.getState();
  let panelId = layout.lastActivePreviewPanelId;
  if (panelId && dockApi && !dockApi.getPanel(panelId)) {
    panelId = null;
  }
  if (!panelId) {
    if (!dockApi) return;
    const fresh = freshPanelId('preview');
    dockApi.addPanel({
      id: fresh,
      component: 'preview',
      title: `Preview: ${defaultTitleForGraph(graphId)}`,
    });
    panelId = fresh;
  } else {
    dockApi?.getPanel(panelId)?.api.setActive();
  }
  layout.setPanelPinnedGraph(panelId, graphId);
}
