import type { NodeRegistry } from './node-def.js';
import type { TypeRegistry } from './types.js';

export const GRAPH_VERSION = 1;

export interface GraphNode {
  id: string;
  kind: string;
  position?: { x: number; y: number };
  inputValues?: Record<string, unknown>;
}

export interface SocketRef {
  node: string;
  socket: string;
}

export interface GraphEdge {
  id: string;
  from: SocketRef;
  to: SocketRef;
}

export interface Graph {
  version: typeof GRAPH_VERSION;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function createGraph(): Graph {
  return { version: GRAPH_VERSION, nodes: [], edges: [] };
}

function newId(): string {
  return crypto.randomUUID();
}

export interface AddNodeOptions {
  id?: string;
  position?: { x: number; y: number };
  inputValues?: Record<string, unknown>;
}

export function addNode(graph: Graph, kind: string, opts: AddNodeOptions = {}): GraphNode {
  const node: GraphNode = {
    id: opts.id ?? newId(),
    kind,
    ...(opts.position !== undefined ? { position: opts.position } : {}),
    ...(opts.inputValues !== undefined ? { inputValues: opts.inputValues } : {}),
  };
  graph.nodes.push(node);
  return node;
}

export function addEdge(graph: Graph, from: SocketRef, to: SocketRef): GraphEdge {
  const edge: GraphEdge = { id: newId(), from, to };
  graph.edges.push(edge);
  return edge;
}

export function findNode(graph: Graph, id: string): GraphNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

export function removeNode(graph: Graph, id: string): void {
  graph.nodes = graph.nodes.filter((n) => n.id !== id);
  graph.edges = graph.edges.filter((e) => e.from.node !== id && e.to.node !== id);
}

export function removeEdge(graph: Graph, id: string): void {
  graph.edges = graph.edges.filter((e) => e.id !== id);
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export function validateGraph(
  graph: Graph,
  types: TypeRegistry,
  nodes: NodeRegistry,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (graph.version !== GRAPH_VERSION) {
    issues.push({
      severity: 'error',
      message: `unsupported graph version: ${graph.version} (expected ${GRAPH_VERSION})`,
    });
  }

  const seenIds = new Set<string>();
  for (const n of graph.nodes) {
    if (seenIds.has(n.id)) {
      issues.push({ severity: 'error', message: `duplicate node id`, nodeId: n.id });
    }
    seenIds.add(n.id);

    const def = nodes.get(n.kind);
    if (!def) {
      issues.push({ severity: 'error', message: `unknown node kind: ${n.kind}`, nodeId: n.id });
    }
  }

  for (const e of graph.edges) {
    const fromNode = findNode(graph, e.from.node);
    const toNode = findNode(graph, e.to.node);
    if (!fromNode) {
      issues.push({ severity: 'error', message: `edge source node missing`, edgeId: e.id });
      continue;
    }
    if (!toNode) {
      issues.push({ severity: 'error', message: `edge target node missing`, edgeId: e.id });
      continue;
    }
    const fromDef = nodes.get(fromNode.kind);
    const toDef = nodes.get(toNode.kind);
    if (!fromDef || !toDef) continue; // already reported above

    const fromOut = fromDef.outputs.find((o) => o.name === e.from.socket);
    const toIn = toDef.inputs.find((i) => i.name === e.to.socket);
    if (!fromOut) {
      issues.push({
        severity: 'error',
        message: `output ${e.from.socket} not found on ${fromDef.id}`,
        edgeId: e.id,
      });
      continue;
    }
    if (!toIn) {
      issues.push({
        severity: 'error',
        message: `input ${e.to.socket} not found on ${toDef.id}`,
        edgeId: e.id,
      });
      continue;
    }
    if (!types.isCompatible(fromOut.type, toIn.type)) {
      issues.push({
        severity: 'error',
        message: `incompatible socket types: ${fromOut.type} -> ${toIn.type}`,
        edgeId: e.id,
      });
    }
  }

  // Inputs that have no edge connected and no default and no inputValue → error.
  const incomingByTarget = new Map<string, GraphEdge>();
  for (const e of graph.edges) {
    incomingByTarget.set(`${e.to.node}/${e.to.socket}`, e);
  }
  for (const n of graph.nodes) {
    const def = nodes.get(n.kind);
    if (!def) continue;
    for (const input of def.inputs) {
      const hasEdge = incomingByTarget.has(`${n.id}/${input.name}`);
      const hasOverride = n.inputValues !== undefined && input.name in n.inputValues;
      const hasDefault = input.default !== undefined;
      if (!hasEdge && !hasOverride && !hasDefault) {
        issues.push({
          severity: 'error',
          message: `required input ${input.name} on ${def.id} is not connected and has no default`,
          nodeId: n.id,
        });
      }
    }
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

export function toJSON(graph: Graph): string {
  return JSON.stringify(graph);
}

export function fromJSON(json: string): Graph {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('invalid graph JSON: not an object');
  }
  const obj = parsed as Partial<Graph>;
  if (obj.version !== GRAPH_VERSION) {
    throw new Error(`unsupported graph version: ${obj.version}`);
  }
  if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) {
    throw new Error('invalid graph JSON: missing nodes or edges arrays');
  }
  return obj as Graph;
}
