import { create } from 'zustand';
import type { Graph, GraphNode, SocketRef } from '../core/graph.js';
import type { GeometryValue, MaterialValue } from '../core/resources.js';
import { createInitialGraph } from './initial-graph.js';

export interface EvalResult {
  geometry: GeometryValue;
  material: MaterialValue;
}

export interface EditorState {
  // Compute graph. Mutates only when something computationally relevant changes
  // (nodes added/removed, edges added/removed, inputValues edited). Visual
  // state — node positions, dimensions, selection — lives in React Flow's
  // local state, not here.
  graph: Graph;
  rootNodeId: string;
  evalResult: EvalResult | null;

  setEvalResult: (evalResult: EvalResult | null) => void;

  addNode: (node: GraphNode) => void;
  connect: (id: string, from: SocketRef, to: SocketRef) => void;
  removeEdges: (ids: ReadonlySet<string>) => void;
  removeNodes: (ids: ReadonlySet<string>) => void;
  setInputValue: (nodeId: string, name: string, value: unknown) => void;
}

const initial = createInitialGraph();

export const useEditorStore = create<EditorState>((set, get) => ({
  graph: initial.graph,
  rootNodeId: initial.rootNodeId,
  evalResult: null,

  setEvalResult: (evalResult) => set({ evalResult }),

  addNode: (node) => {
    const graph = get().graph;
    set({ graph: { ...graph, nodes: [...graph.nodes, node] } });
  },

  connect: (id, from, to) => {
    const current = get().graph;
    const next: Graph = {
      version: current.version,
      nodes: current.nodes,
      edges: [
        ...current.edges.filter((e) => !(e.to.node === to.node && e.to.socket === to.socket)),
        { id, from, to },
      ],
    };
    set({ graph: next });
  },

  removeEdges: (ids) => {
    if (ids.size === 0) return;
    const graph = get().graph;
    const filtered = graph.edges.filter((e) => !ids.has(e.id));
    if (filtered.length === graph.edges.length) return;
    set({ graph: { ...graph, edges: filtered } });
  },

  removeNodes: (ids) => {
    if (ids.size === 0) return;
    const graph = get().graph;
    const nodes = graph.nodes.filter((n) => !ids.has(n.id));
    const edges = graph.edges.filter((e) => !ids.has(e.from.node) && !ids.has(e.to.node));
    if (nodes.length === graph.nodes.length && edges.length === graph.edges.length) return;
    set({ graph: { ...graph, nodes, edges } });
  },

  setInputValue: (nodeId, name, value) => {
    const graph = get().graph;
    const idx = graph.nodes.findIndex((n) => n.id === nodeId);
    if (idx < 0) return;
    const old = graph.nodes[idx]!;
    const inputValues = { ...(old.inputValues ?? {}), [name]: value };
    const updated: GraphNode = { ...old, inputValues };
    const nodes = [...graph.nodes];
    nodes[idx] = updated;
    set({ graph: { ...graph, nodes } });
  },
}));
