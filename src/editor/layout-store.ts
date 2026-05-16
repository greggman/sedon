import { create } from 'zustand';

// Per-DockView-panel state that's tied to the workspace layout, not the
// authored project. Today it's just "which graphId is this panel pinned
// to" — keys are DockView panel ids, values are 'main' or a subgraph
// id. A missing entry means the panel "follows active" (= it shows
// whatever the user is currently editing).
//
// Lives in its own zustand store, separate from `useEditorStore`. This
// is the runtime half of the project/layout split from Phase 1: the
// save file's `layout` block will (eventually) serialize from here.
export interface LayoutState {
  /** Panel id → pinned graph id ('main' or a subgraph id). */
  pinnedGraphIds: Record<string, string>;

  /**
   * Pin a panel to a specific graph. Passing `undefined` removes the
   * pin (panel reverts to "follows active").
   */
  setPanelPinnedGraph: (panelId: string, graphId: string | undefined) => void;
}

export const useLayoutStore = create<LayoutState>((set) => ({
  pinnedGraphIds: {},

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
}));
