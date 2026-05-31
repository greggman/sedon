import type { Edge, Node } from '@xyflow/react';
import type { Graph } from '../core/graph.js';
import type { NodeRegistry } from '../core/node-def.js';
import { createCoreTypeRegistry } from '../core/types.js';

// Convert our Graph into the React Flow node/edge shapes the canvas expects.
// Used both at first-mount (seed) and on graph load.

// Same type-color palette the node bodies use (output bar, handle fills).
// Resolving the color here keeps connection lines visually consistent with
// the socket dot they originate from.
const types = createCoreTypeRegistry();

function typeColor(typeId: string): string {
  return types.get(typeId)?.color ?? '#888';
}

// Resolve the color of an edge from the source socket's TYPE — looked up
// via the source node's kind in the node registry. Falls back to grey if
// the kind isn't registered (e.g., a subgraph load race).
export function edgeColor(
  graph: Graph,
  sourceNodeId: string,
  sourceSocket: string,
  registry: NodeRegistry,
): string {
  const node = graph.nodes.find((n) => n.id === sourceNodeId);
  if (!node) return '#888';
  // Per-instance extraOutputs (for-each-point) REPLACE the static
  // def.outputs when present, so check those first. Falling back to
  // the def keeps regular nodes unchanged.
  const fromExtras = node.extraOutputs?.find((o) => o.name === sourceSocket);
  if (fromExtras) return typeColor(fromExtras.type);
  const def = registry.get(node.kind);
  const out = def?.outputs.find((o) => o.name === sourceSocket);
  return out ? typeColor(out.type) : '#888';
}

export function graphToRfNodes(
  graph: Graph,
  positions: Record<string, { x: number; y: number }> | undefined,
): Node[] {
  return graph.nodes.map((n, i) => ({
    id: n.id,
    type: 'sedon',
    // Live positions from the editor store win; fall back to the
    // graph-node carrier (used for initial seeding from demos/save
    // files) and finally to a deterministic per-index layout for
    // freshly-added nodes that haven't been positioned yet.
    position: positions?.[n.id] ?? n.position ?? { x: i * 240, y: i * 80 },
    data: { kind: n.kind },
  }));
}

export function graphToRfEdges(graph: Graph, registry: NodeRegistry): Edge[] {
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.from.node,
    target: e.to.node,
    sourceHandle: e.from.socket,
    targetHandle: e.to.socket,
    style: { stroke: edgeColor(graph, e.from.node, e.from.socket, registry), strokeWidth: 2 },
  }));
}
