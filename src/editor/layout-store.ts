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
   * Per-canvas navigation history, browser-style. `entries` is the
   * ordered list of graphs the canvas has visited; `cursor` points at
   * the currently-displayed one. Subgraphs are reusable assets (not
   * a tree), so this is a linear history of "where you've been",
   * NOT a parent hierarchy.
   *
   * Semantics match Chrome/Firefox:
   *   • Back  → cursor--  (does not pop; the entry stays available).
   *   • Forward → cursor++.
   *   • Navigate-to G (drill via Edit / double-click, asset open):
   *       - if entries[cursor]   === G → no-op (already here).
   *       - elif entries[cursor+1] === G → cursor++ (you've gone
   *         forward via the same path you went back from, common
   *         after Back-Edit-same-thing).
   *       - else → truncate forward history past cursor and append G.
   *         (Same as "follow a link" in a browser: the forward arrow
   *         goes away because you've started a new branch.)
   *
   * All navigation paths route through `recordCanvasNavigation` /
   * `goBackCanvasHistory` / `goForwardCanvasHistory` so the cursor
   * always agrees with what the panel is actually showing.
   */
  canvasHistory: Record<string, { entries: string[]; cursor: number }>;

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

  /**
   * Record a navigation to `graphId` in the canvas's history. Applies
   * browser-history rules — see `canvasHistory` above. Does NOT touch
   * `canvasGraphIds`; callers pair this with `setCanvasGraphId` (the
   * helpers in open-graph.ts do both).
   */
  recordCanvasNavigation: (panelId: string, graphId: string) => void;
  /** Move the cursor back one; returns the graph now under it, or
   * undefined if already at the start. */
  goBackCanvasHistory: (panelId: string) => string | undefined;
  /** Move the cursor forward one; returns the graph now under it,
   * or undefined if already at the end. */
  goForwardCanvasHistory: (panelId: string) => string | undefined;
  /** Copy the source panel's history snapshot onto the destination
   * (for "Split" — the new pane should be a literal duplicate, back
   * and forward both populated). */
  cloneCanvasHistory: (srcPanelId: string, dstPanelId: string) => void;

  /** Record a canvas pane's pan/zoom for a specific graph. */
  saveCanvasViewport: (panelId: string, graphId: string, viewport: Viewport) => void;

  /** Record a preview pane's camera state for a specific graph. */
  savePreviewCamera: (panelId: string, graphId: string, camera: CameraState) => void;

  setLastActiveCanvasPanelId: (panelId: string | null) => void;
  setLastActivePreviewPanelId: (panelId: string | null) => void;

  /**
   * Width (in CSS pixels) of the Assets-panel folder tree, controlled
   * by a draggable divider between the tree and the contents list.
   * Project-wide setting — all Assets panels share the same split so
   * a user who likes a wider folder column gets it everywhere. Default
   * is 200 px (close to the old `minmax(140, 25%)` resting value on
   * typical pane widths).
   */
  assetsTreeWidth: number;
  setAssetsTreeWidth: (px: number) => void;

  /**
   * Whether node-canvas thumbnails re-evaluate every animation frame
   * when an `anim/*` node is in the graph. When false, only the
   * dedicated Preview pane animates and node thumbnails freeze at
   * their last-evaluated value. Default true so the feature is
   * discoverable; the user toggles off via View → Animate Node
   * Previews when a busy graph makes per-thumbnail eval expensive.
   *
   * Session-only (the layout store doesn't persist) — reloads reset
   * to the default. If users start asking for it to stick, lift it
   * into a persisted preferences slice.
   */
  showLiveNodePreviews: boolean;
  setShowLiveNodePreviews: (on: boolean) => void;

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

export const useLayoutStore = create<LayoutState>((set, get) => ({
  pinnedGraphIds: {},
  canvasGraphIds: {},
  canvasViewports: {},
  recentCanvasViewports: {},
  canvasHistory: {},
  previewCameras: {},
  recentPreviewCameras: {},
  assetsTreeWidth: 200,
  showLiveNodePreviews: true,
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
      const hasGraph = panelId in state.canvasGraphIds;
      const hasHistory = panelId in state.canvasHistory;
      if (!hasGraph && !hasHistory) return state;
      const nextGraph = { ...state.canvasGraphIds };
      delete nextGraph[panelId];
      const nextHistory = { ...state.canvasHistory };
      delete nextHistory[panelId];
      return { canvasGraphIds: nextGraph, canvasHistory: nextHistory };
    }),

  recordCanvasNavigation: (panelId, graphId) =>
    set((state) => {
      const cur = state.canvasHistory[panelId] ?? { entries: [], cursor: -1 };
      // Already at this graph — nothing to record. Avoids producing
      // adjacent-duplicate entries when the same drill-in fires twice
      // (e.g. component remounts replaying the click handler).
      if (cur.entries[cur.cursor] === graphId) return state;
      let next: { entries: string[]; cursor: number };
      if (cur.entries[cur.cursor + 1] === graphId) {
        // Going forward via the same path we came back from — preserve
        // the forward arrow so back-forth doesn't keep rewriting
        // history.
        next = { entries: cur.entries, cursor: cur.cursor + 1 };
      } else {
        // Different graph than what was next — truncate any forward
        // history (browser semantics: following a "link" closes the
        // forward branch) and append.
        const truncated = cur.entries.slice(0, cur.cursor + 1);
        truncated.push(graphId);
        next = { entries: truncated, cursor: truncated.length - 1 };
      }
      return {
        canvasHistory: { ...state.canvasHistory, [panelId]: next },
      };
    }),

  goBackCanvasHistory: (panelId) => {
    const cur = get().canvasHistory[panelId];
    if (!cur || cur.cursor <= 0) return undefined;
    const nextCursor = cur.cursor - 1;
    set((state) => ({
      canvasHistory: {
        ...state.canvasHistory,
        [panelId]: { entries: cur.entries, cursor: nextCursor },
      },
    }));
    return cur.entries[nextCursor];
  },

  goForwardCanvasHistory: (panelId) => {
    const cur = get().canvasHistory[panelId];
    if (!cur || cur.cursor >= cur.entries.length - 1) return undefined;
    const nextCursor = cur.cursor + 1;
    set((state) => ({
      canvasHistory: {
        ...state.canvasHistory,
        [panelId]: { entries: cur.entries, cursor: nextCursor },
      },
    }));
    return cur.entries[nextCursor];
  },

  cloneCanvasHistory: (srcPanelId, dstPanelId) =>
    set((state) => {
      const src = state.canvasHistory[srcPanelId];
      if (!src) return state;
      return {
        canvasHistory: {
          ...state.canvasHistory,
          [dstPanelId]: { entries: [...src.entries], cursor: src.cursor },
        },
      };
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

  setAssetsTreeWidth: (px) => {
    // Clamp to a sensible range — too narrow and folder labels clip
    // entirely; too wide and the contents list can't show anything.
    // The contents pane keeps a minimum 120 px via the parent grid's
    // 1fr behaviour as long as the body isn't itself extremely narrow.
    const clamped = Math.max(80, Math.min(600, Math.round(px)));
    set({ assetsTreeWidth: clamped });
  },

  setShowLiveNodePreviews: (on) => set({ showLiveNodePreviews: on }),

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
      canvasHistory: {},
      previewCameras: {},
      recentPreviewCameras: {},
    }),
}));
