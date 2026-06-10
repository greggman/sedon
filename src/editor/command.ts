import type { Folder } from '../core/folder.js';
import type { Graph, GraphEdge, GraphNode, SocketRef } from '../core/graph.js';
import type { SubgraphDef } from '../core/subgraph.js';

// Every UI mutation builds one of these and dispatches it to the store. The
// command captures *enough* state to both apply and reverse the change without
// re-querying the graph at undo time. Same shape doubles as the building block
// for a future scripting/API capture log: each command is a portable
// description of "what just happened."
//
// Most commands operate on the currently-active graph (GraphState below).
// `replaceProject` is the escape hatch for operations whose blast radius
// spans subgraphs, the active graph, AND the editing context — like
// adding/removing a subgraph socket (which can drop edges in N parent
// graphs) or creating a new subgraph (which switches contexts). Cheap
// because subgraph defs and graphs are already kept immutable.
export type Command =
  // addNode / removeNodes carry the BEFORE rootNodeId so undo can
  // restore it cleanly. applyForward may promote a freshly-added
  // core/output to root (when the previous root is gone) or pick a
  // remaining core/output when the current root is being removed —
  // both transitions need the pre-command rootNodeId on hand for
  // applyBackward to invert.
  | { kind: 'addNode'; node: GraphNode; prevRootNodeId: string }
  | { kind: 'removeNodes'; nodes: GraphNode[]; edges: GraphEdge[]; prevRootNodeId: string }
  | { kind: 'connect'; edge: GraphEdge; replaced: GraphEdge | null }
  | { kind: 'removeEdges'; edges: GraphEdge[] }
  | {
      kind: 'setInputValue';
      nodeId: string;
      name: string;
      before: unknown; // captured at dispatch time so undo can restore it
      after: unknown;
      /**
       * Opt out of the dispatcher's per-(nodeId, name) coalescing rule
       * when this command is its own discrete user action rather than
       * one step of a continuous scrub. NumberInput drag-edit relies on
       * coalescing to collapse hundreds of micro-edits into a single
       * undo entry; widgets that commit only on a deliberate user
       * action (point-list add / drag-end / paste / delete) set this
       * to `false` so each one is its own undo step. Defaults to
       * coalescing-enabled when omitted.
       */
      coalesce?: boolean;
    }
  | { kind: 'replaceGraph'; before: GraphState; after: GraphState }
  // Groups multiple graph-scoped commands into one undo entry — what a
  // user sees as a single operation but internally takes several
  // commands (e.g. delete-node-with-edges, paste-with-rewire). Applied
  // forward in order, backward in reverse. Nests freely: a `batch`
  // command can contain other `batch` commands. `replaceProject` is
  // intentionally NOT allowed inside a batch — it's project-scoped and
  // its own undo-stack entry already.
  | { kind: 'batch'; commands: Command[] }
  // Position commit from a node drag (single or multi-selection). Lives
  // outside GraphState because positions are kept in their own slice
  // (`nodePositions`) — moving a node mustn't invalidate the graph
  // reference. Handled at the store level like `replaceProject`;
  // applyForward / applyBackward throw if called on it.
  | {
      kind: 'movePositions';
      /** Which graph the positions belong to ('main' or a subgraph id). */
      editingId: string;
      /** Position-by-id BEFORE the drag for the moved nodes. Missing
       *  entries mean "no position was recorded yet" — undo will delete
       *  the entry rather than reinstating a stale one. */
      before: Record<string, { x: number; y: number } | undefined>;
      /** Position-by-id AFTER the drag. */
      after: Record<string, { x: number; y: number }>;
    }
  | {
      kind: 'replaceProject';
      before: ProjectSnapshot;
      after: ProjectSnapshot;
      /**
       * Coalescing key for continuous scrubs that hit `dispatchProject`.
       * Two consecutive `replaceProject` commands with the SAME
       * non-null `coalesceKey` merge into one undo entry (the new
       * `after` overwrites the old `after`, the old `before` is
       * preserved). A non-coalescing command (any other kind, or a
       * `replaceProject` with no key or a different key) acts as a
       * barrier — the next scrub starts a fresh entry.
       *
       * Used by `setSubgraphInputDefault` so a drag-to-scrub on a
       * subgraph-input default field produces ONE undo step on
       * pointer-up, not hundreds.
       */
      coalesceKey?: string;
    };

export interface GraphState {
  graph: Graph;
  rootNodeId: string;
}

// Full snapshot for project-scoped commands. Covers every field a single
// project-scoped action can change. Camera/viewport state isn't included
// — those have their own lifecycle (drag-end persistence) and aren't part
// of the "what was authored" history.
export interface ProjectSnapshot {
  subgraphs: SubgraphDef[];
  /**
   * Asset-view folders. Captured in project snapshots so undo restores
   * folder layout alongside any subgraph re-parenting that touched it.
   */
  folders: Folder[];
  mainGraph: Graph;
  mainRootNodeId: string;
  graph: Graph;
  rootNodeId: string;
  currentEditingId: string;
}

