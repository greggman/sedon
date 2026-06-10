import { create } from 'zustand';
import { debug } from '../core/debug.js';
import { createEvalCache, type EvalCache } from '../core/eval-cache.js';
import type { Folder } from '../core/folder.js';
import { wouldCreateFolderCycle } from '../core/folder.js';
import { addEdge, addNode, createGraph, type Graph, type GraphEdge, type GraphNode, type SocketRef } from '../core/graph.js';
import type { InputDef, OutputDef } from '../core/node-def.js';
import {
  liftForEachInputType,
  liftForEachOutputType,
} from '../nodes/for-each-point.js';
import { createEmptySubgraph, isSubgraphInternalKind, type SubgraphDef } from '../core/subgraph.js';
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
import { extractSelectionAsSubgraph } from './extract-subgraph.js';
import { createInitialGraph } from './initial-graph.js';
import { useLayoutStore } from './layout-store.js';
import { wrapActionsSlice } from './recording.js';

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
  /**
   * Single-shot barrier flag. When true, the NEXT dispatch's
   * coalescing check is skipped (treated as if the previous undo
   * entry had `coalesce: false`), and the flag is reset to false.
   *
   * Set by `markUndoBarrier()`. Used by widgets with natural
   * "session" boundaries the dispatcher can't otherwise detect — a
   * NumberInput slider's pointer-up marks the end of a scrub
   * session so the NEXT scrub on the same socket starts a fresh
   * undo entry rather than merging into the previous scrub's
   * entry.
   *
   * Without this, two scrubs in a row (pointer-down → drag →
   * pointer-up → pointer-down → drag → pointer-up) would collapse
   * into ONE undo entry because no command kind / coalesce flag
   * changes between them.
   */
  undoBarrierPending: boolean;
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
   * Atomically merge a fragment import (nodes + edges into the
   * currently-edited graph, new subgraph defs into the project's
   * subgraph list) as ONE undoable step. Backs Paste, Merge, and
   * any future "drop a .sedon onto the canvas" gesture.
   *
   * The caller is responsible for running the fragment through
   * `importFragment` first — that's where id remapping and
   * collision-avoidance live. This action just splats the result
   * into the right places via the existing project-snapshot
   * pipeline so undo/redo and version-bumping work for free.
   */
  mergeImportedFragment: (imported: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    subgraphs: SubgraphDef[];
  }) => void;

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
  /**
   * Combined node + edge removal as a single undo entry. ReactFlow
   * fires `onDelete` once with both lists when the user presses
   * Delete on a node with connections; routing both through a
   * `batch` command keeps that as one Cmd-Z, not two.
   */
  removeNodesAndEdges: (nodeIds: ReadonlySet<string>, edgeIds: ReadonlySet<string>) => void;
  setInputValue: (nodeId: string, name: string, value: unknown, opts?: { coalesce?: boolean }) => void;
  /**
   * One-shot barrier: arms `undoBarrierPending` so the NEXT
   * coalesce-eligible dispatch will NOT merge with the previous
   * undo entry. Use to mark "session boundaries" the dispatcher
   * can't otherwise detect — most notably a NumberInput scrub's
   * pointer-up, so two consecutive scrubs on the same socket stay
   * as two distinct undo entries instead of collapsing.
   *
   * If the next dispatch never comes (the barrier stays armed), no
   * harm: subsequent calls find the flag, skip coalescing, clear it.
   */
  markUndoBarrier: () => void;
  /**
   * Set or clear the cosmetic name of a node (shown in the node header).
   * An empty / whitespace-only string clears the name back to the kind
   * default. Dispatched as a `replaceGraph` so it's one undo step per
   * commit (Enter / blur), not per keystroke.
   */
  renameNode: (nodeId: string, name: string) => void;

  /**
   * Attach a body subgraph to a `core/for-each-point` instance.
   * Atomically:
   *   • Builds (or rebuilds) the node's private bridge SubgraphDef,
   *     placing the body wrapper inside between the bridge's
   *     iteration-input and iteration-output boundaries.
   *   • Auto-wires iteration-input.<name> → body.<name> for any body
   *     inputs that match the iteration kind's provided context names
   *     (`position`, `index`).
   *   • Auto-wires body.<name> → iteration-output.<name> for the body
   *     outputs whose types lift cleanly (Scene / Float / Vec3).
   *   • Mirrors the body's REGULAR (non-context-name) inputs onto the
   *     for-each-point's `extraInputs` as cloud-lifted broadcast
   *     sockets (Float→FloatCloud, Vec3→Vec3Cloud, else broadcast).
   *   • Mirrors the bridge's outputs onto the for-each-point's
   *     `extraOutputs` (lifted same way as input mirroring).
   *   • Drops edges to/from now-stale sockets on the for-each-point.
   *
   * Replacing an existing body: the prior bridge is discarded in
   * favour of a fresh one. One undoable command.
   */
  attachIterationBody: (nodeId: string, bodyKind: string) => void;

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
   * Encapsulate the given nodes from the current editing graph into
   * a brand-new subgraph. The selected nodes move into the subgraph
   * (with their internal edges + per-node `inputValues`); a fresh
   * wrapper node replaces them in the parent graph, with each
   * cross-boundary edge rewired through the wrapper's mirrored I/O
   * sockets. Single undoable step — atomic via dispatchProject.
   * Returns the new subgraph's id + the new wrapper's id (in the
   * parent graph), or null when the selection was empty or
   * contained only boundary nodes.
   */
  extractSelectionAsSubgraph: (
    selectedIds: ReadonlySet<string>,
    registry: import('../core/node-def.js').NodeRegistry,
  ) => { subgraphId: string; wrapperId: string } | null;

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
    /**
     * Optional hints captured from the caller's UI context:
     *   • `capturedDefault` — effective value of `edgeEnd`'s socket
     *     BEFORE the new edge is created, used as the new boundary
     *     input's `default`. Without this, any downstream consumer
     *     of the subgraph that doesn't wire the new input would
     *     silently fall back to the system default for the input's
     *     type. Used only when `side === 'input'`.
     *   • `preferredLabel` — what the user sees as the new socket's
     *     name. Conventionally the source socket's label (e.g. wiring
     *     `colorize.low` → boundary defaults to "low"). Falls back to
     *     "untitled" if no preference is supplied, and the store
     *     dedupes against existing labels in the same direction
     *     (`label-2`, `label-3`, …).
     */
    options?: { capturedDefault?: unknown; preferredLabel?: string },
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

  /**
   * Edit the `default` value of a subgraph input from inside the
   * subgraph itself. The input-boundary surfaces this default as a
   * row editor — drag-to-create captures the initial default from
   * whichever upstream value was at the drag-source, and the user
   * can tune it after the fact through this action.
   *
   * Updates `SubgraphDef.inputs[].default`, which feeds:
   *   • the input boundary's `evaluate(ctx) → ctx.subgraphInputs ?? standaloneDefaults`
   *     (so a standalone preview of the subgraph honours the new default)
   *   • the wrapper instance's input row default (when the parent
   *     hasn't wired that input)
   *   • the inputShape fingerprint extra (so the cache invalidates).
   * Undoable as one snapshot.
   */
  setSubgraphInputDefault: (
    subgraphId: string,
    inputName: string,
    value: unknown,
    /**
     * Same shape as `setInputValue`'s opts: when `coalesce` is unset
     * or true (the default), consecutive scrubs on the same
     * (subgraphId, inputName) merge into one undo step. Pass
     * `coalesce: false` to commit each call as a discrete entry.
     */
    opts?: { coalesce?: boolean },
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

// Shape every "load a project" input conforms to — demos, the initial
// graph, save-file load. Subgraphs / cameras / viewports / folders are
// optional so a minimal graph (just `{ graph, rootNodeId }`) still
// type-checks; they default to empty when absent.
interface ProjectInit {
  graph: Graph;
  rootNodeId: string;
  subgraphs?: SubgraphDef[];
  cameras?: Record<string, CameraState>;
  viewports?: Record<string, ViewportState>;
  folders?: Folder[];
}

// Single source of truth for "turn a ProjectInit into the slice of
// EditorState it determines." Used both at store creation (line below)
// AND inside `setGraph` for runtime demo/file loads, so the two paths
// Types whose values carry live GPU handles (GPUTexture / GPUBuffer)
// inside them and can't survive a JSON round-trip — `JSON.stringify`
// of a GPUTexture is `{}`. Storing one as `InputDef.default` would
// silently corrupt save / fragment-copy / undo. The two entry points
// that write into `InputDef.default` (`addSubgraphSocketWithEdge` and
// `setSubgraphInputDefault`) both throw if the type matches. Future
// callers don't need to remember this — the throw will catch them.
//
// Match list is the set of types `systemDefaultForType` deliberately
// excludes from synchronous defaults (the GPU-bearing types). The
// `Material` and `Texture2D` boundary-preview defaults live on
// `ctx.subgraphInputs` from the boundary's lazy fill — they were
// never meant to flow into `InputDef.default`.
const NON_SERIALIZABLE_DEFAULT_TYPES = new Set([
  'Material',
  'Texture2D',
  'Geometry',
  'Heightfield',
]);

function assertSerializableDefault(type: string, where: string): void {
  if (NON_SERIALIZABLE_DEFAULT_TYPES.has(type)) {
    throw new Error(
      `${where}: cannot store a "${type}" value as InputDef.default — ` +
        `it carries GPU handles that don't survive JSON round-trip ` +
        `(save / copy-paste / undo would corrupt the project). The ` +
        `subgraph-input boundary supplies a per-device preview fallback ` +
        `at eval time for Material / Texture2D, so no default is needed.`,
    );
  }
}

// can't drift. Returns ONLY the project-derived fields; the caller
// adds transient runtime bits (evalCache, device, syncCounter).
function projectStateSlice(init: ProjectInit): Pick<
  EditorState,
  | 'graph' | 'rootNodeId' | 'mainGraph' | 'mainRootNodeId'
  | 'subgraphs' | 'folders' | 'currentEditingId'
  | 'cameras' | 'viewports' | 'nodePositions'
  | 'undoStack' | 'redoStack' | 'undoBarrierPending' | 'dirty'
> {
  const nodePositions: EditorState['nodePositions'] = { main: extractPositions(init.graph) };
  for (const sg of init.subgraphs ?? []) {
    nodePositions[sg.id] = extractPositions(sg.graph);
  }
  return {
    graph: init.graph,
    rootNodeId: init.rootNodeId,
    mainGraph: init.graph,
    mainRootNodeId: init.rootNodeId,
    subgraphs: init.subgraphs ?? [],
    folders: init.folders ?? [],
    currentEditingId: 'main',
    cameras: init.cameras ?? {},
    viewports: init.viewports ?? {},
    nodePositions,
    undoStack: [],
    redoStack: [],
    undoBarrierPending: false,
    dirty: false,
  };
}

const initialProjectSlice = projectStateSlice(createInitialGraph());

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

  // Walk `snapshot.subgraphs` for iteration bridges whose IO changed
  // versus `beforeById`, then rebuild each owning for-each-point's
  // outer `extraInputs` / `extraOutputs` from the new bridge IO
  // (lifted through `liftForEachInputType` / `liftForEachOutputType`).
  // Also drops edges that point at extras which just vanished from
  // the for-each-point's surface.
  //
  // Lives in dispatchProject so EVERY mutation path (add socket,
  // rename socket, remove socket, replaceProject from undo / redo
  // / load) gets the sync for free — without it the user can edit a
  // bridge and the changes won't reach the parent graph.
  function syncForEachExtrasFromBridges(
    snapshot: ProjectSnapshot,
    beforeById: Map<string, SubgraphDef>,
  ): ProjectSnapshot {
    const changedBridges = snapshot.subgraphs.filter((sg) => {
      if (sg.owner?.kind !== 'iteration-bridge') return false;
      const prev = beforeById.get(sg.id);
      if (!prev) return true; // newly added → first sync
      return prev.inputs !== sg.inputs || prev.outputs !== sg.outputs;
    });
    if (changedBridges.length === 0) return snapshot;

    // Map of for-each-point node id → desired extras + surviving
    // socket names (used by the edge-prune step).
    const updates = new Map<string, {
      extraInputs: InputDef[];
      extraOutputs: OutputDef[];
      survivingInputs: Set<string>;
      survivingOutputs: Set<string>;
    }>();
    for (const bridge of changedBridges) {
      const ownerNodeId = bridge.owner!.nodeId;
      const extraInputs: InputDef[] = bridge.inputs.map((i) => ({
        name: i.name,
        type: liftForEachInputType(i.type),
        optional: true,
      }));
      const extraOutputs: OutputDef[] = [];
      for (const o of bridge.outputs) {
        const lifted = liftForEachOutputType(o.type);
        if (lifted !== null) extraOutputs.push({ name: o.name, type: lifted });
      }
      updates.set(ownerNodeId, {
        extraInputs,
        extraOutputs,
        survivingInputs: new Set(extraInputs.map((i) => i.name)),
        survivingOutputs: new Set(extraOutputs.map((o) => o.name)),
      });
    }

    // Static input names on for-each-point that must always survive
    // (not extras — part of the NodeDef.inputs declaration).
    const STATIC_FOR_EACH_INPUTS = new Set(['points', '__bridgeId']);
    const sameList = <T extends { name: string; type: string }>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i]!.name !== b[i]!.name || a[i]!.type !== b[i]!.type) return false;
      }
      return true;
    };
    const applyToGraph = (graph: Graph): Graph => {
      let nodesChanged = false;
      const nextNodes = graph.nodes.map((n) => {
        const u = updates.get(n.id);
        if (!u || n.kind !== 'core/for-each-point') return n;
        if (sameList(n.extraInputs ?? [], u.extraInputs)
          && sameList(n.extraOutputs ?? [], u.extraOutputs)) return n;
        nodesChanged = true;
        return { ...n, extraInputs: u.extraInputs, extraOutputs: u.extraOutputs };
      });
      if (!nodesChanged) return graph;
      const nextEdges = graph.edges.filter((e) => {
        const toU = updates.get(e.to.node);
        if (toU && !STATIC_FOR_EACH_INPUTS.has(e.to.socket) && !toU.survivingInputs.has(e.to.socket)) return false;
        const fromU = updates.get(e.from.node);
        if (fromU && !fromU.survivingOutputs.has(e.from.socket)) return false;
        return true;
      });
      return { ...graph, nodes: nextNodes, edges: nextEdges };
    };

    const nextMain = applyToGraph(snapshot.mainGraph);
    const nextSubgraphs = snapshot.subgraphs.map((sg) => {
      const nextGraph = applyToGraph(sg.graph);
      return nextGraph === sg.graph ? sg : { ...sg, graph: nextGraph };
    });
    const nextEditedGraph = snapshot.currentEditingId === 'main'
      ? nextMain
      : nextSubgraphs.find((s) => s.id === snapshot.currentEditingId)?.graph ?? snapshot.graph;
    return {
      ...snapshot,
      mainGraph: nextMain,
      subgraphs: nextSubgraphs,
      graph: nextEditedGraph,
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
  function dispatchProject(after: ProjectSnapshot, opts?: { coalesceKey?: string }) {
    const before = projectSnapshot();
    const beforeById = new Map(before.subgraphs.map((s) => [s.id, s]));
    const bumpedSubgraphs = after.subgraphs.map((s) => {
      const prev = beforeById.get(s.id);
      if (!prev || prev === s) return s;
      return { ...s, version: (prev.version ?? 0) + 1 };
    });
    let bumped: ProjectSnapshot = { ...after, subgraphs: bumpedSubgraphs };
    // Bridge → for-each-point extras sync. When a user edits a
    // bridge subgraph's IO (adds a `subgraph-input` socket on its
    // input boundary, or adds an output on its iteration-output
    // boundary), the owning for-each-point's outer extras need to
    // update to match — otherwise the new sockets only exist inside
    // the bridge and the user can't wire anything from the outside.
    // Detection: bridges whose inputs/outputs reference changed
    // versus the same id in `before`. Comparing object references is
    // sufficient because the existing dispatchProject callers
    // construct fresh subgraph objects only when they mutate.
    bumped = syncForEachExtrasFromBridges(bumped, beforeById);
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
    // Coalesce consecutive replaceProject commands sharing a
    // `coalesceKey`. NumberInput drag-edit on a subgraph-input
    // default fires one dispatchProject per pixel; without
    // coalescing the undo stack fills with full-project snapshots.
    // Merge: keep the OLD `before` (so undo lands on the start of
    // the scrub) and take the NEW `after`. Any command with a
    // different key, no key, or any non-replaceProject kind acts as
    // a barrier (the next scrub starts fresh) because the merge
    // only triggers when both the previous undo entry AND this new
    // command have matching `coalesceKey`.
    const stack = get().undoStack;
    const last = stack[stack.length - 1];
    // Consume the one-shot barrier flag: if armed, refuse to
    // coalesce regardless of key match (next scrub session starts
    // fresh). Always clear, even if no coalesce would have happened
    // anyway — the flag is single-use.
    const barrierArmed = get().undoBarrierPending;
    const coalesce =
      !barrierArmed
      && opts?.coalesceKey !== undefined
      && last !== undefined
      && last.kind === 'replaceProject'
      && last.coalesceKey === opts.coalesceKey;
    const cmd: Command = {
      kind: 'replaceProject',
      before: coalesce ? (last as Extract<Command, { kind: 'replaceProject' }>).before : before,
      after: bumped,
      ...(opts?.coalesceKey !== undefined ? { coalesceKey: opts.coalesceKey } : {}),
    };
    set({
      ...bumped,
      nodePositions,
      undoStack: coalesce ? [...stack.slice(0, -1), cmd] : [...stack, cmd],
      redoStack: [],
      undoBarrierPending: false,
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
    //
    // Opt-out: widgets that commit on discrete user actions (point-list
    // add/drag-end/paste/delete) pass `coalesce: false`; each command is
    // its own undo entry, and a non-coalescing command also prevents
    // the NEXT setInputValue from merging into it (acts as a barrier).
    //
    // The one-shot `undoBarrierPending` flag also blocks coalescing — it
    // covers the scrub → pointer-up → scrub case where neither end has a
    // `coalesce: false` command to break the chain on its own.
    const barrierArmed = get().undoBarrierPending;
    if (
      !barrierArmed
      && cmd.kind === 'setInputValue'
      && cmd.coalesce !== false
    ) {
      const stack = get().undoStack;
      const last = stack[stack.length - 1];
      if (
        last !== undefined &&
        last.kind === 'setInputValue' &&
        last.nodeId === cmd.nodeId &&
        last.name === cmd.name &&
        last.coalesce !== false
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
      // Consume the one-shot barrier flag if it was set — we either
      // used it above to block coalescing, or we're a non-coalescing
      // command (still resets so a stale flag doesn't leak forward).
      undoBarrierPending: false,
      dirty: true,
      ...(opts.bumpSync ? { syncCounter: get().syncCounter + 1 } : {}),
    });
  }

  const slice: EditorState = {
    // Project-derived fields (graph, root, subgraphs, cameras,
    // viewports, folders, nodePositions, currentEditingId, undo/redo,
    // dirty) all come from the same helper as `setGraph` uses for
    // runtime demo/file loads — so swapping which builder feeds the
    // initial graph (createInitialGraph → createForestDemo → any
    // other Demo.build()) automatically picks up subgraphs and
    // cameras without further wiring.
    ...initialProjectSlice,
    // Transient runtime state that's NOT part of "what project is
    // loaded": GPU device handle gets set after WebGPU init; the
    // eval cache is per-process; syncCounter starts at 0 (setGraph
    // bumps it at runtime so consumers re-derive).
    evalCache: createEvalCache(),
    device: null,
    syncCounter: 0,

    setDevice: (device) => set({ device }),

    // Replace the entire graph (load file, load demo). NOT undoable: clears
    // both undo and redo stacks. Always returns to editing the main graph
    // — switching demos shouldn't drop you inside an old subgraph.
    setGraph: (graph, rootNodeId, subgraphs, cameras, viewports, folders) => {
      // setGraph is the canonical "load a new project" entry point —
      // called from the demos menu, save-file load, and tests. It
      // ALWAYS resets the per-graph session state in the layout store,
      // because that state (pinnedGraphIds, canvas/preview viewports +
      // cameras, recent* LRUs) is keyed by graph id from the OUTGOING
      // project. Even when ids collide (every project has 'main') the
      // saved framings are meaningless across projects with wildly
      // different scales — forest's main lives at distance=95m, tree-
      // bush's at ~44m. Coupling the reset INTO setGraph makes the
      // wrong way impossible: any new caller of setGraph gets the
      // reset for free. file-ops's loadProject still works because
      // its `setState` call AFTER setGraph restores the saved layout
      // on top of this reset — same net effect as the prior code.
      useLayoutStore.getState().resetForNewProject();
      // Shared project-slice builder — same helper the store init
      // uses — so the initial-graph path and the runtime-load path
      // can't drift. The conditional spread for each optional field
      // is for exactOptionalPropertyTypes: passing
      // `subgraphs: undefined` explicitly isn't assignable to
      // `subgraphs?: SubgraphDef[]`; omitting the key is.
      const init: ProjectInit = {
        graph,
        rootNodeId,
        ...(subgraphs !== undefined ? { subgraphs } : {}),
        ...(cameras !== undefined ? { cameras } : {}),
        ...(viewports !== undefined ? { viewports } : {}),
        ...(folders !== undefined ? { folders } : {}),
      };
      set({
        ...projectStateSlice(init),
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
      const reparentedSubgraphs = state.subgraphs
        .filter((s) => !deletedSubgraphs.has(s.id))
        .map((s) => {
          const cur = s.parentFolderId ?? null;
          const next = resolveParent(cur);
          return next === cur ? s : { ...s, parentFolderId: next };
        });

      // No special cleanup for for-each-point body references: a
      // body wrapper now lives inside the for-each-point's owned
      // bridge subgraph (a regular `subgraph/<id>` node placed in
      // bridge.graph). When the body's source subgraph is deleted,
      // that wrapper's kind becomes a dead reference — same as any
      // other wrapper instance pointing at a deleted subgraph, which
      // Sedon's long-standing behaviour leaves in place for the user
      // to fix or remove.
      dispatchProject({
        ...projectSnapshot(),
        folders,
        subgraphs: reparentedSubgraphs,
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

    mergeImportedFragment: (imported) => {
      const state = get();
      // Nodes + edges land in WHATEVER GRAPH is currently being
      // edited. Subgraph defs are project-level — appended verbatim
      // (their ids were already de-collided by importFragment, so we
      // don't risk overwriting existing defs).
      const subgraphs = state.subgraphs.concat(imported.subgraphs);
      let mainGraph = state.mainGraph;
      let editedSubgraphs = subgraphs;
      if (state.currentEditingId === 'main') {
        mainGraph = {
          ...state.mainGraph,
          nodes: [...state.mainGraph.nodes, ...imported.nodes],
          edges: [...state.mainGraph.edges, ...imported.edges],
        };
      } else {
        editedSubgraphs = subgraphs.map((sg) =>
          sg.id === state.currentEditingId
            ? {
                ...sg,
                graph: {
                  ...sg.graph,
                  nodes: [...sg.graph.nodes, ...imported.nodes],
                  edges: [...sg.graph.edges, ...imported.edges],
                },
              }
            : sg,
        );
      }
      const graph = state.currentEditingId === 'main'
        ? mainGraph
        : editedSubgraphs.find((s) => s.id === state.currentEditingId)?.graph ?? state.graph;
      dispatchProject({
        ...projectSnapshot(),
        mainGraph,
        subgraphs: editedSubgraphs,
        graph,
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

    extractSelectionAsSubgraph: (selectedIds, registry) => {
      const state = get();
      // Mint a unique subgraph id. Same slugify rule createSubgraph
      // uses — collision-rename with "-2", "-3", … when "untitled-
      // subgraph" is already taken. Inline-renamed by the rename
      // bus immediately after dispatch, so the default label only
      // shows for a frame.
      const existing = new Set(state.subgraphs.map((s) => s.id));
      let base = 'untitled-subgraph';
      let sgId = base;
      for (let i = 2; existing.has(sgId) || sgId === 'main'; i++) {
        sgId = `${base}-${i}`;
      }

      const result = extractSelectionAsSubgraph(
        state.graph,
        selectedIds,
        registry,
        { newSubgraphId: sgId, newSubgraphLabel: 'untitled subgraph' },
      );
      if (!result) return null;
      const { newSubgraph, newParentGraph, wrapperId } = result;

      // The user might be editing main or any subgraph — the
      // "parent graph" returned above is whichever graph
      // currentEditingId points at. Splice it back into the right
      // slot (mainGraph or one of subgraphs[].graph).
      const editingId = state.currentEditingId;
      const isMain = editingId === 'main';

      // If the previous root pointed at a selected node, the
      // wrapper inherits the root role — it produces the same
      // observable output the selection used to.
      const prevRoot = state.rootNodeId;
      const rootWasRemoved =
        selectedIds.has(prevRoot) ||
        // boundary nodes filtered out by the extractor — those
        // can't be roots anyway, but be conservative.
        false;
      const newRootForEditing = rootWasRemoved ? wrapperId : prevRoot;

      const updatedSubgraphs: SubgraphDef[] = isMain
        ? [...state.subgraphs, newSubgraph]
        : state.subgraphs.map((sg) =>
            sg.id === editingId ? { ...sg, graph: newParentGraph } : sg,
          ).concat(newSubgraph);

      dispatchProject({
        subgraphs: updatedSubgraphs,
        folders: state.folders,
        mainGraph: isMain ? newParentGraph : state.mainGraph,
        mainRootNodeId: isMain ? newRootForEditing : state.mainRootNodeId,
        graph: newParentGraph,
        rootNodeId: newRootForEditing,
        currentEditingId: editingId,
      });
      // Caller (the menu handler) can use these to frame the canvas
      // on the new wrapper and start the rename gesture on it.
      return { subgraphId: sgId, wrapperId };
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

    addSubgraphSocketWithEdge: (subgraphId, side, type, edgeEnd, options) => {
      if (side === 'input' && options?.capturedDefault !== undefined) {
        assertSerializableDefault(type, 'addSubgraphSocketWithEdge');
      }
      const state = get();
      const target = state.subgraphs.find((s) => s.id === subgraphId);
      if (!target) return;
      const list = side === 'input' ? target.inputs : target.outputs;
      // Stable handle id (UUID) — never user-visible, never changes.
      // The user-visible label dedupes as "untitled" / "untitled-2" / ...
      // so drag-creating several sockets in a row produces a sensible
      // column of labels rather than a wall of "untitled"s.
      const name = crypto.randomUUID();
      // Label preference: whatever the caller suggested (typically the
      // source socket's label so wiring `colorize.low` → boundary lands
      // as "low"), falling back to "untitled" for callers that don't
      // supply one (e.g. the "+ Add" button path). Either way dedupe
      // against existing labels by appending `-2`, `-3`, …
      const baseLabel = options?.preferredLabel?.trim() || 'untitled';
      let label = baseLabel;
      if (list.some((x) => (x.label ?? x.name) === label)) {
        for (let i = 2; ; i++) {
          const candidate = `${baseLabel}-${i}`;
          if (!list.some((x) => (x.label ?? x.name) === candidate)) {
            label = candidate;
            break;
          }
        }
      }
      // Carry `default` only on the input side — output sockets don't
      // have one (the boundary-output's inputs are connection points
      // from the inner graph, not parametric).
      const captured = options?.capturedDefault;
      const newEntry: InputDef =
        side === 'input' && captured !== undefined
          ? { name, type, label, default: captured }
          : { name, type, label };
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

    setSubgraphInputDefault: (subgraphId, inputName, value, opts) => {
      const state = get();
      const target = state.subgraphs.find((s) => s.id === subgraphId);
      if (!target) return;
      const entry = target.inputs.find((i) => i.name === inputName);
      if (!entry) return;
      if (value !== undefined) {
        assertSerializableDefault(entry.type, 'setSubgraphInputDefault');
      }
      // Cheap identity short-circuit: scalars match by ===, identical
      // array references match too. Different array contents always
      // produce a new reference from a NumberInput / colour picker
      // commit, so this won't wrongly suppress real edits.
      if (entry.default === value) return;
      const updatedInputs = target.inputs.map((i) =>
        i.name === inputName ? { ...i, default: value } : i,
      );
      const subgraphs = state.subgraphs.map((s) =>
        s.id === subgraphId ? { ...s, inputs: updatedInputs } : s,
      );
      // Coalesce by (subgraphId, inputName) by default — drag-to-edit
      // emits one call per pixel, so a non-coalesced path would fill
      // the undo stack with a full project snapshot per pixel. Opt
      // out with `coalesce: false` for discrete-action callers.
      const dispatchOpts =
        opts?.coalesce === false
          ? undefined
          : { coalesceKey: `subgraph-input-default:${subgraphId}:${inputName}` };
      dispatchProject({
        subgraphs,
        folders: state.folders,
        mainGraph: state.mainGraph,
        mainRootNodeId: state.mainRootNodeId,
        graph: state.graph,
        rootNodeId: state.rootNodeId,
        currentEditingId: state.currentEditingId,
      }, dispatchOpts);
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

    markUndoBarrier: () => set({ undoBarrierPending: true }),

    addNode: (node) => {
      dispatch({ kind: 'addNode', node, prevRootNodeId: get().rootNodeId });
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
      const state = get();
      const graph = state.graph;
      // Boundary nodes (subgraph-input / subgraph-output /
      // iteration-input / iteration-output / bridge-eval) are
      // load-bearing: a subgraph's inner-graph evaluator looks them
      // up by id, and deleting one would leave the subgraph
      // un-evaluatable with no UI to add it back. Silently skip
      // them — the canvas treats Delete on a boundary node as a
      // no-op rather than as a footgun.
      const removable = new Set<string>();
      for (const id of ids) {
        const node = graph.nodes.find((n) => n.id === id);
        if (!node) continue;
        if (isSubgraphInternalKind(node.kind)) continue;
        removable.add(id);
      }
      if (removable.size === 0) return;
      const nodes = graph.nodes.filter((n) => removable.has(n.id));
      const edges = graph.edges.filter(
        (e) => removable.has(e.from.node) || removable.has(e.to.node),
      );
      if (nodes.length === 0) return;
      // Rest of the action treats the filtered set as the canonical
      // "ids to delete" — rename for clarity.
      ids = removable;

      // If any removed node owns a bridge subgraph (for-each-point and
      // future for-each-* nodes), clean up the orphans atomically. The
      // bridges live in `state.subgraphs`; once their owner is gone
      // they're unreachable and would otherwise leak into the saved
      // project. Done via dispatchProject so the cleanup is part of
      // the same undo entry as the node removal.
      const orphanedBridgeIds = new Set<string>();
      for (const sg of state.subgraphs) {
        if (sg.owner?.kind === 'iteration-bridge' && ids.has(sg.owner.nodeId)) {
          orphanedBridgeIds.add(sg.id);
        }
      }
      if (orphanedBridgeIds.size > 0) {
        const nextGraph: Graph = {
          ...graph,
          nodes: graph.nodes.filter((n) => !ids.has(n.id)),
          edges: graph.edges.filter((e) => !ids.has(e.from.node) && !ids.has(e.to.node)),
        };
        const nextMainGraph = state.currentEditingId === 'main'
          ? nextGraph
          : state.mainGraph;
        const nextSubgraphs = state.subgraphs.filter((s) => !orphanedBridgeIds.has(s.id));
        dispatchProject({
          ...projectSnapshot(),
          mainGraph: nextMainGraph,
          graph: nextGraph,
          subgraphs: nextSubgraphs,
        });
        return;
      }

      dispatch({ kind: 'removeNodes', nodes, edges, prevRootNodeId: state.rootNodeId });
    },

    removeNodesAndEdges: (nodeIds, edgeIds) => {
      if (nodeIds.size === 0 && edgeIds.size === 0) return;
      const state = get();
      const graph = state.graph;

      // Filter out boundary nodes (same rule as `removeNodes`) — they
      // can't be deleted and the action there silently skips them.
      const removableNodeIds = new Set<string>();
      for (const id of nodeIds) {
        const node = graph.nodes.find((n) => n.id === id);
        if (!node) continue;
        if (isSubgraphInternalKind(node.kind)) continue;
        removableNodeIds.add(id);
      }

      // Edges to be removed: explicit ones from the caller PLUS any
      // edge attached to a node we're removing (so the node-remove
      // command's `edges` field stays correct for undo restore).
      // De-dup by id — an edge could appear in both sources.
      const edgeIdSet = new Set<string>(edgeIds);
      for (const e of graph.edges) {
        if (removableNodeIds.has(e.from.node) || removableNodeIds.has(e.to.node)) {
          edgeIdSet.add(e.id);
        }
      }
      const removedEdges = graph.edges.filter((e) => edgeIdSet.has(e.id));
      const removedNodes = graph.nodes.filter((n) => removableNodeIds.has(n.id));

      if (removedNodes.length === 0 && removedEdges.length === 0) return;

      // Bridge cleanup mirrors the `removeNodes` action. When a
      // for-each-* (or future iteration-bridge) node is being removed,
      // its bridge subgraph becomes unreachable — clear it as part of
      // the same undo entry via dispatchProject. Project-scoped ops
      // can't sit inside a `batch` so this path doesn't combine with
      // the graph-scoped edge-remove; the edges attached to the node
      // get folded into the nextGraph below so undo still restores
      // them in one step.
      const orphanedBridgeIds = new Set<string>();
      for (const sg of state.subgraphs) {
        if (sg.owner?.kind === 'iteration-bridge' && removableNodeIds.has(sg.owner.nodeId)) {
          orphanedBridgeIds.add(sg.id);
        }
      }
      if (orphanedBridgeIds.size > 0) {
        const nextGraph: Graph = {
          ...graph,
          nodes: graph.nodes.filter((n) => !removableNodeIds.has(n.id)),
          edges: graph.edges.filter((e) => !edgeIdSet.has(e.id)),
        };
        const nextMainGraph = state.currentEditingId === 'main' ? nextGraph : state.mainGraph;
        const nextSubgraphs = state.subgraphs.filter((s) => !orphanedBridgeIds.has(s.id));
        dispatchProject({
          ...projectSnapshot(),
          mainGraph: nextMainGraph,
          graph: nextGraph,
          subgraphs: nextSubgraphs,
        });
        return;
      }

      // No node-only or edge-only sub-command needed when the other
      // list is empty — unwrap to a single command so the undo entry
      // shape stays minimal in the common cases. Otherwise dispatch a
      // batch so both halves undo together.
      if (removedNodes.length === 0) {
        dispatch({ kind: 'removeEdges', edges: removedEdges });
        return;
      }
      if (removedEdges.length === 0 || edgeIds.size === 0) {
        // Only node-attached edges → fold them into removeNodes itself
        // (its `edges` field already exists for this purpose).
        dispatch({
          kind: 'removeNodes',
          nodes: removedNodes,
          edges: removedEdges,
          prevRootNodeId: state.rootNodeId,
        });
        return;
      }
      // Mixed: explicit edge ids that aren't attached to a removed
      // node need their own sub-command. Build a batch.
      const nodeAttachedEdgeIds = new Set(
        graph.edges
          .filter((e) => removableNodeIds.has(e.from.node) || removableNodeIds.has(e.to.node))
          .map((e) => e.id),
      );
      const nodeAttachedEdges = removedEdges.filter((e) => nodeAttachedEdgeIds.has(e.id));
      const looseEdges = removedEdges.filter((e) => !nodeAttachedEdgeIds.has(e.id));
      const commands: import('./command.js').Command[] = [];
      if (looseEdges.length > 0) commands.push({ kind: 'removeEdges', edges: looseEdges });
      commands.push({
        kind: 'removeNodes',
        nodes: removedNodes,
        edges: nodeAttachedEdges,
        prevRootNodeId: state.rootNodeId,
      });
      dispatch({ kind: 'batch', commands });
    },

    setInputValue: (nodeId, name, value, opts) => {
      const node = get().graph.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const before = node.inputValues?.[name];
      if (before === value) return;
      const cmd: import('./command.js').Command = { kind: 'setInputValue', nodeId, name, before, after: value };
      if (opts?.coalesce === false) cmd.coalesce = false;
      dispatch(cmd);
    },

    renameNode: (nodeId, name) => {
      const state = get();
      const node = state.graph.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const trimmed = name.trim();
      const next = trimmed.length > 0 ? trimmed : undefined;
      if ((node.name ?? undefined) === next) return;
      // Build a new node with name set/cleared. exactOptionalPropertyTypes
      // is strict about `name: undefined` vs name-absent, so delete the
      // key when clearing instead of assigning undefined.
      const updatedNode: GraphNode = { ...node };
      if (next !== undefined) updatedNode.name = next;
      else delete updatedNode.name;
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

    attachIterationBody: (nodeId, bodyKind) => {
      const state = get();
      const node = state.graph.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      if (node.kind !== 'core/for-each-point') return;
      if (!bodyKind.startsWith('subgraph/')) return;
      const bodySubgraphId = bodyKind.slice('subgraph/'.length);
      const bodySg = state.subgraphs.find((s) => s.id === bodySubgraphId);
      if (!bodySg) return;

      // Resolve iteration context names this kind provides (for the
      // bridge's iteration-input boundary's outputs + the auto-wire
      // step below).
      const ITERATION_KIND = 'core/for-each-point';
      const providedContext = [
        { name: 'position', type: 'Vec3' },
        { name: 'index', type: 'Int' },
      ];

      // Build the bridge SubgraphDef from scratch — its three
      // boundary nodes plus one wrapper instance of the body. Default
      // outputs: the body's lifted outputs (or just a placeholder
      // `scene: Scene` when the body emits Scene).
      const bridgeId = `bridge-${nodeId}`;
      const bridgeGraph = createGraph();
      const inputBoundary = addNode(bridgeGraph, `subgraph-input/${bridgeId}`, {
        position: { x: 0, y: 0 },
      });
      const iterInputBoundary = addNode(bridgeGraph, `iteration-input/${bridgeId}`, {
        position: { x: 0, y: 200 },
      });
      const iterOutputBoundary = addNode(bridgeGraph, `iteration-output/${bridgeId}`, {
        position: { x: 800, y: 100 },
      });
      const bodyWrapper = addNode(bridgeGraph, bodyKind, {
        position: { x: 400, y: 100 },
      });

      // Auto-wire iteration-input.<name> → body.<name> for every
      // body input whose name matches a provided-context name.
      // Bodies declare regular inputs; the matching happens by name.
      // Anything the body needs that the iteration kind doesn't
      // provide stays unwired (user can hand-wire later inside the
      // bridge editor).
      const contextNames = new Set(providedContext.map((c) => c.name));
      for (const bIn of bodySg.inputs) {
        if (contextNames.has(bIn.name)) {
          addEdge(bridgeGraph,
            { node: iterInputBoundary.id, socket: bIn.name },
            { node: bodyWrapper.id, socket: bIn.name });
        }
      }

      // Auto-wire body.<name> → iteration-output.<name> for every
      // body output that's a cloudable type (Scene / Float / Vec3).
      const bridgeOutputs: OutputDef[] = [];
      for (const bOut of bodySg.outputs) {
        if (liftForEachOutputType(bOut.type) === null) continue;
        bridgeOutputs.push({ name: bOut.name, type: bOut.type });
        addEdge(bridgeGraph,
          { node: bodyWrapper.id, socket: bOut.name },
          { node: iterOutputBoundary.id, socket: bOut.name });
      }

      // Bridge's broadcast inputs: mirror the body's REGULAR inputs
      // (ones the iteration kind doesn't provide). These get
      // surfaced on the for-each-point as cloud-lifted extras.
      //
      // Defaults carry forward from the body's InputDef: if the body
      // declares `size: Vec3, default: [1,1,1]`, the bridge's
      // subgraph-input gets the same default so a freshly-attached
      // for-each-point evaluates with sensible values even before
      // the user wires anything into its extras. Skip GPU-bearing
      // types (Material / Texture2D / etc.) — the boundary supplies
      // a lazy preview default at eval time for those instead, and
      // copying a runtime GPU handle into an InputDef would corrupt
      // save / copy-paste.
      const bridgeInputs: InputDef[] = [];
      const mirroredOuterInputs: InputDef[] = [];
      const nonSerializableTypes = new Set([
        'Material', 'Texture2D', 'Geometry', 'Heightfield',
      ]);
      for (const bIn of bodySg.inputs) {
        if (contextNames.has(bIn.name)) continue; // wired via iteration-input
        const carryDefault =
          bIn.default !== undefined && !nonSerializableTypes.has(bIn.type);
        const bridgeInput: InputDef = {
          name: bIn.name,
          type: bIn.type,
          optional: true,
          ...(carryDefault ? { default: bIn.default } : {}),
        };
        bridgeInputs.push(bridgeInput);
        mirroredOuterInputs.push({
          name: bIn.name,
          type: liftForEachInputType(bIn.type),
          optional: true,
        });
        // Wire bridge's subgraph-input → body for broadcast inputs.
        addEdge(bridgeGraph,
          { node: inputBoundary.id, socket: bIn.name },
          { node: bodyWrapper.id, socket: bIn.name });
      }

      // for-each-point's outer outputs: lift each bridge output.
      const mirroredOuterOutputs: OutputDef[] = bridgeOutputs.map((o) => ({
        name: o.name,
        type: liftForEachOutputType(o.type)!,
      }));

      const newBridge: SubgraphDef = {
        id: bridgeId,
        label: `for-each-point body (${bodySg.label})`,
        category: 'Subgraphs',
        inputs: bridgeInputs,
        outputs: bridgeOutputs,
        graph: bridgeGraph,
        inputNodeId: inputBoundary.id,
        outputNodeId: iterOutputBoundary.id,
        owner: { kind: 'iteration-bridge', nodeId },
        iterationKind: ITERATION_KIND,
      };

      // Replace any existing bridge for this node (re-attaching a
      // different body discards the previous bridge wholesale). The
      // existing bridge can be identified by owner.nodeId.
      const subgraphs = state.subgraphs
        .filter((s) => !(s.owner?.kind === 'iteration-bridge' && s.owner.nodeId === nodeId))
        .concat(newBridge);

      // Drop edges to/from now-stale extra sockets on the for-each-point.
      const survivingInputNames = new Set(mirroredOuterInputs.map((m) => m.name));
      const survivingOutputNames = new Set(mirroredOuterOutputs.map((m) => m.name));
      const staticInputNames = new Set(['points', '__bridgeId']);
      const edges: GraphEdge[] = state.graph.edges.filter((e) => {
        if (e.to.node === nodeId) {
          if (staticInputNames.has(e.to.socket)) return true;
          return survivingInputNames.has(e.to.socket);
        }
        if (e.from.node === nodeId) {
          return survivingOutputNames.has(e.from.socket);
        }
        return true;
      });

      const nextInputValues: Record<string, unknown> = { ...node.inputValues };
      nextInputValues.__bridgeId = bridgeId;

      const updatedNode: GraphNode = {
        ...node,
        inputValues: nextInputValues,
        extraInputs: mirroredOuterInputs,
        extraOutputs: mirroredOuterOutputs,
      };

      const nextMainGraph = state.currentEditingId === 'main'
        ? { ...state.mainGraph, nodes: state.mainGraph.nodes.map((n) => n.id === nodeId ? updatedNode : n), edges: state.mainGraph === state.graph ? edges : state.mainGraph.edges }
        : state.mainGraph;
      const nextGraph = state.currentEditingId === 'main'
        ? nextMainGraph
        : { ...state.graph, nodes: state.graph.nodes.map((n) => n.id === nodeId ? updatedNode : n), edges };

      dispatchProject({
        ...projectSnapshot(),
        subgraphs,
        mainGraph: nextMainGraph,
        graph: nextGraph,
      });
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
  // Wrap every action with the macro-recording shim so the Macro menu
  // (Record / Stop / Load) and the `?log-commands=1` console hook see
  // every user-initiated mutation pass through one place. Non-function
  // fields (graph, syncCounter, evalCache, device, …) pass through
  // unchanged. Wrapping happens here, BEFORE the create()'s return,
  // so React selectors capture the wrapped functions on first render
  // — no aliasing of stale function references.
  return wrapActionsSlice(slice);
});
