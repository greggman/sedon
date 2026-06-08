import { create } from 'zustand';

// Lightweight pub/sub for "the user just asked to rename this thing —
// the next render of the corresponding view should enter rename
// mode." Used by:
//
//   • createSubgraphAction (commands.ts) to start the inline rename
//     on the freshly-created subgraph row in the asset view, or on
//     its freshly-placed wrapper node in the canvas.
//   • The node context menu's "Rename" entry.
//   • Anywhere else that wants the Finder-style "create + immediate
//     rename" affordance later.
//
// Subscribers (EditableNodeName, AssetsPanel) consume the request
// when they successfully transition into rename mode. The request
// persists across renders until consumed, so a request fired before
// the relevant view is mounted is still honoured once it appears.
//
// Two parallel channels because the two render surfaces use disjoint
// id spaces (subgraph ids vs node ids) and the same id could
// theoretically collide.

interface RenameBus {
  /** A SubgraphDef id whose tile in the asset view should enter rename
   *  mode on the next applicable render. */
  pendingSubgraphId: string | null;
  /** A GraphNode id whose canvas header should enter rename mode on
   *  the next applicable render. */
  pendingNodeId: string | null;
  requestSubgraphRename: (id: string) => void;
  requestNodeRename: (id: string) => void;
  consumeSubgraphRename: (id: string) => boolean;
  consumeNodeRename: (id: string) => boolean;
}

export const useRenameBus = create<RenameBus>((set, get) => ({
  pendingSubgraphId: null,
  pendingNodeId: null,
  requestSubgraphRename: (id) => set({ pendingSubgraphId: id }),
  requestNodeRename: (id) => set({ pendingNodeId: id }),
  consumeSubgraphRename: (id) => {
    if (get().pendingSubgraphId !== id) return false;
    set({ pendingSubgraphId: null });
    return true;
  },
  consumeNodeRename: (id) => {
    if (get().pendingNodeId !== id) return false;
    set({ pendingNodeId: null });
    return true;
  },
}));

// Imperative helpers — non-hook entry points for action handlers
// outside React (commands.ts).
export function requestSubgraphRename(id: string): void {
  useRenameBus.getState().requestSubgraphRename(id);
}
export function requestNodeRename(id: string): void {
  useRenameBus.getState().requestNodeRename(id);
}
