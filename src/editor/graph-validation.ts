// Centralised validation helpers for the store actions that build /
// modify the graph. Anything that can put Sedon into an unrenderable
// state (a connection to a non-existent socket, an addNode with a
// duplicate id, a setInputValue on a socket the node doesn't have)
// flows through these checks.
//
// The store actions throw `GraphValidationError` on bad input. UI call
// sites are already pre-validated (React Flow's `isValidConnection`
// runs before any onConnect; the inspector knows what sockets a node
// has), so a throw is a real bug worth surfacing. MCP tool handlers
// catch it and translate to a structured `{ ok: false, error }` so
// the agent can recover.
//
// `code` is a stable, machine-readable string — MCP returns it
// verbatim; UI can switch on it for friendly messages. `detail`
// carries the relevant ids so the caller can build a fix without
// re-parsing the message.

import {
  findOutputOnNode,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type SocketRef,
} from '../core/graph.js';
import type { InputDef, NodeDef, NodeRegistry, OutputDef } from '../core/node-def.js';
import type { TypeRegistry } from '../core/types.js';

export type GraphValidationCode =
  | 'node_not_found'
  | 'duplicate_node_id'
  | 'duplicate_edge_id'
  | 'unknown_kind'
  | 'socket_not_found'
  | 'type_mismatch'
  | 'self_loop';

export class GraphValidationError extends Error {
  readonly code: GraphValidationCode;
  readonly detail: Record<string, unknown>;
  constructor(code: GraphValidationCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GraphValidationError';
    this.code = code;
    this.detail = detail;
  }
}

export function assertNodeExists(graph: Graph, nodeId: string): GraphNode {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) {
    throw new GraphValidationError(
      'node_not_found',
      `no node with id "${nodeId}" in the active graph`,
      { nodeId },
    );
  }
  return node;
}

export function assertNotDuplicateNodeId(graph: Graph, nodeId: string): void {
  if (graph.nodes.some((n) => n.id === nodeId)) {
    throw new GraphValidationError(
      'duplicate_node_id',
      `a node with id "${nodeId}" already exists`,
      { nodeId },
    );
  }
}

export function assertNotDuplicateEdgeId(graph: Graph, edgeId: string): void {
  if (graph.edges.some((e) => e.id === edgeId)) {
    throw new GraphValidationError(
      'duplicate_edge_id',
      `an edge with id "${edgeId}" already exists`,
      { edgeId },
    );
  }
}

export function assertKnownKind(registry: NodeRegistry, kind: string): NodeDef {
  const def = registry.get(kind);
  if (!def) {
    throw new GraphValidationError(
      'unknown_kind',
      `unknown node kind: "${kind}"`,
      { kind },
    );
  }
  return def;
}

/**
 * Look up an input socket by name on a node, consulting per-instance
 * `extraInputs` (variadic node bonus inputs) as well as `def.inputs`.
 * Throws when neither has a socket of the given name.
 */
export function assertInputSocketExists(
  node: GraphNode,
  def: NodeDef,
  name: string,
): InputDef {
  const fromExtras = node.extraInputs?.find((i) => i.name === name);
  if (fromExtras) return fromExtras;
  const fromDef = def.inputs.find((i) => i.name === name);
  if (fromDef) return fromDef;
  throw new GraphValidationError(
    'socket_not_found',
    `node "${node.id}" (kind "${node.kind}") has no input socket "${name}"`,
    { nodeId: node.id, kind: node.kind, side: 'input', socket: name },
  );
}

/**
 * Look up an output socket by name. Uses `findOutputOnNode` so
 * per-instance `extraOutputs` (e.g. for-each-point's lifted body
 * outputs) are visible too.
 */
export function assertOutputSocketExists(
  node: GraphNode,
  def: NodeDef,
  name: string,
): OutputDef {
  const found = findOutputOnNode(node, def, name);
  if (!found) {
    throw new GraphValidationError(
      'socket_not_found',
      `node "${node.id}" (kind "${node.kind}") has no output socket "${name}"`,
      { nodeId: node.id, kind: node.kind, side: 'output', socket: name },
    );
  }
  return found;
}

