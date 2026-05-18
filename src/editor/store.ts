import { create } from 'zustand';
import { debug } from '../core/debug.js';
import { createEvalCache, type EvalCache } from '../core/eval-cache.js';
import type { Folder } from '../core/folder.js';
import { wouldCreateFolderCycle } from '../core/folder.js';
import type { Graph, GraphNode, SocketRef } from '../core/graph.js';
import { createEmptySubgraph, type SubgraphDef } from '../core/subgraph.js';
import {
  cloneFolderSubtree,
  cloneSubgraphDef,
  countBrokenRefs as countBrokenRefsImpl,
  nextCopyLabel,
  pruneNestedSelection,
  type AssetSelection,
} from './asset-ops.js';
import {
  applyBackward,
  applyForward,
  type Command,
  type ProjectSnapshot,
} from './command.js';
import { createInitialGraph } from './initial-graph.js';

// Orbit camera state. `target` is the world-space point the camera orbits
// around; yaw/pitch/distance describe its position relative to that point.
// Stored per editing context (main + each subgraph) so navigating back to a
// graph restores how you had it framed.
export interface CameraState {
  yaw: number;
  pitch: number;
  distance: number;
  target: [number, number, number];
}

// React Flow viewport (graph canvas pan + zoom). Stored per editing
// context for the same reason as CameraState: switching from the forest
// graph to a subgraph and back should land you where you were, not at
// some unrelated world-space coordinate the previous graph happened to
// have scrolled to.
export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

export interface EditorState {
  /**
   * The graph currently being edited. Equals mainGraph when
   * currentEditingId is 'main', or the active subgraph's inner graph
   * otherwise. Mutations apply to whichever this points to and are routed
   * back to mainGraph or the matching subgraph entry on commit.
   */
  graph: Graph;
  rootNodeId: string;
  /** The main project graph — preserved while the user navigates into subgraphs. */
  mainGraph: Graph;
  mainRootNodeId: string;
  /**
   * Subgraph definitions available in the project. Their wrappers appear in
   * the Add Node menu under "Subgraphs"; the editor can navigate into each
   * to inspect/modify the inner graph. Replaced (not mutated) so React/
   * zustand subscribers see a new reference.
   */
  subgraphs: SubgraphDef[];
  /**
   * Project-level folders for organizing subgraphs in the Asset view.
   * Pure metadata — doesn't affect evaluation or the registry. Folders
   * form a tree via `Folder.parentFolderId`; subgraphs join the tree
   * via `SubgraphDef.parentFolderId`.
   */
  folders: Folder[];
  /** 'main' or the id of a subgraph in `subgraphs`. Drives which graph the editor displays. */
  currentEditingId: string;
  /**
   * Camera state keyed by editing id. Empty initially; the preview
   * component writes back per-graph state on drag-end and context switch
   * so navigating away and back returns to the same framing.
   */
  cameras: Record<string, CameraState>;
  /**
   * Graph canvas viewport keyed by editing id. Same lifecycle as cameras:
   * NodeCanvas saves on pan/zoom-end and restores on context switch.
   */
  viewports: Record<string, ViewportState>;
  device: GPUDevice | null;
  /**
   * Shared evaluation cache: maps per-node fingerprints to outputs so a
   * re-eval skips any node whose inputs are unchanged. Survives across
   * eval rounds; the preview pipeline calls `sweepCache` after each
   * round to evict entries no consumer touched and destroy their
   * orphaned GPU resources. Reference is stable for the lifetime of the
   * store — mutations happen on the inner Map.
   */
  evalCache: EvalCache;
  /**
   * Live node positions, keyed by editing-context id (`'main'` or a
   * subgraph id) and then by node id. The source of truth for where
   * each node sits on its canvas.
   *
   * Lives here, separate from `graph.nodes[i].position`, because
   * dragging a node is purely a UI concern — it must not change the
   * `graph` / `subgraphs` references, otherwise every consumer
   * (registry rebuild, preview panes, asset thumbnails, node-canvas
   * eval) re-runs even though no node's fingerprint has changed. The
   * `position` field on GraphNode is kept as a save-format carrier:
   * positions get lifted into this slice when a graph enters the
   * store and re-snapshotted onto graph nodes on save.
   */
  nodePositions: Record<string, Record<string, { x: number; y: number }>>;

  // Undo/redo stacks. Each entry is a Command that captures enough state to
  // both apply and reverse it.
  undoStack: Command[];
  redoStack: Command[];
  // Bumped on undo/redo/replaceGraph so node-canvas re-syncs React Flow's
  // local state. Normal action paths (onConnect, onNodesChange, etc.) update
  // RF themselves so they don't bump this; only graph-mutating-from-outside
  // events do.
  syncCounter: number;
  // True when the graph has been mutated since the last load/save. Used to
  // prompt before destructive operations (load file, switch demo).
  dirty: boolean;

  setDevice: (device: GPUDevice | null) => void;

  // Same public API as before — every mutation funnels through dispatch
  // internally, so it's all undoable for free.
  setGraph: (
    graph: Graph,
    rootNodeId: string,
    subgraphs?: SubgraphDef[],
    cameras?: Record<string, CameraState>,
    viewports?: Record<string, ViewportState>,
    folders?: Folder[],
  ) => void;

  /** Create a new folder in the Asset view. Undoable. */
  createFolder: (parentFolderId: string | null, label: string) => string;
  /**
   * Delete a folder. Re-parents any contents to the deleted folder's
   * parent (no recursive prompt). Undoable.
   */
  deleteFolder: (folderId: string) => void;
  /** Move a subgraph into a folder (or to root with `null`). Undoable. */
  moveSubgraphToFolder: (subgraphId: string, folderId: string | null) => void;
  /**
   * Re-parent a folder. Refuses if it would create a cycle (drag a
   * folder into itself or one of its descendants). Undoable.
   */
  moveFolderToFolder: (folderId: string, newParentId: string | null) => void;

  /**
   * Batched delete of any mix of subgraphs + folders. Single undo step.
   * Folders in the selection are removed; their direct children (not
   * already in the deletion set) re-parent to the deleted folder's
   * parent — matching the existing single-folder behavior. Wrapper
   * nodes in OTHER graphs that referenced removed subgraphs are left
   * dangling on purpose; undo restores everything.
   */
  deleteAssets: (selection: AssetSelection) => void;

  /**
   * Deep-clone a mix of subgraphs + folders into their original parent
   * folders. Single undo step. Each clone is renamed "X copy" (or "X
   * copy 2", …) to avoid colliding with the source. Returns the new
   * ids so the caller can update its selection to the freshly-created
   * items.
   */
  duplicateAssets: (selection: AssetSelection) => AssetSelection;

