import type { Graph, GraphEdge } from './graph.js';
import type { NodeContext, NodeOutputs, NodeRegistry } from './node-def.js';

export interface EvaluateOptions {
  rootNodeId: string;
  context?: NodeContext;
}

export interface EvaluateResult {
  outputs: NodeOutputs;
  order: string[];
}

export function topologicalOrder(graph: Graph, rootNodeId: string): string[] {
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    const list = incoming.get(e.to.node) ?? [];
    list.push(e);
    incoming.set(e.to.node, list);
  }

  const order: string[] = [];
  const visited = new Set<string>();
  const onStack = new Set<string>();

  function visit(nodeId: string) {
    if (visited.has(nodeId)) return;
    if (onStack.has(nodeId)) {
      throw new Error(`cycle detected at node ${nodeId}`);
    }
    onStack.add(nodeId);
    const incomingEdges = incoming.get(nodeId) ?? [];
    for (const e of incomingEdges) {
      visit(e.from.node);
    }
    onStack.delete(nodeId);
    visited.add(nodeId);
    order.push(nodeId);
  }

  visit(rootNodeId);
  return order;
}

export function evaluateGraph(
  graph: Graph,
  registry: NodeRegistry,
  options: EvaluateOptions,
): EvaluateResult {
  const order = topologicalOrder(graph, options.rootNodeId);
  const ctx: NodeContext = options.context ?? {};
  const outputs = new Map<string, NodeOutputs>();

  // Index incoming edges by (toNode, toSocket) for O(1) lookup.
  const incomingBySocket = new Map<string, { node: string; socket: string }>();
  for (const e of graph.edges) {
    incomingBySocket.set(`${e.to.node}/${e.to.socket}`, e.from);
  }

  for (const nodeId of order) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new Error(`node ${nodeId} not found in graph`);
    }
    const def = registry.get(node.kind);
    if (!def) {
      throw new Error(`unknown node kind: ${node.kind}`);
    }

    const inputs: Record<string, unknown> = {};
    for (const input of def.inputs) {
      const upstream = incomingBySocket.get(`${nodeId}/${input.name}`);
      if (upstream) {
        const upstreamOutputs = outputs.get(upstream.node);
        if (!upstreamOutputs) {
          throw new Error(`upstream node ${upstream.node} produced no outputs`);
        }
        inputs[input.name] = upstreamOutputs[upstream.socket];
      } else if (node.inputValues !== undefined && input.name in node.inputValues) {
        inputs[input.name] = node.inputValues[input.name];
      } else if (input.default !== undefined) {
        inputs[input.name] = input.default;
      } else {
        throw new Error(`input ${input.name} on ${def.id} has no value, edge, or default`);
      }
    }

    outputs.set(nodeId, def.evaluate(ctx, inputs));
  }

  const rootOutputs = outputs.get(options.rootNodeId);
  if (!rootOutputs) {
    throw new Error(`root node ${options.rootNodeId} produced no outputs`);
  }
  return { outputs: rootOutputs, order };
}