export function assertTypeCompatible(
  types: TypeRegistry,
  fromType: string,
  toType: string,
  context: Record<string, unknown> = {},
): void {
  if (!types.isCompatible(fromType, toType)) {
    throw new GraphValidationError(
      'type_mismatch',
      `cannot connect output of type "${fromType}" to input of type "${toType}"`,
      { fromType, toType, ...context },
    );
  }
}

/**
 * Full check for a new edge: both endpoints exist in the active graph,
 * both sockets exist on their respective nodes (with extras), source is
 * an output and target is an input (implicit — `from` looks up output,
 * `to` looks up input), types are compatible, and from ≠ to (no
 * self-loop). Throws on the first failure.
 *
 * Replacing an existing edge into the target input is allowed — that's
 * the canvas's "single-edge-per-input" convention, handled at the
 * store level via the `replaced` field on the connect command.
 */
export function assertConnectIsValid(
  graph: Graph,
  registry: NodeRegistry,
  types: TypeRegistry,
  from: SocketRef,
  to: SocketRef,
): { fromOut: OutputDef; toIn: InputDef } {
  if (from.node === to.node) {
    throw new GraphValidationError(
      'self_loop',
      `cannot connect node "${from.node}" to itself`,
      { nodeId: from.node },
    );
  }
  const fromNode = assertNodeExists(graph, from.node);
  const toNode = assertNodeExists(graph, to.node);
  const fromDef = assertKnownKind(registry, fromNode.kind);
  const toDef = assertKnownKind(registry, toNode.kind);
  const fromOut = assertOutputSocketExists(fromNode, fromDef, from.socket);
  const toIn = assertInputSocketExists(toNode, toDef, to.socket);
  assertTypeCompatible(types, fromOut.type, toIn.type, {
    from: { node: from.node, socket: from.socket },
    to: { node: to.node, socket: to.socket },
  });
  return { fromOut, toIn };
}

/**
 * Check that the value being written to an input socket plausibly
 * matches the socket's declared type. This is intentionally lightweight
 * — we verify shape and primitive type, not numeric ranges or
 * domain-specific constraints. The goal is to catch obvious mistakes
 * (passing `"hello"` to a Float, passing `[1,2]` to a Vec4) without
 * gatekeeping every authoring nuance.
 *
 * GPU-bearing types (Texture2D, Material, Geometry, Scene, …) are NOT
 * validated here — their values are GPU handles that can only come
 * from connected outputs, never from a literal author-time value.
 * Writing one through this path is itself a misuse; the upstream
 * `assertSerializableDefault` guard already blocks it at boundary
 * creation, so we just let setInputValue proceed and surface any
 * runtime issue later.
 */
export function assertValueShapeForType(socketType: string, value: unknown): void {
  if (value === undefined || value === null) return; // "clear override" — allowed
  const fail = (expected: string) => {
    throw new GraphValidationError(
      'type_mismatch',
      `value for ${socketType} input must be ${expected}; got ${describeValue(value)}`,
      { socketType, valueKind: describeValue(value) },
    );
  };
  switch (socketType) {
    case 'Float':
    case 'Int':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('a finite number');
      return;
    case 'Bool':
      if (typeof value !== 'boolean') fail('a boolean');
      return;
    case 'String':
      if (typeof value !== 'string') fail('a string');
      return;
    case 'Vec2':
    case 'Vec2i':
      if (!isNumberArrayOfLength(value, 2)) fail('a length-2 array of numbers');
      return;
    case 'Vec3':
      if (!isNumberArrayOfLength(value, 3)) fail('a length-3 array of numbers');
      return;
    case 'Vec4':
    case 'Quaternion':
    case 'Color':
      if (!isNumberArrayOfLength(value, 4)) fail('a length-4 array of numbers');
      return;
    default:
      // Unknown / GPU-bearing type — don't second-guess. setInputValue
      // is rarely the right path for these; if a caller does write
      // something weird, the evaluator will surface a real error.
      return;
  }
}

function isNumberArrayOfLength(v: unknown, n: number): v is number[] {
  if (!Array.isArray(v) || v.length !== n) return false;
  for (const x of v) if (typeof x !== 'number' || !Number.isFinite(x)) return false;
  return true;
}

function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(length=${v.length})`;
  return typeof v;
}

// Re-export shapes the store needs from one place so callers don't
// have to hop between modules.
export type { GraphEdge, GraphNode, SocketRef };