  /**
   * Batched re-parent of selected subgraphs + folders into
   * `targetFolderId` (null = project root). Single undo step. Used by
   * multi-item drag and by paste-of-cut. Refuses to move a folder into
   * itself or any of its descendants.
   */
  moveAssets: (selection: AssetSelection, targetFolderId: string | null) => void;

  /**
   * Deep-clone a selection into `targetFolderId`. Single undo step.
   * Used by paste-of-copy. Differs from `duplicateAssets` in that the
   * destination is explicit instead of the original parent; differs
   * from `moveAssets` in that it produces clones, not in-place moves.
   */
  pasteCopyAssets: (
    selection: AssetSelection,
    targetFolderId: string | null,
  ) => AssetSelection;

  /**
   * Read-only check: how many wrapper nodes across all graphs would
   * become dangling if the given subgraph ids were deleted? Used by
   * the delete-confirm dialog so the user can see the blast radius.
   */
  countBrokenRefs: (subgraphIds: ReadonlySet<string>) => {
    refs: number;
    graphs: number;
  };

  /** Rename a folder. No-op on whitespace-only or unchanged labels. Undoable. */
  renameFolder: (folderId: string, newLabel: string) => void;
  /**
   * Rename a subgraph. Only the user-visible `label` changes — the
   * stable `id` (referenced by every wrapper instance's kind
   * `subgraph/<id>`) is untouched, so all existing edges stay valid.
   * Bumps the subgraph's version so the eval cache invalidates and
   * wrapper instances pick up the new label in their headers. Undoable.
   */
  renameSubgraph: (subgraphId: string, newLabel: string) => void;
  addNode: (node: GraphNode) => void;
  connect: (id: string, from: SocketRef, to: SocketRef) => void;
  removeEdges: (ids: ReadonlySet<string>) => void;
  removeNodes: (ids: ReadonlySet<string>) => void;
  setInputValue: (nodeId: string, name: string, value: unknown) => void;

  /**
   * Append a new per-instance dynamic input socket on a variadic node.
   * Caller is the node's renderer, which knows the def's
   * `extraInputsSpec` and passes the new socket's type + name prefix.
   * The new name is auto-generated as `${namePrefix}_${k}` where k is
   * the next free index past the base + existing extras. Dispatched as
   * a `replaceGraph` command so it's undoable.
   */
  addNodeExtraInput: (
    nodeId: string,
    socketType: string,
    namePrefix: string,
    baseInputCount: number,
  ) => void;

  /**
   * Atomic "drop on +Add" action: append a new extra input AND connect
   * the dragged-from socket to it as a single undoable step. Mirrors
   * `addSubgraphSocketWithEdge` for the subgraph-boundary equivalent.
   */
  addNodeExtraInputWithEdge: (
    nodeId: string,
    socketType: string,
    namePrefix: string,
    baseInputCount: number,
    from: SocketRef,
  ) => void;

  /**
   * Remove a per-instance dynamic input socket plus any edges connected
   * to it. Undoable.
   */
  removeNodeExtraInput: (nodeId: string, name: string) => void;

  /**
   * Switch which graph is being edited. 'main' loads the project's main
   * graph; any other id loads the matching subgraph's inner graph.
   * Clears undo/redo (commands don't carry context across boundaries).
   */
  setActiveEditing: (id: string) => void;

  /**
   * Create a brand-new empty subgraph and switch editing context into it.
   * Caller is responsible for providing a unique id (the store doesn't
   * dedupe — collisions would silently shadow an existing subgraph).
   */
  createSubgraph: (id: string, label: string) => void;

  /**
   * Add an input or output socket to an existing subgraph. Both the
   * subgraph's I/O list and the synthesized boundary node-def will
   * regenerate on the next registry build (memoized on the subgraphs
   * array reference, which this action replaces).
   */
  addSubgraphSocket: (
    subgraphId: string,
    side: 'input' | 'output',
    socket: { label: string; type: string; description?: string },
  ) => void;

  /**
   * Remove a socket from a subgraph. Sweeps every graph in the project
   * to drop edges that referenced it — on the wrapper instances in
   * parent graphs (where the socket appears as wrapper I/O) and inside
   * the subgraph itself (where the boundary node has the matching
   * socket).
   */
  removeSubgraphSocket: (
    subgraphId: string,
    side: 'input' | 'output',
    name: string,
  ) => void;

  /**
   * Add a new subgraph socket with an auto-generated unique "untitled"
   * name and a type derived from the other end of a drag, and wire
   * the edge in the same project-scoped command — so dragging from an
   * inner-node socket onto an "Add Input/Output" target is one undo
   * step that both creates the boundary socket and connects it.
   *
   * For side='output' (new subgraph OUTPUT): edgeEnd is the source
   * (an inner-node output); the edge runs edgeEnd → outputBoundary.
   * For side='input' (new subgraph INPUT): edgeEnd is the target
   * (an inner-node input); the edge runs inputBoundary → edgeEnd.
   */
  addSubgraphSocketWithEdge: (
    subgraphId: string,
    side: 'input' | 'output',
    type: string,
    edgeEnd: { node: string; socket: string },
  ) => void;

  /**
   * Change a subgraph socket's display label. The stable `name` field
   * (used as the React Flow handle id and the edge socket reference)
   * is untouched, so no edges anywhere need rewiring — this is what
   * lets the rename happen without RF's `EdgeWrapper` momentarily
   * looking up a handle id whose DOM measurement isn't yet
   * registered. No-op if no socket with `socketName` exists or if
   * `newLabel` collides with another socket on the same side.
   */
  renameSubgraphSocket: (
    subgraphId: string,
    side: 'input' | 'output',
    socketName: string,
    newLabel: string,
  ) => void;

  /** Persist camera state for a given editing context. */
  saveCameraFor: (id: string, camera: CameraState) => void;

  /** Persist graph-canvas viewport for a given editing context. */
  saveViewportFor: (id: string, viewport: ViewportState) => void;

  /**
   * Capture node positions from the React Flow canvas back into the active
   * graph (drag-to-move only lives in RF state otherwise). Called by the
   * graph-switcher before navigating away and by Save before serializing,
   * so subgraph layouts persist across context switches and survive save.
   */
  commitActivePositions: (
    positionsById: ReadonlyMap<string, { x: number; y: number }>,
  ) => void;

  /** Mark the current state as the saved baseline (called after Save). */
  markClean: () => void;

  undo: () => void;
  redo: () => void;
}

// Walk a graph's nodes and lift any `position` fields into a flat
// nodeId → {x,y} map. Used at the boundaries where a graph enters the
// store (initial load, demo load, save-file load, snapshot replay,
// addNode) to seed the live position slice without depending on
// `graph.nodes[i].position` at runtime.
function extractPositions(graph: Graph): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  for (const n of graph.nodes) {
    if (n.position) out[n.id] = n.position;
  }
  return out;
}

