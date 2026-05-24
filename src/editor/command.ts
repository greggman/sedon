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
  | { kind: 'replaceGraph'; before: GraphState; after: GraphState }
  | { kind: 'replaceProject'; before: ProjectSnapshot; after: ProjectSnapshot };

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
    case 'replaceProject':
      // Project-scoped — its blast radius is wider than GraphState. The
      // store handles it directly in undo/redo by swapping the snapshot.
      throw new Error('replaceProject must be applied at the store level, not via applyForward');
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
    case 'replaceProject':
      throw new Error('replaceProject must be applied at the store level, not via applyBackward');
  }
}

// Re-export some types so the store can import everything from one place.
export type { GraphEdge, GraphNode, SocketRef };
