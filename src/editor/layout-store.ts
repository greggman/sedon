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
  /** Panel id → pinned graph id ('main' or a subgraph id). */
  pinnedGraphIds: Record<string, string>;

  /** Panel id → graph id → Viewport. Empty until first pan/zoom. */
  canvasViewports: Record<string, Record<string, Viewport>>;

  /**
   * Panel id → graph id → orbit camera state. Same shape and rationale
   * as canvasViewports — two Preview panes on the same graph each keep
   * their own pan/zoom/rotate without fighting through the project's
   * shared cameras map. The project-level cameras map (in the editor
   * store) is consulted only as the seed when a panel first sees a
   * graph; subsequent gestures write here, not there.
   */
  previewCameras: Record<string, Record<string, CameraState>>;

  /**
   * Pin a panel to a specific graph. Passing `undefined` removes the
   * pin (panel reverts to "follows active").
   */
  setPanelPinnedGraph: (panelId: string, graphId: string | undefined) => void;

  /** Record a canvas pane's pan/zoom for a specific graph. */
  saveCanvasViewport: (panelId: string, graphId: string, viewport: Viewport) => void;

  /** Record a preview pane's camera state for a specific graph. */
  savePreviewCamera: (panelId: string, graphId: string, camera: CameraState) => void;
}

export const useLayoutStore = create<LayoutState>((set) => ({
  pinnedGraphIds: {},
  canvasViewports: {},
  previewCameras: {},

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

  saveCanvasViewport: (panelId, graphId, viewport) =>
    set((state) => ({
      canvasViewports: {
        ...state.canvasViewports,
        [panelId]: {
          ...(state.canvasViewports[panelId] ?? {}),
          [graphId]: viewport,
        },
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
    })),
}));
