import { create } from 'zustand';
import type { Graph, GraphNode, SocketRef } from '../core/graph.js';
import type { NodeOutputs } from '../core/node-def.js';
import type { SceneValue } from '../core/resources.js';
import { applyBackward, applyForward, type Command } from './command.js';
import { createInitialGraph } from './initial-graph.js';

export interface EvalResult {
  scene: SceneValue;
  allOutputs: Map<string, NodeOutputs>;
}

export interface EditorState {
  graph: Graph;
  rootNodeId: string;
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
  setGraph: (graph: Graph, rootNodeId: string) => void;
  addNode: (node: GraphNode) => void;
  connect: (id: string, from: SocketRef, to: SocketRef) => void;
  removeEdges: (ids: ReadonlySet<string>) => void;
  removeNodes: (ids: ReadonlySet<string>) => void;
  setInputValue: (nodeId: string, name: string, value: unknown) => void;

  /** Mark the current state as the saved baseline (called after Save). */
  markClean: () => void;

  undo: () => void;
  redo: () => void;
}

const initial = createInitialGraph();

export const useEditorStore = create<EditorState>((set, get) => {
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
      undoStack: [...get().undoStack, cmd],
      redoStack: [],
      dirty: true,
      ...(opts.bumpSync ? { syncCounter: get().syncCounter + 1 } : {}),
    });
  }

  return {
    graph: initial.graph,
    rootNodeId: initial.rootNodeId,
    evalResult: null,
    device: null,
    undoStack: [],
    redoStack: [],
    syncCounter: 0,
    dirty: false,

    setEvalResult: (evalResult) => set({ evalResult }),
    setDevice: (device) => set({ device }),

    // Replace the entire graph (load file, load demo). NOT undoable: clears
    // both undo and redo stacks, since the prior history doesn't apply to
    // the new graph. Marks state clean — the freshly loaded graph IS the
    // baseline.
    setGraph: (graph, rootNodeId) => {
      set({
        graph,
        rootNodeId,
        undoStack: [],
        redoStack: [],
        dirty: false,
        syncCounter: get().syncCounter + 1,
      });
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
        undoStack: [...get().undoStack, cmd],
        redoStack: stack.slice(0, -1),
        syncCounter: get().syncCounter + 1,
      });
    },
  };
});
