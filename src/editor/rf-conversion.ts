import type { Edge, Node } from '@xyflow/react';
import type { Graph } from '../core/graph.js';

// Convert our Graph into the React Flow node/edge shapes the canvas expects.
// Used both at first-mount (seed) and on graph load.

export function graphToRfNodes(graph: Graph): Node[] {
  return graph.nodes.map((n, i) => ({
    id: n.id,
    type: 'sedon',
    position: n.position ?? { x: i * 240, y: i * 80 },
    data: { kind: n.kind },
  }));
}

export function graphToRfEdges(graph: Graph): Edge[] {
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.from.node,
    target: e.to.node,
    sourceHandle: e.from.socket,
    targetHandle: e.to.socket,
  }));
}
