import { useSyncExternalStore } from 'react';
import type { Graph, GraphNode } from '../core/graph.js';
import type { NodeOutputs } from '../core/node-def.js';

// Per-canvas data (graph + eval outputs) delivered to CustomNodes via
// a per-NODE external-store subscription instead of React context.
//
// Why: a CustomNode only needs ITS node's data + ITS output. Funneling
// the whole graph + the whole allOutputs map through CanvasPanelContext
// meant any edit (which produces a new graph object) and any eval
// (which produces a new allOutputs map) changed the context value, so
// EVERY CustomNode re-rendered — measured at ~105 CustomNode renders
// per drag tick on the Forest demo (35 nodes × ~3), the cause of the
// "editing one uniform tanks to ~10fps" bug.
//
// With this store each node subscribes to a reference-stable slice:
//   • useCanvasNode(panelId, id)        → the node's GraphNode + its
//                                          connected input sockets, kept
//                                          referentially stable across
//                                          edits that don't touch it.
//   • useCanvasNodeOutput(panelId, id)  → the node's eval output, which
//                                          is the SAME object across
//                                          evals on a cache hit.
// useSyncExternalStore re-renders a component only when its snapshot
// changes by Object.is, so editing one node re-renders one CustomNode,
// not all of them.

export interface CanvasNodeView {
  node: GraphNode;
  /** Input socket names that have an incoming edge (so the row hides its inline editor). */
  connectedSockets: string[];
}

interface PanelData {
  graph: Graph | null;
  outputs: Map<string, NodeOutputs> | null;
  /** node id → view, rebuilt on graph change but reused per-node when unchanged. */
  views: Map<string, CanvasNodeView>;
}

const panels = new Map<string, PanelData>();
const listeners = new Map<string, Set<() => void>>();

function getPanel(panelId: string): PanelData {
  let p = panels.get(panelId);
  if (!p) {
    p = { graph: null, outputs: null, views: new Map() };
    panels.set(panelId, p);
  }
  return p;
}

function notify(panelId: string): void {
  const ls = listeners.get(panelId);
  if (ls) for (const cb of [...ls]) cb();
}

function subscribe(panelId: string, cb: () => void): () => void {
  let s = listeners.get(panelId);
  if (!s) {
    s = new Set();
    listeners.set(panelId, s);
  }
  s.add(cb);
  return () => {
    s!.delete(cb);
    if (s!.size === 0) listeners.delete(panelId);
  };
}

function sameArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Publish the canvas's current graph. Rebuilds per-node views, REUSING
 * the previous view object for any node whose GraphNode reference AND
 * connected-socket set are unchanged — that referential stability is
 * what lets useSyncExternalStore skip re-rendering untouched nodes.
 */
export function setCanvasGraph(panelId: string, graph: Graph): void {
  const p = getPanel(panelId);
  if (p.graph === graph) return;
  // Incoming sockets per node, computed once over the edge list.
  const incoming = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = incoming.get(e.to.node);
    if (list) list.push(e.to.socket);
    else incoming.set(e.to.node, [e.to.socket]);
  }
  const prevViews = p.views;
  const views = new Map<string, CanvasNodeView>();
  for (const node of graph.nodes) {
    const connectedSockets = incoming.get(node.id) ?? [];
    const prev = prevViews.get(node.id);
    if (prev && prev.node === node && sameArray(prev.connectedSockets, connectedSockets)) {
      views.set(node.id, prev); // unchanged → keep stable reference
    } else {
      views.set(node.id, { node, connectedSockets });
    }
  }
  p.graph = graph;
  p.views = views;
  notify(panelId);
}

/** Publish the canvas's latest per-node eval outputs. */
export function setCanvasOutputs(panelId: string, outputs: Map<string, NodeOutputs>): void {
  getPanel(panelId).outputs = outputs;
  notify(panelId);
}

/** Forget a panel's data on unmount. */
export function clearCanvasData(panelId: string): void {
  panels.delete(panelId);
  notify(panelId);
}

const EMPTY_SUBSCRIBE = () => () => {};

export function useCanvasNode(panelId: string | null, nodeId: string): CanvasNodeView | undefined {
  return useSyncExternalStore(
    panelId ? (cb) => subscribe(panelId, cb) : EMPTY_SUBSCRIBE,
    () => (panelId ? panels.get(panelId)?.views.get(nodeId) : undefined),
  );
}

export function useCanvasNodeOutput(panelId: string | null, nodeId: string): NodeOutputs | undefined {
  return useSyncExternalStore(
    panelId ? (cb) => subscribe(panelId, cb) : EMPTY_SUBSCRIBE,
    () => (panelId ? panels.get(panelId)?.outputs?.get(nodeId) : undefined),
  );
}