export function applyForward(state: GraphState, cmd: Command): GraphState {
  const { graph, rootNodeId } = state;
  switch (cmd.kind) {
    case 'addNode': {
      const nextNodes = [...graph.nodes, cmd.node];
      // If the current root no longer resolves in the graph AND the
      // added node is a core/output, auto-promote it. Recovers from
      // "deleted the output, added a fresh one" — without this the
      // preview stays stuck on the orphaned rootNodeId.
      const rootResolves = nextNodes.some((n) => n.id === rootNodeId);
      const nextRoot =
        !rootResolves && cmd.node.kind === 'core/output' ? cmd.node.id : rootNodeId;
      return { graph: { ...graph, nodes: nextNodes }, rootNodeId: nextRoot };
    }
    case 'removeNodes': {
      const ids = new Set(cmd.nodes.map((n) => n.id));
      const edgeIds = new Set(cmd.edges.map((e) => e.id));
      const nextNodes = graph.nodes.filter((n) => !ids.has(n.id));
      // If the current root is being removed, promote any remaining
      // core/output. Falls through to the original rootNodeId (now
      // orphaned) only if no replacement exists — that case shows
      // an empty preview, matching "no output in graph."
      const nextRoot = ids.has(rootNodeId)
        ? nextNodes.find((n) => n.kind === 'core/output')?.id ?? rootNodeId
        : rootNodeId;
      return {
        graph: {
          ...graph,
          nodes: nextNodes,
          edges: graph.edges.filter((e) => !edgeIds.has(e.id)),
        },
        rootNodeId: nextRoot,
      };
    }
    case 'connect': {
      const replacedId = cmd.replaced?.id;
      const filtered = replacedId !== undefined
        ? graph.edges.filter((e) => e.id !== replacedId)
        : graph.edges;
      return {
        graph: { ...graph, edges: [...filtered, cmd.edge] },
        rootNodeId,
      };
    }
    case 'removeEdges': {
      const ids = new Set(cmd.edges.map((e) => e.id));
      return {
        graph: { ...graph, edges: graph.edges.filter((e) => !ids.has(e.id)) },
        rootNodeId,
      };
    }
    case 'setInputValue': {
      const nodes = graph.nodes.map((n) => {
        if (n.id !== cmd.nodeId) return n;
        const inputValues = { ...(n.inputValues ?? {}) };
        // `after === undefined` means "reset to default" — remove the
        // key entirely rather than storing undefined. That makes
        // `inputValues[name] !== undefined` the unambiguous
        // "user-overridden" check the UI uses to show the override
        // indicator. Symmetric with the backward case below.
        if (cmd.after === undefined) {
          delete inputValues[cmd.name];
        } else {
          inputValues[cmd.name] = cmd.after;
        }
        return { ...n, inputValues };
      });
      return { graph: { ...graph, nodes }, rootNodeId };
    }
    case 'replaceGraph':
      return cmd.after;
    case 'batch': {
      // Thread state through each sub-command in declaration order.
      // The sub-commands are graph-scoped (batches can't contain
      // replaceProject) so applyForward returns a fresh GraphState
      // each time and we don't need any per-step bookkeeping.
      let s = state;
      for (const sub of cmd.commands) s = applyForward(s, sub);
      return s;
    }
    case 'replaceProject':
      // Project-scoped — its blast radius is wider than GraphState. The
      // store handles it directly in undo/redo by swapping the snapshot.
      throw new Error('replaceProject must be applied at the store level, not via applyForward');
    case 'movePositions':
      throw new Error('movePositions must be applied at the store level, not via applyForward');
  }
}

export function applyBackward(state: GraphState, cmd: Command): GraphState {
  const { graph, rootNodeId } = state;
  switch (cmd.kind) {
    case 'addNode':
      return {
        graph: { ...graph, nodes: graph.nodes.filter((n) => n.id !== cmd.node.id) },
        rootNodeId: cmd.prevRootNodeId,
      };
    case 'removeNodes':
      return {
        graph: {
          ...graph,
          nodes: [...graph.nodes, ...cmd.nodes],
          edges: [...graph.edges, ...cmd.edges],
        },
        rootNodeId: cmd.prevRootNodeId,
      };
    case 'connect': {
      const filtered = graph.edges.filter((e) => e.id !== cmd.edge.id);
      const restored = cmd.replaced ? [...filtered, cmd.replaced] : filtered;
      return { graph: { ...graph, edges: restored }, rootNodeId };
    }
    case 'removeEdges':
      return {
        graph: { ...graph, edges: [...graph.edges, ...cmd.edges] },
        rootNodeId,
      };
    case 'setInputValue': {
      const nodes = graph.nodes.map((n) => {
        if (n.id !== cmd.nodeId) return n;
        const inputValues = { ...(n.inputValues ?? {}) };
        if (cmd.before === undefined) {
          delete inputValues[cmd.name];
        } else {
          inputValues[cmd.name] = cmd.before;
        }
        return { ...n, inputValues };
      });
      return { graph: { ...graph, nodes }, rootNodeId };
    }
    case 'replaceGraph':
      return cmd.before;
    case 'batch': {
      // Mirror of the forward path: unwind in REVERSE order so we
      // undo the latest sub-command first. Threads state through.
      let s = state;
      for (let i = cmd.commands.length - 1; i >= 0; i--) {
        s = applyBackward(s, cmd.commands[i]!);
      }
      return s;
    }
    case 'replaceProject':
      throw new Error('replaceProject must be applied at the store level, not via applyBackward');
    case 'movePositions':
      throw new Error('movePositions must be applied at the store level, not via applyBackward');
  }
}

// Re-export some types so the store can import everything from one place.
export type { GraphEdge, GraphNode, SocketRef };
