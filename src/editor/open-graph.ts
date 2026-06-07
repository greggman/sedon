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
 * Internal: apply a "the canvas is now showing this graph" navigation
 * — record it in the history (browser-style: truncate forward, append)
 * AND mirror it into `canvasGraphIds` + `currentEditingId`. All public
 * entry points (`navigateCanvasTo`, `openGraphInCanvas`, the canvas
 * back/forward) funnel through here so the cursor stays consistent
 * with what the canvas is rendering.
 */
function commitNavigation(panelId: string, graphId: string): void {
  const layout = useLayoutStore.getState();
  layout.recordCanvasNavigation(panelId, graphId);
  layout.setCanvasGraphId(panelId, graphId);
  useEditorStore.getState().setActiveEditing(graphId);
}

/**
 * Drill-style navigation: the user picked "open this graph" inside a
 * known canvas (Edit button on a subgraph wrapper, double-click on its
 * preview, "Edit Iteration" on for-each). Pushes browser-style — see
 * `recordCanvasNavigation` for the rules.
 */
export function navigateCanvasTo(panelId: string, graphId: string): void {
  commitNavigation(panelId, graphId);
}

/**
 * Open `graphId` in the most-recently-active canvas pane, creating one
 * if no canvas pane currently exists. Also flips the editor store's
 * `currentEditingId` so edits in this graph route to the right backing
 * (subgraphs[i].graph or mainGraph).
 *
 * History semantics: same as any other navigation — record in the
 * panel's history per browser rules (truncate forward, append, unless
 * the target matches the next entry). Earlier prototypes reset the
 * stack here, but unifying with the rest of the navigation model
 * lets Back work consistently regardless of HOW the user got here.
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
  commitNavigation(panelId, graphId);
}

/**
 * Move the canvas's history cursor backward and navigate there. No-op
 * at the start of history. Used by the canvas Back button and Cmd-[.
 * Does NOT remove the current entry; Forward returns to it.
 */
export function navigateCanvasBack(panelId: string): void {
  const layout = useLayoutStore.getState();
  const target = layout.goBackCanvasHistory(panelId);
  if (target === undefined) return;
  layout.setCanvasGraphId(panelId, target);
  useEditorStore.getState().setActiveEditing(target);
}

/**
 * Move the canvas's history cursor forward and navigate there. No-op
 * at the end of history. Used by the canvas Forward button and Cmd-].
 */
export function navigateCanvasForward(panelId: string): void {
  const layout = useLayoutStore.getState();
  const target = layout.goForwardCanvasHistory(panelId);
  if (target === undefined) return;
  layout.setCanvasGraphId(panelId, target);
  useEditorStore.getState().setActiveEditing(target);
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