// Reconcile the live position map for one editing context against the
// post-dispatch graph state. Existing entries win (the drag-commit
// path writes live positions and never touches `graph.nodes[i].position`,
// so we don't want a stale carrier to clobber them); new nodes pick
// up whatever the command brought along; removed nodes are dropped.
function mergeNodePositions(
  prev: Record<string, { x: number; y: number }> | undefined,
  graph: Graph,
): Record<string, { x: number; y: number }> {
  const next: Record<string, { x: number; y: number }> = {};
  for (const n of graph.nodes) {
    const existing = prev?.[n.id];
    if (existing) next[n.id] = existing;
    else if (n.position) next[n.id] = n.position;
  }
  return next;
}

const initial = createInitialGraph();
const initialNodePositions: EditorState['nodePositions'] = {
  main: extractPositions(initial.graph),
};

export const useEditorStore = create<EditorState>((set, get) => {
  // Compute the routing-back state — when a mutation produces a new graph,
  // we also need to update either mainGraph (if editing main) or replace
  // the active subgraph's def in the subgraphs array (so the registry
  // memo invalidates and wrappers see the latest inner graph).
  //
  // For subgraph edits we bump `version` so the wrapper's NodeDef.version
  // changes, which flows into the eval cache fingerprint and invalidates
  // cached wrapper outputs across the project. Without this, editing
  // inside a tree subgraph wouldn't trigger a re-eval of forest scenes
  // that contain a tree wrapper.
  function routeBack(nextGraph: Graph, nextRootId: string): Partial<EditorState> {
    const { currentEditingId, subgraphs } = get();
    if (currentEditingId === 'main') {
      return { mainGraph: nextGraph, mainRootNodeId: nextRootId };
    }
    const newSubgraphs = subgraphs.map((s) =>
      s.id === currentEditingId
        ? { ...s, graph: nextGraph, version: (s.version ?? 0) + 1 }
        : s,
    );
    return { subgraphs: newSubgraphs };
  }

  // Snapshot the parts of state that project-scoped commands can touch.
  // Used by `dispatchProject` to capture the "before" half of the
  // replaceProject command so undo can restore everything in one swap.
  function projectSnapshot(): ProjectSnapshot {
    const s = get();
    return {
      subgraphs: s.subgraphs,
      folders: s.folders,
      mainGraph: s.mainGraph,
      mainRootNodeId: s.mainRootNodeId,
      graph: s.graph,
      rootNodeId: s.rootNodeId,
      currentEditingId: s.currentEditingId,
    };
  }

  // Project-scoped dispatch: capture the current snapshot as `before`,
  // apply `after`, push a replaceProject command onto the undo stack.
  // Everything goes through one set() so React renders once. syncCounter
  // bumps because the registry depends on `subgraphs` and the node-canvas
  // may need to re-sync.
  //
  // We also bump `version` on every subgraph whose object reference
  // changed since `before`. Each dispatchProject caller (addSocket,
  // renameSocket, etc.) constructs new subgraph objects only for the
  // ones it actually mutated, so reference inequality is an accurate
  // "this changed" signal. Centralising the bump here means no caller
  // has to remember to do it; the eval cache stays consistent
  // automatically.
  function dispatchProject(after: ProjectSnapshot) {
    const before = projectSnapshot();
    const beforeById = new Map(before.subgraphs.map((s) => [s.id, s]));
    const bumpedSubgraphs = after.subgraphs.map((s) => {
      const prev = beforeById.get(s.id);
      if (!prev || prev === s) return s;
      return { ...s, version: (prev.version ?? 0) + 1 };
    });
    const bumped: ProjectSnapshot = { ...after, subgraphs: bumpedSubgraphs };
    // Reconcile the live position map against every graph in the
    // snapshot. Existing live positions win (so any pending drag isn't
    // clobbered by a save-format carrier); new nodes pick up their
    // position from `graph.nodes[i].position`; deletions drop entries.
    const prevPositions = get().nodePositions;
    const nodePositions: EditorState['nodePositions'] = {
      main: mergeNodePositions(prevPositions.main, bumped.mainGraph),
    };
    for (const sg of bumped.subgraphs) {
      nodePositions[sg.id] = mergeNodePositions(prevPositions[sg.id], sg.graph);
    }
    const cmd: Command = { kind: 'replaceProject', before, after: bumped };
    set({
      ...bumped,
      nodePositions,
      undoStack: [...get().undoStack, cmd],
      redoStack: [],
      dirty: true,
      syncCounter: get().syncCounter + 1,
    });
  }

  // Push `cmd` onto the undo stack and apply it forward. Returns nothing —
  // updates state directly.
  function dispatch(cmd: Command, opts: { bumpSync?: boolean } = {}) {
    debug(() => {
      const detail =
        cmd.kind === 'setInputValue'
          ? ` ${cmd.nodeId}.${cmd.name}=${JSON.stringify(cmd.after)}`
          : '';
      return [`%c=== dispatch ${cmd.kind}${detail} ===`, 'color:#0a0;font-weight:bold'];
    });
    const state = { graph: get().graph, rootNodeId: get().rootNodeId };

    // Coalesce consecutive setInputValue on the same socket. Drag-to-edit
    // emits one command per pixel; without coalescing the undo stack fills
    // with hundreds of micro-edits. Merge them into a single entry whose
    // `before` is the original value and `after` is the latest.
    if (cmd.kind === 'setInputValue') {
      const stack = get().undoStack;
      const last = stack[stack.length - 1];
      if (
        last !== undefined &&
        last.kind === 'setInputValue' &&
        last.nodeId === cmd.nodeId &&
        last.name === cmd.name
      ) {
        const merged: Command = { ...last, after: cmd.after };
        const next = applyForward(state, cmd);
        // setInputValue doesn't change the node set; nodePositions is
        // already in sync, no need to reconcile here.
        set({
          graph: next.graph,
          rootNodeId: next.rootNodeId,
          ...routeBack(next.graph, next.rootNodeId),
          undoStack: [...stack.slice(0, -1), merged],
          redoStack: [],
          dirty: true,
          ...(opts.bumpSync ? { syncCounter: get().syncCounter + 1 } : {}),
        });
        return;
      }
    }

    const next = applyForward(state, cmd);
    // Reconcile this editing context's live position map against the
    // new graph. Most commands (setInputValue, connect, removeEdges)
    // leave the node set unchanged so this is effectively a copy;
    // addNode/removeNodes/replaceGraph are why we need it.
    const { currentEditingId } = get();
    const prevPositions = get().nodePositions;
    const reconciled = mergeNodePositions(prevPositions[currentEditingId], next.graph);
    const nodePositions =
      reconciled === prevPositions[currentEditingId]
        ? prevPositions
        : { ...prevPositions, [currentEditingId]: reconciled };
    set({
      graph: next.graph,
      rootNodeId: next.rootNodeId,
      ...routeBack(next.graph, next.rootNodeId),
      ...(nodePositions !== prevPositions ? { nodePositions } : {}),
      undoStack: [...get().undoStack, cmd],
      redoStack: [],
      dirty: true,
      ...(opts.bumpSync ? { syncCounter: get().syncCounter + 1 } : {}),
    });
  }

  return {
    graph: initial.graph,
    rootNodeId: initial.rootNodeId,
    mainGraph: initial.graph,
    mainRootNodeId: initial.rootNodeId,
    subgraphs: [],
    folders: [],
    currentEditingId: 'main',
    cameras: {},
    viewports: {},
    evalCache: createEvalCache(),
    nodePositions: initialNodePositions,
    device: null,
    undoStack: [],
    redoStack: [],
    syncCounter: 0,
    dirty: false,

    setDevice: (device) => set({ device }),

    // Replace the entire graph (load file, load demo). NOT undoable: clears
    // both undo and redo stacks. Always returns to editing the main graph
    // — switching demos shouldn't drop you inside an old subgraph.
    setGraph: (graph, rootNodeId, subgraphs, cameras, viewports, folders) => {
      // Seed positions from every graph entering the store: main + each
      // subgraph. Each editing context gets its own nodeId→position map.
      const nodePositions: EditorState['nodePositions'] = { main: extractPositions(graph) };
      for (const sg of subgraphs ?? []) {
        nodePositions[sg.id] = extractPositions(sg.graph);
      }
      set({
        graph,
        rootNodeId,
        mainGraph: graph,
        mainRootNodeId: rootNodeId,
        subgraphs: subgraphs ?? [],
        folders: folders ?? [],
        currentEditingId: 'main',
        // New project state ⇒ either the demo-provided initial cameras
        // (so the user sees a sensibly-framed scene on load) or an empty
        // map (each context falls back to DEFAULT_CAMERA on first view).
        cameras: cameras ?? {},
        // Same story for graph viewports: pre-seed if provided, else
        // start empty and let NodeCanvas's fitView fill in on first
        // navigation.
        viewports: viewports ?? {},
        nodePositions,
        undoStack: [],
        redoStack: [],
        dirty: false,
        syncCounter: get().syncCounter + 1,
      });
    },

    createFolder: (parentFolderId, label) => {
      const state = get();
      const id = crypto.randomUUID();
      const folder: Folder = { id, parentFolderId, label };
      dispatchProject({
        ...projectSnapshot(),
        folders: [...state.folders, folder],
      });
      return id;
    },

    deleteFolder: (folderId) => {
      const state = get();
      const target = state.folders.find((f) => f.id === folderId);
      if (!target) return;
      const orphanParent = target.parentFolderId;
      // Re-parent direct children to the deleted folder's parent.
      // (Doesn't recurse — descendants of the deleted folder follow
      // their own parent chain, which by transitivity ends up at
      // orphanParent.)
      const folders = state.folders
        .filter((f) => f.id !== folderId)
        .map((f) => (f.parentFolderId === folderId ? { ...f, parentFolderId: orphanParent } : f));
      const subgraphs = state.subgraphs.map((s) =>
        s.parentFolderId === folderId ? { ...s, parentFolderId: orphanParent } : s,
      );
      dispatchProject({
        ...projectSnapshot(),
        folders,
        subgraphs,
      });
    },

    moveSubgraphToFolder: (subgraphId, folderId) => {
      const state = get();
      const target = state.subgraphs.find((s) => s.id === subgraphId);
      if (!target) return;
      const current = target.parentFolderId ?? null;
      if (current === folderId) return; // no-op
      const subgraphs = state.subgraphs.map((s) =>
        s.id === subgraphId ? { ...s, parentFolderId: folderId } : s,
      );
      dispatchProject({
        ...projectSnapshot(),
        subgraphs,
      });
    },

    deleteAssets: (selection) => {
      const state = get();
      const pruned = pruneNestedSelection(selection, state.folders, state.subgraphs);
      if (pruned.subgraphIds.length === 0 && pruned.folderIds.length === 0) return;
      const deletedFolders = new Set(pruned.folderIds);
      const deletedSubgraphs = new Set(pruned.subgraphIds);
      const folderById = new Map(state.folders.map((f) => [f.id, f]));
      // Walk up the parent chain skipping any folder that's also being
      // deleted, so surviving children land on the closest ancestor that
      // remains. Same idea as the existing single-folder `deleteFolder`.
      const resolveParent = (parentId: string | null): string | null => {
        let cursor = parentId;
        while (cursor !== null && deletedFolders.has(cursor)) {
          cursor = folderById.get(cursor)?.parentFolderId ?? null;
        }
        return cursor;
      };
      const folders = state.folders
        .filter((f) => !deletedFolders.has(f.id))
        .map((f) => {
          const next = resolveParent(f.parentFolderId);
          return next === f.parentFolderId ? f : { ...f, parentFolderId: next };
        });
      const subgraphs = state.subgraphs
        .filter((s) => !deletedSubgraphs.has(s.id))
        .map((s) => {
          const cur = s.parentFolderId ?? null;
          const next = resolveParent(cur);
          return next === cur ? s : { ...s, parentFolderId: next };
        });
      dispatchProject({
        ...projectSnapshot(),
        folders,
        subgraphs,
      });
    },

    duplicateAssets: (selection) => {
      const state = get();
      const pruned = pruneNestedSelection(selection, state.folders, state.subgraphs);
      if (pruned.subgraphIds.length === 0 && pruned.folderIds.length === 0) {
        return { subgraphIds: [], folderIds: [] };
      }
      // labels-in-parent helper, with a working copy so reservations
      // for one clone don't collide with the next when we duplicate two
      // sibling assets in a row.
      const labelsByParent = new Map<string | null, Set<string>>();
      const getLabelsIn = (parentId: string | null): Set<string> => {
        let s = labelsByParent.get(parentId);
        if (s) return s;
        s = new Set<string>();
        for (const f of state.folders) {
          if ((f.parentFolderId ?? null) === parentId) s.add(f.label);
        }
        for (const sg of state.subgraphs) {
          if ((sg.parentFolderId ?? null) === parentId) s.add(sg.label);
        }
        labelsByParent.set(parentId, s);
        return s;
      };

      const newSubgraphs: SubgraphDef[] = [];
      const newFolders: Folder[] = [];
      const newSubgraphIds: string[] = [];
      const newFolderIds: string[] = [];

      // Direct subgraphs first — each clone goes into the source's
      // parent folder, gets a fresh "copy" label, fresh id.
      for (const id of pruned.subgraphIds) {
        const sg = state.subgraphs.find((s) => s.id === id);
        if (!sg) continue;
        const parentId = sg.parentFolderId ?? null;
        const labels = getLabelsIn(parentId);
        const label = nextCopyLabel(labels, sg.label);
        labels.add(label);
        const newId = crypto.randomUUID();
        newSubgraphs.push(cloneSubgraphDef(sg, newId, parentId, label));
        newSubgraphIds.push(newId);
      }

      // Folder subtrees: clone each into its source's parent folder.
      for (const folderId of pruned.folderIds) {
        const folder = state.folders.find((f) => f.id === folderId);
        if (!folder) continue;
        const parentId = folder.parentFolderId;
        const labels = getLabelsIn(parentId);
        const label = nextCopyLabel(labels, folder.label);
        labels.add(label);
        const subtree = cloneFolderSubtree(
          folderId,
          parentId,
          label,
          state.folders,
          state.subgraphs,
        );
        newFolders.push(...subtree.folders);
        newSubgraphs.push(...subtree.subgraphs);
        newFolderIds.push(subtree.rootNewId);
      }

      dispatchProject({
        ...projectSnapshot(),
        folders: [...state.folders, ...newFolders],
        subgraphs: [...state.subgraphs, ...newSubgraphs],
      });
      return { subgraphIds: newSubgraphIds, folderIds: newFolderIds };
    },

    moveAssets: (selection, targetFolderId) => {
      const state = get();
      const pruned = pruneNestedSelection(selection, state.folders, state.subgraphs);
      if (pruned.subgraphIds.length === 0 && pruned.folderIds.length === 0) return;
      // Cycle prevention: refuse if the target is itself one of the
      // moving folders or sits inside one of them. Mirrors the
      // single-folder `moveFolderToFolder` check, generalized to a set.
      const movingFolders = new Set(pruned.folderIds);
      const folderById = new Map(state.folders.map((f) => [f.id, f]));
      const isInsideMovingFolder = (folderId: string | null): boolean => {
        let cursor = folderId;
        while (cursor !== null) {
          if (movingFolders.has(cursor)) return true;
          cursor = folderById.get(cursor)?.parentFolderId ?? null;
        }
        return false;
      };
      if (
        targetFolderId !== null &&
        (movingFolders.has(targetFolderId) || isInsideMovingFolder(targetFolderId))
      ) {
        return;
      }
      const movingSubgraphs = new Set(pruned.subgraphIds);
      let changed = false;
      const folders = state.folders.map((f) => {
        if (!movingFolders.has(f.id)) return f;
        if ((f.parentFolderId ?? null) === targetFolderId) return f;
        changed = true;
        return { ...f, parentFolderId: targetFolderId };
      });
      const subgraphs = state.subgraphs.map((s) => {
        if (!movingSubgraphs.has(s.id)) return s;
        if ((s.parentFolderId ?? null) === targetFolderId) return s;
        changed = true;
        return { ...s, parentFolderId: targetFolderId };
      });
      if (!changed) return;
      dispatchProject({
        ...projectSnapshot(),
        folders,
        subgraphs,
      });
    },

    pasteCopyAssets: (selection, targetFolderId) => {
      const state = get();
      const pruned = pruneNestedSelection(selection, state.folders, state.subgraphs);
      if (pruned.subgraphIds.length === 0 && pruned.folderIds.length === 0) {
        return { subgraphIds: [], folderIds: [] };
      }
      // Build a working label-set for the destination folder so
      // sequential clones don't collide; clones into a folder that
      // already has "Foo copy" produce "Foo copy 2".
      const labelsInTarget = new Set<string>();
      for (const f of state.folders) {
        if ((f.parentFolderId ?? null) === targetFolderId) labelsInTarget.add(f.label);
      }
      for (const sg of state.subgraphs) {
        if ((sg.parentFolderId ?? null) === targetFolderId) labelsInTarget.add(sg.label);
      }
      const newSubgraphs: SubgraphDef[] = [];
      const newFolders: Folder[] = [];
      const newSubgraphIds: string[] = [];
      const newFolderIds: string[] = [];

      // Direct subgraphs: clone with new id into target folder, with
      // a non-colliding label.
      for (const id of pruned.subgraphIds) {
        const sg = state.subgraphs.find((s) => s.id === id);
        if (!sg) continue;
        // Use the original label if it's free; otherwise fall back to
        // the "copy" naming. Paste-of-copy into an unrelated folder is
        // a normal "place a fresh instance" gesture and shouldn't be
        // forced to wear "copy" in its name.
        const baseLabel = labelsInTarget.has(sg.label)
          ? nextCopyLabel(labelsInTarget, sg.label)
          : sg.label;
        labelsInTarget.add(baseLabel);
        const newId = crypto.randomUUID();
        newSubgraphs.push(cloneSubgraphDef(sg, newId, targetFolderId, baseLabel));
        newSubgraphIds.push(newId);
      }

      // Folder subtrees: clone each into the target.
      for (const folderId of pruned.folderIds) {
        const folder = state.folders.find((f) => f.id === folderId);
        if (!folder) continue;
        const baseLabel = labelsInTarget.has(folder.label)
          ? nextCopyLabel(labelsInTarget, folder.label)
          : folder.label;
        labelsInTarget.add(baseLabel);
        const subtree = cloneFolderSubtree(
          folderId,
          targetFolderId,
          baseLabel,
          state.folders,
          state.subgraphs,
        );
        newFolders.push(...subtree.folders);
        newSubgraphs.push(...subtree.subgraphs);
        newFolderIds.push(subtree.rootNewId);
      }

      dispatchProject({
        ...projectSnapshot(),
        folders: [...state.folders, ...newFolders],
        subgraphs: [...state.subgraphs, ...newSubgraphs],
      });
      return { subgraphIds: newSubgraphIds, folderIds: newFolderIds };
    },

    countBrokenRefs: (subgraphIds) => {
      const state = get();
      return countBrokenRefsImpl(subgraphIds, state.mainGraph, state.subgraphs);
    },

    moveFolderToFolder: (folderId, newParentId) => {
      const state = get();
      const target = state.folders.find((f) => f.id === folderId);
      if (!target) return;
      if ((target.parentFolderId ?? null) === newParentId) return; // no-op
      if (wouldCreateFolderCycle(target, newParentId, state.folders)) return;
      const folders = state.folders.map((f) =>
        f.id === folderId ? { ...f, parentFolderId: newParentId } : f,
      );
      dispatchProject({
        ...projectSnapshot(),
        folders,
      });
    },

    renameFolder: (folderId, newLabel) => {
      const trimmed = newLabel.trim();
      if (trimmed.length === 0) return;
      const state = get();
      const target = state.folders.find((f) => f.id === folderId);
      if (!target || target.label === trimmed) return;
      const folders = state.folders.map((f) =>
        f.id === folderId ? { ...f, label: trimmed } : f,
      );
      dispatchProject({
        ...projectSnapshot(),
        folders,
      });
    },

    renameSubgraph: (subgraphId, newLabel) => {
      const trimmed = newLabel.trim();
      if (trimmed.length === 0) return;
      const state = get();
      const target = state.subgraphs.find((s) => s.id === subgraphId);
      if (!target || target.label === trimmed) return;
      const subgraphs = state.subgraphs.map((s) =>
        s.id === subgraphId ? { ...s, label: trimmed } : s,
      );
      dispatchProject({
        ...projectSnapshot(),
        subgraphs,
      });
    },

    saveCameraFor: (id, camera) => {
      set({ cameras: { ...get().cameras, [id]: camera } });
    },

    saveViewportFor: (id, viewport) => {
      set({ viewports: { ...get().viewports, [id]: viewport } });
    },

    commitActivePositions: (positionsById) => {
      // Position commits write ONLY to the live `nodePositions` slice
      // — they never produce a new `graph`/`subgraphs`/`mainGraph`
      // reference. That decoupling is the whole point of this slice:
      // dragging a node mustn't invalidate any selector that consumers
      // (registry useMemo, Preview/AssetThumbnail/NodeCanvas useEffects,
      // eval-cache fingerprints) read from. Every consumer that doesn't
      // explicitly subscribe to `nodePositions` sees no change.
      const state = get();
      const editingId = state.currentEditingId;
      const prevForGraph = state.nodePositions[editingId] ?? {};
      const nextForGraph: Record<string, { x: number; y: number }> = { ...prevForGraph };
      for (const [id, p] of positionsById) nextForGraph[id] = p;
      set({
        nodePositions: { ...state.nodePositions, [editingId]: nextForGraph },
        // syncCounter is unchanged: NodeCanvas subscribes to
        // `nodePositions[editingId]` directly for its merge, so we
        // don't need the heavyweight resync that syncCounter triggers.
        // Position-only changes don't dirty either: same rationale as
        // before — dragging persists position but isn't a model edit.
      });
    },

    createSubgraph: (id, label) => {
      const state = get();
      const sg = createEmptySubgraph(id, label);
      // Hop straight into the new subgraph so the user can start wiring.
      // Eval root is the boundary output — with no sockets and no wired
      // graph yet, that yields an empty outputs object, which evaluateGraph
      // handles gracefully.
      dispatchProject({
        subgraphs: [...state.subgraphs, sg],
        folders: state.folders,
        mainGraph: state.mainGraph,
        mainRootNodeId: state.mainRootNodeId,
        graph: sg.graph,
        rootNodeId: sg.outputNodeId,
        currentEditingId: id,
      });
    },

    addSubgraphSocket: (subgraphId, side, socket) => {
      const state = get();
      const target = state.subgraphs.find((s) => s.id === subgraphId);
      if (!target) return;
      const list = side === 'input' ? target.inputs : target.outputs;
      // Dedupe by label (what the user sees). The internal `name` is a
      // freshly-generated UUID, so it can never collide with anything.
      // The UI prevents collisions but we double-check defensively.
      if (list.some((x) => (x.label ?? x.name) === socket.label)) return;
      const entry: {
        name: string;
        type: string;
        label: string;
        description?: string;
      } = {
        name: crypto.randomUUID(),
        type: socket.type,
        label: socket.label,
      };
      if (socket.description !== undefined) entry.description = socket.description;
      const subgraphs = state.subgraphs.map((s) =>
        s.id !== subgraphId
          ? s
          : side === 'input'
            ? { ...s, inputs: [...s.inputs, entry] }
            : { ...s, outputs: [...s.outputs, entry] },
      );
      dispatchProject({
        subgraphs,
        folders: state.folders,
        mainGraph: state.mainGraph,
        mainRootNodeId: state.mainRootNodeId,
        graph: state.graph,
        rootNodeId: state.rootNodeId,
        currentEditingId: state.currentEditingId,
      });
    },

    removeSubgraphSocket: (subgraphId, side, name) => {
      const state = get();
      const target = state.subgraphs.find((s) => s.id === subgraphId);
      if (!target) return;
      // Boundary-node id inside the inner graph and the socket field on
      // edges depend on which side we're removing:
      //   side='input'  → input boundary; its OUTPUTS expose subgraph
      //                   inputs, so the inner-graph edges have
      //                   from.node = inputNodeId, from.socket = name.
      //                   Parent-graph wrapper instances expose this as
      //                   an INPUT, edges land on to.node/to.socket.
      //   side='output' → mirrored on the other side.
      const boundaryId = side === 'input' ? target.inputNodeId : target.outputNodeId;
      const wrapperKind = `subgraph/${subgraphId}`;

      const stripInner = (g: Graph): Graph => ({
        ...g,
        edges: g.edges.filter((e) => {
          if (side === 'input') {
            return !(e.from.node === boundaryId && e.from.socket === name);
          }
          return !(e.to.node === boundaryId && e.to.socket === name);
        }),
      });
      const stripParent = (g: Graph): Graph => ({
        ...g,
        edges: g.edges.filter((e) => {
          const fromNode = g.nodes.find((n) => n.id === e.from.node);
          const toNode = g.nodes.find((n) => n.id === e.to.node);
          if (side === 'input') {
            return !(toNode?.kind === wrapperKind && e.to.socket === name);
          }
          return !(fromNode?.kind === wrapperKind && e.from.socket === name);
        }),
      });

      // Rebuild subgraphs: update I/O list, strip inner-boundary edges in
      // the target's inner graph, strip wrapper-instance edges in every
      // other subgraph's inner graph.
      const subgraphs = state.subgraphs.map((s) => {
        if (s.id === subgraphId) {
          const list = side === 'input' ? s.inputs : s.outputs;
          const nextList = list.filter((x) => x.name !== name);
          const nextInner = stripInner(s.graph);
          return side === 'input'
            ? { ...s, inputs: nextList, graph: nextInner }
            : { ...s, outputs: nextList, graph: nextInner };
        }
        return { ...s, graph: stripParent(s.graph) };
      });

      // Main graph also might host wrapper instances.
      const mainGraph = stripParent(state.mainGraph);

      // Re-point the active `graph` at the updated inner graph of
      // whichever context we're currently editing.
      const activeGraph =
        state.currentEditingId === 'main'
          ? mainGraph
          : subgraphs.find((s) => s.id === state.currentEditingId)?.graph ?? state.graph;

      dispatchProject({
        subgraphs,
        folders: state.folders,
        mainGraph,
        mainRootNodeId: state.mainRootNodeId,
        graph: activeGraph,
        rootNodeId: state.rootNodeId,
        currentEditingId: state.currentEditingId,
      });
    },

    addSubgraphSocketWithEdge: (subgraphId, side, type, edgeEnd) => {
      const state = get();
      const target = state.subgraphs.find((s) => s.id === subgraphId);
      if (!target) return;
      const list = side === 'input' ? target.inputs : target.outputs;
      // Stable handle id (UUID) — never user-visible, never changes.
      // The user-visible label dedupes as "untitled" / "untitled-2" / ...
      // so drag-creating several sockets in a row produces a sensible
      // column of labels rather than a wall of "untitled"s.
      const name = crypto.randomUUID();
      let label = 'untitled';
      if (list.some((x) => (x.label ?? x.name) === label)) {
        for (let i = 2; ; i++) {
          const candidate = `untitled-${i}`;
          if (!list.some((x) => (x.label ?? x.name) === candidate)) {
            label = candidate;
            break;
          }
        }
      }
      const newEntry = { name, type, label };
      // For 'output' side, the new socket is an INPUT on the output
      // boundary, and the edge runs inner-node-output → boundary.
      // For 'input' side, the new socket is an OUTPUT on the input
      // boundary, and the edge runs boundary → inner-node-input.
      const boundaryId = side === 'input' ? target.inputNodeId : target.outputNodeId;
      const newEdge =
        side === 'output'
          ? { id: crypto.randomUUID(), from: edgeEnd, to: { node: boundaryId, socket: name } }
          : { id: crypto.randomUUID(), from: { node: boundaryId, socket: name }, to: edgeEnd };

      const updatedInner = { ...target.graph, edges: [...target.graph.edges, newEdge] };
      const updatedTarget =
        side === 'input'
          ? { ...target, inputs: [...target.inputs, newEntry], graph: updatedInner }
          : { ...target, outputs: [...target.outputs, newEntry], graph: updatedInner };
      const subgraphs = state.subgraphs.map((s) =>
        s.id === subgraphId ? updatedTarget : s,
      );

      // If we're editing the affected subgraph, sync the active graph
      // pointer to the updated inner graph so the new edge appears.
      const activeGraph =
        state.currentEditingId === subgraphId ? updatedInner : state.graph;

      dispatchProject({
        subgraphs,
        folders: state.folders,
        mainGraph: state.mainGraph,
        mainRootNodeId: state.mainRootNodeId,
        graph: activeGraph,
        rootNodeId: state.rootNodeId,
        currentEditingId: state.currentEditingId,
      });
    },

    renameSubgraphSocket: (subgraphId, side, socketName, newLabel) => {
      const state = get();
      const target = state.subgraphs.find((s) => s.id === subgraphId);
      if (!target) return;
      const list = side === 'input' ? target.inputs : target.outputs;
      const entry = list.find((x) => x.name === socketName);
      if (!entry) return;
      const currentLabel = entry.label ?? entry.name;
      if (currentLabel === newLabel) return;
      // Collision on the user-facing display name. The UI validates
      // first; this is defensive.
      if (
        list.some((x) => x.name !== socketName && (x.label ?? x.name) === newLabel)
      ) {
        return;
      }
      // Only the user-visible `label` changes. The stable `name` (UUID
      // for new sockets, original name for legacy data) is what edges
      // and React Flow handle ids reference, so no inner-graph edges
      // and no wrapper-instance edges need rewiring — they keep
      // pointing at the same handle id, which keeps the same DOM
      // measurement, which keeps RF's edge router happy across the
      // rename.
      const updatedList = list.map((x) =>
        x.name === socketName ? { ...x, label: newLabel } : x,
      );
      const subgraphs = state.subgraphs.map((s) =>
        s.id === subgraphId
          ? side === 'input'
            ? { ...s, inputs: updatedList }
            : { ...s, outputs: updatedList }
          : s,
      );
      dispatchProject({
        subgraphs,
        folders: state.folders,
        mainGraph: state.mainGraph,
        mainRootNodeId: state.mainRootNodeId,
        graph: state.graph,
        rootNodeId: state.rootNodeId,
        currentEditingId: state.currentEditingId,
      });
    },

    setActiveEditing: (id) => {
      const state = get();
      if (state.currentEditingId === id) return;
      debug(`%c=== setActiveEditing ${state.currentEditingId} -> ${id} ===`, 'color:#0a0;font-weight:bold');
      // Strip graph-scoped entries from the undo/redo stacks — they're
      // tied to the previous context's active graph and would target the
      // wrong graph if replayed after the switch. Project-scoped entries
      // (`replaceProject`) carry their full snapshot, so they're safe to
      // keep, which means socket adds/removes and subgraph creations can
      // still be undone after navigating between graphs.
      const keepProjectOnly = (stack: typeof state.undoStack) =>
        stack.filter((c) => c.kind === 'replaceProject');
      if (id === 'main') {
        set({
          currentEditingId: 'main',
          graph: state.mainGraph,
          rootNodeId: state.mainRootNodeId,
          undoStack: keepProjectOnly(state.undoStack),
          redoStack: keepProjectOnly(state.redoStack),
          syncCounter: state.syncCounter + 1,
        });
      } else {
        const sg = state.subgraphs.find((s) => s.id === id);
        if (!sg) return;
        // Prefer a core/output inside the subgraph as the eval root when
        // viewing standalone — that's the user's "this is how I want
        // this previewed" override. Falls back to the boundary output
        // otherwise; the preview pane then synthesizes one tile per
        // declared subgraph output (Texture2D → plane, Material →
        // sphere, etc.).
        //
        // Subgraphs whose boundary output depends on a parent-supplied
        // input (e.g. tree-subgraphs whose scatter needs `points`) need
        // a core/output to render anything standalone, since the
        // boundary output would otherwise see undefined and return
        // nothing.
        const previewOutput = sg.graph.nodes.find((n) => n.kind === 'core/output');
        const rootNodeId = previewOutput?.id ?? sg.outputNodeId;
        set({
          currentEditingId: id,
          graph: sg.graph,
          rootNodeId,
          undoStack: keepProjectOnly(state.undoStack),
          redoStack: keepProjectOnly(state.redoStack),
          syncCounter: state.syncCounter + 1,
        });
      }
    },

    markClean: () => set({ dirty: false }),

    addNode: (node) => {
      dispatch({ kind: 'addNode', node });
    },

    connect: (id, from, to) => {
      const replaced =
        get().graph.edges.find(
          (e) => e.to.node === to.node && e.to.socket === to.socket,
        ) ?? null;
      dispatch({ kind: 'connect', edge: { id, from, to }, replaced });
    },

    removeEdges: (ids) => {
      if (ids.size === 0) return;
      const removed = get().graph.edges.filter((e) => ids.has(e.id));
      if (removed.length === 0) return;
      dispatch({ kind: 'removeEdges', edges: removed });
    },

    removeNodes: (ids) => {
      if (ids.size === 0) return;
      const graph = get().graph;
      const nodes = graph.nodes.filter((n) => ids.has(n.id));
      const edges = graph.edges.filter(
        (e) => ids.has(e.from.node) || ids.has(e.to.node),
      );
      if (nodes.length === 0) return;
      dispatch({ kind: 'removeNodes', nodes, edges });
    },

    setInputValue: (nodeId, name, value) => {
      const node = get().graph.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const before = node.inputValues?.[name];
      if (before === value) return;
      dispatch({ kind: 'setInputValue', nodeId, name, before, after: value });
    },

    addNodeExtraInput: (nodeId, socketType, namePrefix, baseInputCount) => {
      const state = get();
      const node = state.graph.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const existing = node.extraInputs ?? [];
      // Next free k = total socket count so far. Avoids colliding with
      // base inputs OR existing extras.
      const k = baseInputCount + existing.length;
      // Extras are always optional — adding a socket shouldn't break the
      // node until it's wired up. The node's evaluate() is responsible
      // for tolerating undefined-valued inputs (scene-merge skips them).
      const newInput = { name: `${namePrefix}_${k}`, type: socketType, optional: true };
      const updatedNode: GraphNode = {
        ...node,
        extraInputs: [...existing, newInput],
      };
      const before = { graph: state.graph, rootNodeId: state.rootNodeId };
      const after = {
        graph: {
          ...state.graph,
          nodes: state.graph.nodes.map((n) => (n.id === nodeId ? updatedNode : n)),
        },
        rootNodeId: state.rootNodeId,
      };
      dispatch({ kind: 'replaceGraph', before, after });
    },

    addNodeExtraInputWithEdge: (nodeId, socketType, namePrefix, baseInputCount, from) => {
      const state = get();
      const node = state.graph.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const existing = node.extraInputs ?? [];
      const k = baseInputCount + existing.length;
      const socketName = `${namePrefix}_${k}`;
      const newInput = { name: socketName, type: socketType, optional: true };
      const updatedNode: GraphNode = {
        ...node,
        extraInputs: [...existing, newInput],
      };
      const newEdge = {
        id: crypto.randomUUID(),
        from,
        to: { node: nodeId, socket: socketName },
      };
      const before = { graph: state.graph, rootNodeId: state.rootNodeId };
      const after = {
        graph: {
          ...state.graph,
          nodes: state.graph.nodes.map((n) => (n.id === nodeId ? updatedNode : n)),
          edges: [...state.graph.edges, newEdge],
        },
        rootNodeId: state.rootNodeId,
      };
      dispatch({ kind: 'replaceGraph', before, after });
    },

    removeNodeExtraInput: (nodeId, name) => {
      const state = get();
      const node = state.graph.nodes.find((n) => n.id === nodeId);
      if (!node || !node.extraInputs) return;
      const updatedExtras = node.extraInputs.filter((i) => i.name !== name);
      if (updatedExtras.length === node.extraInputs.length) return; // not found
      const updatedNode: GraphNode = {
        ...node,
        // Drop the field entirely when empty so JSON saves stay tidy.
        ...(updatedExtras.length > 0 ? { extraInputs: updatedExtras } : {}),
      };
      if (updatedExtras.length === 0) delete (updatedNode as { extraInputs?: unknown }).extraInputs;
      // Drop any edges that targeted the removed socket.
      const updatedEdges = state.graph.edges.filter(
        (e) => !(e.to.node === nodeId && e.to.socket === name),
      );
      const before = { graph: state.graph, rootNodeId: state.rootNodeId };
      const after = {
        graph: {
          ...state.graph,
          nodes: state.graph.nodes.map((n) => (n.id === nodeId ? updatedNode : n)),
          edges: updatedEdges,
        },
        rootNodeId: state.rootNodeId,
      };
      dispatch({ kind: 'replaceGraph', before, after });
    },

    undo: () => {
      const stack = get().undoStack;
      if (stack.length === 0) return;
      const cmd = stack[stack.length - 1]!;
      // Project-scoped commands swap the entire snapshot; graph-scoped
      // ones route through applyBackward as before.
      if (cmd.kind === 'replaceProject') {
        const prevPositions = get().nodePositions;
        const nodePositions: EditorState['nodePositions'] = {
          main: mergeNodePositions(prevPositions.main, cmd.before.mainGraph),
        };
        for (const sg of cmd.before.subgraphs) {
          nodePositions[sg.id] = mergeNodePositions(prevPositions[sg.id], sg.graph);
        }
        set({
          ...cmd.before,
          nodePositions,
          undoStack: stack.slice(0, -1),
          redoStack: [...get().redoStack, cmd],
          syncCounter: get().syncCounter + 1,
        });
        return;
      }
      const state = { graph: get().graph, rootNodeId: get().rootNodeId };
      const next = applyBackward(state, cmd);
      const { currentEditingId } = get();
      const prevPositions = get().nodePositions;
      const reconciled = mergeNodePositions(prevPositions[currentEditingId], next.graph);
      const nodePositions =
        reconciled === prevPositions[currentEditingId]
          ? prevPositions
          : { ...prevPositions, [currentEditingId]: reconciled };
      set({
        graph: next.graph,
        rootNodeId: next.rootNodeId,
        ...routeBack(next.graph, next.rootNodeId),
        ...(nodePositions !== prevPositions ? { nodePositions } : {}),
        undoStack: stack.slice(0, -1),
        redoStack: [...get().redoStack, cmd],
        syncCounter: get().syncCounter + 1,
      });
    },

    redo: () => {
      const stack = get().redoStack;
      if (stack.length === 0) return;
      const cmd = stack[stack.length - 1]!;
      if (cmd.kind === 'replaceProject') {
        const prevPositions = get().nodePositions;
        const nodePositions: EditorState['nodePositions'] = {
          main: mergeNodePositions(prevPositions.main, cmd.after.mainGraph),
        };
        for (const sg of cmd.after.subgraphs) {
          nodePositions[sg.id] = mergeNodePositions(prevPositions[sg.id], sg.graph);
        }
        set({
          ...cmd.after,
          nodePositions,
          undoStack: [...get().undoStack, cmd],
          redoStack: stack.slice(0, -1),
          syncCounter: get().syncCounter + 1,
        });
        return;
      }
      const state = { graph: get().graph, rootNodeId: get().rootNodeId };
      const next = applyForward(state, cmd);
      const { currentEditingId } = get();
      const prevPositions = get().nodePositions;
      const reconciled = mergeNodePositions(prevPositions[currentEditingId], next.graph);
      const nodePositions =
        reconciled === prevPositions[currentEditingId]
          ? prevPositions
          : { ...prevPositions, [currentEditingId]: reconciled };
      set({
        graph: next.graph,
        rootNodeId: next.rootNodeId,
        ...routeBack(next.graph, next.rootNodeId),
        ...(nodePositions !== prevPositions ? { nodePositions } : {}),
        undoStack: [...get().undoStack, cmd],
        redoStack: stack.slice(0, -1),
        syncCounter: get().syncCounter + 1,
      });
    },
  };
});
