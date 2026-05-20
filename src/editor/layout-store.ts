import { create } from 'zustand';
import type { Viewport } from '@xyflow/react';
import type { CameraState } from './store.js';

// Per-DockView-panel state that's tied to the workspace layout, not the
// authored project. Today this covers:
//
//   • pinnedGraphIds — which graph each Preview pane is locked to (or
//     unset to "follow active"); panelId → graphId
//   • canvasViewports — each Canvas pane's pan/zoom per graph it has
//     viewed; panelId → graphId → Viewport. Indexing on graph too means
//     a single canvas pane that flips between graphs retains a view
//     per graph, the same way a tabbed code editor remembers scroll
//     position per file.
//
// Lives in its own zustand store, separate from `useEditorStore`. This
// is the runtime half of the project/layout split from Phase 1: the
// save file's `layout` block will (eventually) serialize from here.
//
// Note on canvasViewports vs project.viewports: the project's saved
// viewport map (in the editor store / save file) is the cross-session
// "default last view" per graph. Per-panel state here is in-memory only
// and overrides the project map for any panel that's panned/zoomed
// during this session. We deliberately don't write back to
// project.viewports on canvas pan — two panels panning the same graph
// would race the persistent state.
export interface LayoutState {
  /** Preview panel id → pinned graph id ('main' or a subgraph id). */
  pinnedGraphIds: Record<string, string>;

  /**
   * Canvas panel id → graph id the canvas is currently showing/editing.
   * Replaces the previous "all canvases follow currentEditingId" model:
   * with this, each canvas can show a different graph independently.
   * Falls back to currentEditingId on the editor store when unset.
   */
  canvasGraphIds: Record<string, string>;

  /** Panel id → graph id → Viewport. Empty until first pan/zoom. */
  canvasViewports: Record<string, Record<string, Viewport>>;

  /**
   * Most recent canvas viewport per graph, regardless of which panel
   * produced it. Updated on every canvas pan/zoom (alongside the
   * per-panel map above). New panels — opened via "Create Canvas
   * View" or asset-view "Open in Canvas" — seed their initial view
   * from here, so the user gets the last view they had of that graph
   * instead of an unconditional fitView. Splits don't use this: the
   * splitter copies the source panel's exact viewport directly into
   * the new panel's per-panel slot.
   */
  recentCanvasViewports: Record<string, Viewport>;

  /**
   * Panel id → graph id → orbit camera state. Same shape and rationale
   * as canvasViewports — two Preview panes on the same graph each keep
   * their own pan/zoom/rotate without fighting through the project's
   * shared cameras map. The project-level cameras map (in the editor
   * store) is consulted only as the seed when a panel first sees a
   * graph; subsequent gestures write here, not there.
   */
  previewCameras: Record<string, Record<string, CameraState>>;

  /** Most recent preview camera per graph. Same role as recentCanvasViewports. */
  recentPreviewCameras: Record<string, CameraState>;

  /**
   * Last DockView panel of each kind that the user interacted with.
   * Used to route asset-view actions: double-clicking an asset opens
   * it in the last-active canvas; "Open in Preview" pushes it into
   * the last-active preview. App.tsx maintains these via DockView's
   * onDidActivePanelChange.
   */
  lastActiveCanvasPanelId: string | null;
  lastActivePreviewPanelId: string | null;

  /**
   * Pin a Preview panel to a specific graph. Passing `undefined`
   * removes the pin (panel reverts to "follows active").
   */
  setPanelPinnedGraph: (panelId: string, graphId: string | undefined) => void;

  /** Set which graph a canvas panel is currently showing. */
  setCanvasGraphId: (panelId: string, graphId: string) => void;

  /** Forget a canvas's graph pin (e.g. on panel close). */
  clearCanvasGraphId: (panelId: string) => void;

  /** Record a canvas pane's pan/zoom for a specific graph. */
  saveCanvasViewport: (panelId: string, graphId: string, viewport: Viewport) => void;

  /** Record a preview pane's camera state for a specific graph. */
  savePreviewCamera: (panelId: string, graphId: string, camera: CameraState) => void;

  setLastActiveCanvasPanelId: (panelId: string | null) => void;
  setLastActivePreviewPanelId: (panelId: string | null) => void;

  /**
   * Clear the per-session, per-graph camera + viewport state.
   * Project-level state (DockView layout, panel pins) is preserved —
   * the user keeps the same workspace shape across project switches.
   * Called by the demos menu and save-file load before swapping the
   * project in. Without this, a user who dragged the camera around
   * in one project (committing entries into `previewCameras` /
   * `recentPreviewCameras`) sees the new project's Preview pane
   * still on the old camera, because the saved per-panel camera
   * outranks the new project's per-graph framing in the lookup
   * chain. Same story for `canvasViewports` / `recentCanvasViewports`.
   */
  resetForNewProject: () => void;
}

export const useLayoutStore = create<LayoutState>((set) => ({
  pinnedGraphIds: {},
  canvasGraphIds: {},
  canvasViewports: {},
  recentCanvasViewports: {},
  previewCameras: {},
  recentPreviewCameras: {},
  lastActiveCanvasPanelId: null,
  lastActivePreviewPanelId: null,

  setPanelPinnedGraph: (panelId, graphId) =>
    set((state) => {
      const next = { ...state.pinnedGraphIds };
      if (graphId === undefined) {
        delete next[panelId];
      } else {
        next[panelId] = graphId;
      }
      return { pinnedGraphIds: next };
    }),

  setCanvasGraphId: (panelId, graphId) =>
    set((state) => ({
      canvasGraphIds: { ...state.canvasGraphIds, [panelId]: graphId },
    })),

  clearCanvasGraphId: (panelId) =>
    set((state) => {
      if (!(panelId in state.canvasGraphIds)) return state;
      const next = { ...state.canvasGraphIds };
      delete next[panelId];
      return { canvasGraphIds: next };
    }),

  saveCanvasViewport: (panelId, graphId, viewport) =>
    set((state) => ({
      canvasViewports: {
        ...state.canvasViewports,
        [panelId]: {
          ...(state.canvasViewports[panelId] ?? {}),
          [graphId]: viewport,
        },
      },
      // Also bump the per-graph LRU so a future new panel seeing this
      // graph for the first time can pick up the user's last view.
      recentCanvasViewports: {
        ...state.recentCanvasViewports,
        [graphId]: viewport,
      },
    })),

  savePreviewCamera: (panelId, graphId, camera) =>
    set((state) => ({
      previewCameras: {
        ...state.previewCameras,
        [panelId]: {
          ...(state.previewCameras[panelId] ?? {}),
          [graphId]: camera,
        },
      },
      recentPreviewCameras: {
        ...state.recentPreviewCameras,
        [graphId]: camera,
      },
    })),

  setLastActiveCanvasPanelId: (panelId) => set({ lastActiveCanvasPanelId: panelId }),
  setLastActivePreviewPanelId: (panelId) => set({ lastActivePreviewPanelId: panelId }),

  resetForNewProject: () =>
    set({
      // Per-graph pins, viewports, and cameras all tie to graph ids
      // from the OUTGOING project. Loading a new project may share
      // graph ids by accident (every project has 'main') but the
      // saved view is meaningless across projects — different scales,
      // different framings, different scene content. Clearing forces
      // the Preview / NodeCanvas auto-pin effects to re-seed from
      // the incoming project's `projectCameras` on next render.
      pinnedGraphIds: {},
      canvasGraphIds: {},
      canvasViewports: {},
      recentCanvasViewports: {},
      previewCameras: {},
      recentPreviewCameras: {},
    }),
}));
