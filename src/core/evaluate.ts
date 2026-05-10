import type { Graph, GraphEdge } from './graph.js';
import type { NodeContext, NodeOutputs, NodeRegistry } from './node-def.js';

export interface EvaluateOptions {
  rootNodeId: string;
  context?: NodeContext;
}

export interface EvaluateResult {
  outputs: NodeOutputs;
  order: string[];
  allOutputs: Map<string, NodeOutputs>;
}

// Topological order of every node in the graph (not just ancestors of any
// particular root). Used by the editor evaluator so disconnected nodes still
// get to produce previews.
export function topologicalOrderAll(graph: Graph): string[] {
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

  for (const node of graph.nodes) {
    visit(node.id);
  }
  return order;
}

// Topological order restricted to ancestors of `rootNodeId`. Kept for
// callers that genuinely want minimal work (and for tests).
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

export async function evaluateGraph(
  graph: Graph,
  registry: NodeRegistry,
  options: EvaluateOptions,
): Promise<EvaluateResult> {
  const order = topologicalOrderAll(graph);
  const ctx: NodeContext = options.context ?? {};
  const outputs = new Map<string, NodeOutputs>();

  // Index incoming edges by (toNode, toSocket) for O(1) lookup.
  const incomingBySocket = new Map<string, { node: string; socket: string }>();
  for (const e of graph.edges) {
    incomingBySocket.set(`${e.to.node}/${e.to.socket}`, e.from);
  }

  for (const nodeId of order) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) continue;
    const def = registry.get(node.kind);
    if (!def) continue;

    // Resolve inputs. If any required input has no source, skip this node so a
    // node that just got added with required Texture2D inputs (e.g. Material
    // with unconnected basecolor) doesn't blow up the whole eval — it just
    // won't produce a preview until wired up.
    const inputs: Record<string, unknown> = {};
    let canEvaluate = true;
    for (const input of def.inputs) {
      const upstream = incomingBySocket.get(`${nodeId}/${input.name}`);
      if (upstream) {
        const upstreamOutputs = outputs.get(upstream.node);
        if (!upstreamOutputs) {
          canEvaluate = false;
          break;
        }
        inputs[input.name] = upstreamOutputs[upstream.socket];
      } else if (node.inputValues !== undefined && input.name in node.inputValues) {
        inputs[input.name] = node.inputValues[input.name];
      } else if (input.default !== undefined) {
        inputs[input.name] = input.default;
      } else if (input.optional) {
        inputs[input.name] = undefined;
      } else {
        canEvaluate = false;
        break;
      }
    }
    if (!canEvaluate) continue;

    try {
      // Sync nodes return outputs directly; async nodes return a Promise.
      // Awaiting both shapes works without runtime branching.
      outputs.set(nodeId, await def.evaluate(ctx, inputs));
    } catch (e) {
      console.error(`evaluation of ${def.id} (${nodeId}) failed:`, e);
    }
  }

  const rootOutputs = outputs.get(options.rootNodeId);
  if (!rootOutputs) {
    throw new Error(`root node ${options.rootNodeId} produced no outputs`);
  }
  return { outputs: rootOutputs, order, allOutputs: outputs };
}
