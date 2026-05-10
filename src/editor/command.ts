import type { Graph, GraphEdge, GraphNode, SocketRef } from '../core/graph.js';

// Every UI mutation builds one of these and dispatches it to the store. The
// command captures *enough* state to both apply and reverse the change without
// re-querying the graph at undo time. Same shape doubles as the building block
// for a future scripting/API capture log: each command is a portable
// description of "what just happened."
export type Command =
  | { kind: 'addNode'; node: GraphNode }
  | { kind: 'removeNodes'; nodes: GraphNode[]; edges: GraphEdge[] }
  | { kind: 'connect'; edge: GraphEdge; replaced: GraphEdge | null }
  | { kind: 'removeEdges'; edges: GraphEdge[] }
  | {
      kind: 'setInputValue';
      nodeId: string;
      name: string;
      before: unknown; // captured at dispatch time so undo can restore it
      after: unknown;
    }
  | { kind: 'replaceGraph'; before: GraphState; after: GraphState };

export interface GraphState {
  graph: Graph;
  rootNodeId: string;
}

export function applyForward(state: GraphState, cmd: Command): GraphState {
  const { graph, rootNodeId } = state;
  switch (cmd.kind) {
    case 'addNode':
      return {
        graph: { ...graph, nodes: [...graph.nodes, cmd.node] },
        rootNodeId,
      };
    case 'removeNodes': {
      const ids = new Set(cmd.nodes.map((n) => n.id));
      const edgeIds = new Set(cmd.edges.map((e) => e.id));
      return {
        graph: {
          ...graph,
          nodes: graph.nodes.filter((n) => !ids.has(n.id)),
          edges: graph.edges.filter((e) => !edgeIds.has(e.id)),
        },
        rootNodeId,
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
        const inputValues = { ...(n.inputValues ?? {}), [cmd.name]: cmd.after };
        return { ...n, inputValues };
      });
      return { graph: { ...graph, nodes }, rootNodeId };
    }
    case 'replaceGraph':
      return cmd.after;
  }
}

export function applyBackward(state: GraphState, cmd: Command): GraphState {
  const { graph, rootNodeId } = state;
  switch (cmd.kind) {
    case 'addNode':
      return {
        graph: { ...graph, nodes: graph.nodes.filter((n) => n.id !== cmd.node.id) },
        rootNodeId,
      };
    case 'removeNodes':
      return {
        graph: {
          ...graph,
          nodes: [...graph.nodes, ...cmd.nodes],
          edges: [...graph.edges, ...cmd.edges],
        },
        rootNodeId,
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
  }
}

// Re-export some types so the store can import everything from one place.
export type { GraphEdge, GraphNode, SocketRef };
