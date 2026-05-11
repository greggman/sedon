import { create } from 'zustand';
import type { Graph, GraphNode, SocketRef } from '../core/graph.js';
import type { NodeOutputs } from '../core/node-def.js';
import type { SceneValue } from '../core/resources.js';
import type { SubgraphDef } from '../core/subgraph.js';
import { applyBackward, applyForward, type Command } from './command.js';
import { createInitialGraph } from './initial-graph.js';

export interface EvalResult {
  scene: SceneValue;
  allOutputs: Map<string, NodeOutputs>;
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
  /** 'main' or the id of a subgraph in `subgraphs`. Drives which graph the editor displays. */
  currentEditingId: string;
  evalResult: EvalResult | null;
  device: GPUDevice | null;

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

  setEvalResult: (evalResult: EvalResult | null) => void;
  setDevice: (device: GPUDevice | null) => void;

  // Same public API as before — every mutation funnels through dispatch
  // internally, so it's all undoable for free.
  setGraph: (graph: Graph, rootNodeId: string, subgraphs?: SubgraphDef[]) => void;
  addNode: (node: GraphNode) => void;
  connect: (id: string, from: SocketRef, to: SocketRef) => void;
  removeEdges: (ids: ReadonlySet<string>) => void;
  removeNodes: (ids: ReadonlySet<string>) => void;
  setInputValue: (nodeId: string, name: string, value: unknown) => void;

  /**
   * Switch which graph is being edited. 'main' loads the project's main
   * graph; any other id loads the matching subgraph's inner graph.
   * Clears undo/redo (commands don't carry context across boundaries).
   */
  setActiveEditing: (id: string) => void;

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

const initial = createInitialGraph();

export const useEditorStore = create<EditorState>((set, get) => {
  // Compute the routing-back state — when a mutation produces a new graph,
  // we also need to update either mainGraph (if editing main) or replace
  // the active subgraph's def in the subgraphs array (so the registry
  // memo invalidates and wrappers see the latest inner graph).
  function routeBack(nextGraph: Graph, nextRootId: string): Partial<EditorState> {
    const { currentEditingId, subgraphs } = get();
    if (currentEditingId === 'main') {
      return { mainGraph: nextGraph, mainRootNodeId: nextRootId };
    }
    const newSubgraphs = subgraphs.map((s) =>
      s.id === currentEditingId ? { ...s, graph: nextGraph } : s,
    );
    return { subgraphs: newSubgraphs };
  }

  // Push `cmd` onto the undo stack and apply it forward. Returns nothing —
  // updates state directly.
  function dispatch(cmd: Command, opts: { bumpSync?: boolean } = {}) {
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
        // Don't clear evalResult: with async eval there's a real window
        // before the new result lands, and clearing it makes every preview
        // disappear (and the nodes resize). Stale-result protection lives
        // in preview.tsx's cancellation logic.
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
    set({
      graph: next.graph,
      rootNodeId: next.rootNodeId,
      ...routeBack(next.graph, next.rootNodeId),
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
    currentEditingId: 'main',
    evalResult: null,
    device: null,
    undoStack: [],
    redoStack: [],
    syncCounter: 0,
    dirty: false,

    setEvalResult: (evalResult) => set({ evalResult }),
    setDevice: (device) => set({ device }),

    // Replace the entire graph (load file, load demo). NOT undoable: clears
    // both undo and redo stacks. Always returns to editing the main graph
    // — switching demos shouldn't drop you inside an old subgraph.
    setGraph: (graph, rootNodeId, subgraphs) => {
      set({
        graph,
        rootNodeId,
        mainGraph: graph,
        mainRootNodeId: rootNodeId,
        subgraphs: subgraphs ?? [],
        currentEditingId: 'main',
        undoStack: [],
        redoStack: [],
        dirty: false,
        syncCounter: get().syncCounter + 1,
      });
    },

    commitActivePositions: (positionsById) => {
      const state = get();
      const graph = state.graph;
      const updated: Graph = {
        ...graph,
        nodes: graph.nodes.map((n) => {
          const p = positionsById.get(n.id);
          return p ? { ...n, position: p } : n;
        }),
      };
      set({
        graph: updated,
        ...routeBack(updated, state.rootNodeId),
        // Position-only changes don't dirty: dragging is the same as before
        // this method existed, just newly persisted into the store.
      });
    },

    setActiveEditing: (id) => {
      const state = get();
      if (state.currentEditingId === id) return;
      if (id === 'main') {
        set({
          currentEditingId: 'main',
          graph: state.mainGraph,
          rootNodeId: state.mainRootNodeId,
          undoStack: [],
          redoStack: [],
          syncCounter: state.syncCounter + 1,
        });
      } else {
        const sg = state.subgraphs.find((s) => s.id === id);
        if (!sg) return;
        // Prefer a core/output node inside the subgraph as the eval root
        // when viewing standalone — that's the user's authored preview
        // (a single tree at origin, etc.). Fall back to the boundary
        // output, which without parent inputs typically produces nothing
        // (the evaluator handles that gracefully now).
        const previewOutput = sg.graph.nodes.find((n) => n.kind === 'core/output');
        const rootNodeId = previewOutput?.id ?? sg.outputNodeId;
        set({
          currentEditingId: id,
          graph: sg.graph,
          rootNodeId,
          undoStack: [],
          redoStack: [],
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

    undo: () => {
      const stack = get().undoStack;
      if (stack.length === 0) return;
      const cmd = stack[stack.length - 1]!;
      const state = { graph: get().graph, rootNodeId: get().rootNodeId };
      const next = applyBackward(state, cmd);
      set({
        graph: next.graph,
        rootNodeId: next.rootNodeId,
        ...routeBack(next.graph, next.rootNodeId),
        undoStack: stack.slice(0, -1),
        redoStack: [...get().redoStack, cmd],
        syncCounter: get().syncCounter + 1,
      });
    },

    redo: () => {
      const stack = get().redoStack;
      if (stack.length === 0) return;
      const cmd = stack[stack.length - 1]!;
      const state = { graph: get().graph, rootNodeId: get().rootNodeId };
      const next = applyForward(state, cmd);
      set({
        graph: next.graph,
        rootNodeId: next.rootNodeId,
        ...routeBack(next.graph, next.rootNodeId),
        undoStack: [...get().undoStack, cmd],
        redoStack: stack.slice(0, -1),
        syncCounter: get().syncCounter + 1,
      });
    },
  };
});
