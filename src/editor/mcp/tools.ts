// Canonical MCP tool list for Sedon. Each entry is a self-contained
// { name, description, inputSchema, handler } — the same descriptor
// shape both the WebMCP browser adapter and a future Node-side
// (stdio / SSE) MCP server can consume.
//
// Mutation tools dispatch through the same store actions that the
// UI uses, so they go through the command pattern automatically:
// every tool call is a single undoable step (or no step at all,
// for reads).
//
// Schemas are JSON Schema (draft 2020-12 compatible) so they map
// cleanly into MCP tool definitions. Kept inline rather than
// auto-generated from TypeScript types because the LLM-facing
// shapes are intentionally narrower than the internal types — we
// want the schema to be a guide, not a flattened TS dump.

import type { GraphNode, SocketRef } from '../../core/graph.js';
import type { NodeRegistry } from '../../core/node-def.js';
import type { Action } from '../action.js';
import { GraphValidationError } from '../graph-validation.js';
import type { EditorState } from '../store.js';
import { SEDON_OVERVIEW } from './overview.js';

export interface SedonTool {
  name: string;
  description: string;
  inputSchema: object;
  handler: (args: Record<string, unknown>) => unknown;
}

/**
 * Shape returned to the agent when an input violates the graph's
 * invariants (unknown node id, type mismatch, etc.). The store's
 * `assertX` helpers throw `GraphValidationError`; this wrapper
 * converts that into a tool result the agent can branch on.
 *
 * Success returns flow through unchanged — tools already return ad-hoc
 * shapes ({ id }, { removed: N }, { ok: true }) and we don't want to
 * disturb those. Only the FAILURE case has a uniform shape.
 */
export interface ToolValidationError {
  ok: false;
  error: {
    code: string;
    message: string;
    detail: Record<string, unknown>;
  };
}

/**
 * Wrap a mutation handler so that throws of `GraphValidationError`
 * become a structured `{ ok: false, error }` return. Other errors
 * still propagate — they signal real bugs that the agent can't
 * recover from. Synchronous handlers stay synchronous.
 */
function catchValidation<T>(
  fn: (args: Record<string, unknown>) => T,
): (args: Record<string, unknown>) => T | ToolValidationError {
  return (args) => {
    try {
      return fn(args);
    } catch (e) {
      if (e instanceof GraphValidationError) {
        return { ok: false, error: { code: e.code, message: e.message, detail: e.detail } };
      }
      throw e;
    }
  };
}

/**
 * Build the canonical list of tools, given a getter for the current
 * editor store state and the runtime node registry. Both are
 * captured by closure so handlers always see fresh state — the
 * store is a Zustand store and the registry is a per-render
 * snapshot, both of which mutate over time.
 */
export interface SedonToolDeps {
  getState: () => EditorState;
  getRegistry: () => NodeRegistry;
  /**
   * Snapshot of the application's action registry — the same list
   * that powers the menu bar and the command palette. Recomputed
   * per call so an LLM that just created a subgraph sees the
   * resulting Add: subgraph/<id> action on the next listActions.
   */
  getActions: () => Action[];
}

export function buildSedonTools(deps: SedonToolDeps): SedonTool[] {
  const { getState, getRegistry, getActions } = deps;

  // ─── Read-only / introspection ────────────────────────────────

  const getSedonOverview: SedonTool = {
    name: 'getSedonOverview',
    description:
      'Return a multi-paragraph orientation document describing what Sedon is, how it relates to Houdini and Blender, the difference between Geometry and Scene types, what subgraphs are, and how to compose graphs. Call this once at the start of a session so subsequent tool calls land in the right mental model.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => ({ overview: SEDON_OVERVIEW }),
  };

  const listNodeKinds: SedonTool = {
    name: 'listNodeKinds',
    description:
      'List every available node kind in the registry, each with its id, category, summary, and the names + types of its input and output sockets. This is the ground truth for what kinds exist and what their sockets are named — DO NOT guess kind ids or socket names; consult this list first. Also lists every user-authored subgraph as a node kind of the form `subgraph/<id>`.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const defs = getRegistry().list();
      return {
        kinds: defs.map((d) => ({
          id: d.id,
          category: d.category,
          summary: d.doc?.summary ?? '',
          inputs: d.inputs.map((i) => ({
            name: i.name,
            type: i.type,
            description: i.description ?? '',
          })),
          outputs: d.outputs.map((o) => ({
            name: o.name,
            type: o.type,
            description: o.description ?? '',
          })),
        })),
      };
    },
  };

  const listGraphNodes: SedonTool = {
    name: 'listGraphNodes',
    description:
      'List every node currently in the active graph (the one being edited — usually main, but switches when setActiveEditing is called). Each entry includes id, kind, optional name, position, and authored inputValues. Use this to see the current state before making changes; pair with `listGraphEdges` to understand wiring.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const { graph } = getState();
      return {
        nodes: graph.nodes.map((n) => ({
          id: n.id,
          kind: n.kind,
          name: n.name ?? null,
          position: n.position ?? null,
          inputValues: n.inputValues ?? {},
        })),
      };
    },
  };

  const listGraphEdges: SedonTool = {
    name: 'listGraphEdges',
    description:
      'List every edge currently in the active graph. Each entry has id + from (node id, socket name) + to (node id, socket name). Use this with `listGraphNodes` to fully describe the current wiring.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const { graph } = getState();
      return {
        edges: graph.edges.map((e) => ({
          id: e.id,
          from: { node: e.from.node, socket: e.from.socket },
          to: { node: e.to.node, socket: e.to.socket },
        })),
      };
    },
  };

  const getNodeInputValue: SedonTool = {
    name: 'getNodeInputValue',
    description:
      'Read the authored value of a specific input socket on a specific node. Returns null when the socket has no authored value (in which case the node uses the input\'s default value from its NodeDef). Use this before calling setInputValue to know what you are changing.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'id of the node to inspect' },
        name: { type: 'string', description: 'input socket name' },
      },
      required: ['nodeId', 'name'],
      additionalProperties: false,
    },
    handler: (args) => {
      const nodeId = String(args.nodeId);
      const name = String(args.name);
      const node = getState().graph.nodes.find((n) => n.id === nodeId);
      if (!node) throw new Error(`getNodeInputValue: no node with id "${nodeId}"`);
      return { value: node.inputValues?.[name] ?? null };
    },
  };

  // ─── Mutations (each one undoable as a single step) ───────────

  const addNode: SedonTool = {
    name: 'addNode',
    description:
      'Add a node to the active graph. `kind` is the node id from `listNodeKinds` (e.g. "geom/sphere", "subgraph/chair"). `id` is optional — when omitted a fresh uuid is generated. `position` is the canvas position in pixels (default origin). `inputValues` is an optional map of authored values keyed by input socket name; any sockets not listed inherit their NodeDef default. UNDOABLE.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'node kind id (e.g. "geom/sphere")' },
        id: { type: 'string', description: 'optional explicit node id; uuid generated if omitted' },
        name: { type: 'string', description: 'optional cosmetic display name' },
        position: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['x', 'y'],
          additionalProperties: false,
        },
        inputValues: {
          type: 'object',
          description: 'optional authored input values keyed by socket name',
          additionalProperties: true,
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    handler: catchValidation((args) => {
      const kind = String(args.kind);
      const id = typeof args.id === 'string' && args.id.length > 0 ? args.id : crypto.randomUUID();
      const node: GraphNode = {
        id,
        kind,
      };
      if (typeof args.name === 'string') node.name = args.name;
      if (args.position && typeof args.position === 'object') {
        const p = args.position as { x?: unknown; y?: unknown };
        if (typeof p.x === 'number' && typeof p.y === 'number') {
          node.position = { x: p.x, y: p.y };
        }
      }
      if (args.inputValues && typeof args.inputValues === 'object') {
        node.inputValues = args.inputValues as Record<string, unknown>;
      }
      getState().addNode(node);
      return { id };
    }),
  };

  const removeNodes: SedonTool = {
    name: 'removeNodes',
    description:
      'Remove one or more nodes from the active graph by id. Any edges incident to a removed node are also removed (and rolled back on undo). UNDOABLE.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'node ids to remove',
        },
      },
      required: ['ids'],
      additionalProperties: false,
    },
    handler: (args) => {
      const ids = (args.ids as unknown[] | undefined) ?? [];
      const set = new Set(ids.map((x) => String(x)));
      if (set.size === 0) return { removed: 0 };
      getState().removeNodes(set);
      return { removed: set.size };
    },
  };

  const connect: SedonTool = {
    name: 'connect',
    description:
      'Connect an output socket on one node to an input socket on another. Both ends are specified as { node: <id>, socket: <name> }. The call returns `{ ok: false, error: { code, message, detail } }` if either node or socket does not exist, the types are incompatible, the source and target are the same node, or the requested edge id is taken — call `listNodeKinds` and `listGraphNodes` first to confirm socket names and types. When the target input socket is already connected, the existing edge is REPLACED (this is the same single-edge-per-input convention the canvas enforces). UNDOABLE.',
    inputSchema: {
      type: 'object',
      properties: {
        from: socketRefSchema('source output socket'),
        to: socketRefSchema('target input socket'),
        id: { type: 'string', description: 'optional edge id; uuid generated if omitted' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    handler: catchValidation((args) => {
      const from = parseSocketRef(args.from, 'from');
      const to = parseSocketRef(args.to, 'to');
      const id = typeof args.id === 'string' && args.id.length > 0 ? args.id : crypto.randomUUID();
      getState().connect(id, from, to);
      return { id };
    }),
  };

  const removeEdges: SedonTool = {
    name: 'removeEdges',
    description:
      'Remove edges by id. To find edge ids, call `listGraphEdges`. UNDOABLE.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'edge ids to remove',
        },
      },
      required: ['ids'],
      additionalProperties: false,
    },
    handler: (args) => {
      const ids = (args.ids as unknown[] | undefined) ?? [];
      const set = new Set(ids.map((x) => String(x)));
      if (set.size === 0) return { removed: 0 };
      getState().removeEdges(set);
      return { removed: set.size };
    },
  };

  const setInputValue: SedonTool = {
    name: 'setInputValue',
    description:
      'Authored a specific input socket value on a specific node. Pass `value` as the raw type the input expects (number, array of numbers, string, …). The previous value is captured for undo; consecutive setInputValue calls on the same (node, input) coalesce into ONE undo step by default — pass `coalesce: false` to make each call its own undo step. UNDOABLE.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        name: { type: 'string', description: 'input socket name' },
        value: { description: 'raw authored value; type depends on the input' },
        coalesce: {
          type: 'boolean',
          default: true,
          description: 'when false, this call is its own undo entry instead of being coalesced',
        },
      },
      required: ['nodeId', 'name', 'value'],
      additionalProperties: false,
    },
    handler: catchValidation((args) => {
      const nodeId = String(args.nodeId);
      const name = String(args.name);
      const value = args.value;
      const opts: { coalesce?: boolean } = {};
      if (typeof args.coalesce === 'boolean') opts.coalesce = args.coalesce;
      getState().setInputValue(nodeId, name, value, opts);
      return { ok: true };
    }),
  };

  const renameNode: SedonTool = {
    name: 'renameNode',
    description:
      'Set or clear the cosmetic display name of a node. Pass an empty string to clear (the canvas falls back to the kind default). Purely visual — does NOT change the node id or affect the eval cache. UNDOABLE.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['nodeId', 'name'],
      additionalProperties: false,
    },
    handler: (args) => {
      const nodeId = String(args.nodeId);
      const name = String(args.name);
      getState().renameNode(nodeId, name);
      return { ok: true };
    },
  };

  const createSubgraph: SedonTool = {
    name: 'createSubgraph',
    description:
      'Create a brand-new empty subgraph with the given id and label, and switch the editing context to it so subsequent addNode / connect calls land inside it. Caller is responsible for picking a unique id — collisions silently shadow an existing subgraph. After creating, use addSubgraphSocket to give it inputs and outputs. UNDOABLE.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'unique subgraph id (kebab-case recommended)' },
        label: { type: 'string', description: 'human-readable display name' },
      },
      required: ['id', 'label'],
      additionalProperties: false,
    },
    handler: (args) => {
      const id = String(args.id);
      const label = String(args.label);
      getState().createSubgraph(id, label);
      return { id };
    },
  };

  const addSubgraphSocket: SedonTool = {
    name: 'addSubgraphSocket',
    description:
      'Add an input or output socket to an existing subgraph. The new socket appears on the subgraph-input or subgraph-output boundary node inside the subgraph AND on every wrapper instance (subgraph/<id>) in parent graphs. Specify `side` as "input" or "output". UNDOABLE.',
    inputSchema: {
      type: 'object',
      properties: {
        subgraphId: { type: 'string' },
        side: { type: 'string', enum: ['input', 'output'] },
        label: { type: 'string' },
        socketType: { type: 'string', description: 'type name (e.g. "Float", "Vec3", "Scene")' },
        description: { type: 'string' },
      },
      required: ['subgraphId', 'side', 'label', 'socketType'],
      additionalProperties: false,
    },
    handler: (args) => {
      const subgraphId = String(args.subgraphId);
      const side = String(args.side) as 'input' | 'output';
      if (side !== 'input' && side !== 'output') {
        throw new Error(`addSubgraphSocket: side must be "input" or "output", got "${side}"`);
      }
      const socket: { label: string; type: string; description?: string } = {
        label: String(args.label),
        type: String(args.socketType),
      };
      if (typeof args.description === 'string') socket.description = args.description;
      getState().addSubgraphSocket(subgraphId, side, socket);
      return { ok: true };
    },
  };

  const setActiveEditing: SedonTool = {
    name: 'setActiveEditing',
    description:
      'Switch which graph is currently being edited. Pass "main" for the project root graph, or a subgraph id (the id used in createSubgraph) to drill into a subgraph. Clears undo/redo because commands don\'t carry across editing contexts.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '"main" or a subgraph id' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: (args) => {
      const id = String(args.id);
      getState().setActiveEditing(id);
      return { ok: true };
    },
  };

  const getActiveEditing: SedonTool = {
    name: 'getActiveEditing',
    description:
      'Return the id of the graph currently being edited — "main" or a subgraph id. Use this to confirm where subsequent addNode / connect calls will land.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => ({ id: getState().currentEditingId }),
  };

  // ─── Actions registry (menu bar + palette parity) ─────────────
  //
  // Every user-callable command in Sedon is registered in
  // src/editor/actions.ts and consumed identically by the menu bar
  // and the command palette. Surfacing that same registry here
  // means a new menu item is automatically available to an LLM
  // agent — no extra MCP wiring per command. Two tools:
  //   • listActions — see what's available right now (and which
  //     are currently disabled, e.g. Undo with an empty stack).
  //   • runAction   — fire one by id.

  const listActions: SedonTool = {
    name: 'listActions',
    description:
      'List every registered application action — the same set the menu bar and command palette expose. Each entry includes id (use this with runAction), label (user-facing text from the palette, usually category-prefixed like "Edit: Undo"), optional shortcut hint, and an `enabled` flag (false means calling runAction will refuse). Refresh between mutations because some actions toggle enabled with live state (e.g. edit.undo follows the undo-stack length, and add.subgraph/<id> appears the moment you create a subgraph).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const actions = getActions();
      return {
        actions: actions.map((a) => ({
          id: a.id,
          label: a.label,
          shortcut: a.shortcut ?? '',
          enabled: a.enabled !== false,
        })),
      };
    },
  };

  const runAction: SedonTool = {
    name: 'runAction',
    description:
      'Fire a registered action by its id (see listActions). Equivalent to clicking the matching menu item or picking the entry in the command palette — same undo behavior, same side effects. Returns { ok: true } when the action ran (synchronously or once its returned promise settled). Refuses with an error if the action is unknown or currently disabled. Some actions depend on UI focus (e.g. assets.copy needs the asset view focused, view.frame-selected needs a canvas active); those become no-ops when nothing is focused — not an error, just nothing visibly happens. Prefer narrower MCP tools (addNode / connect / setInputValue) when you need precise control; reach for runAction for menu-level operations like view.cleanup, file.new, edit.undo, or add.new-subgraph that have no direct MCP equivalent.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Action id from listActions (e.g. "view.cleanup", "edit.undo", "add.new-subgraph").',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const id = String(args.id);
      const action = getActions().find((a) => a.id === id);
      if (!action) {
        throw new Error(`runAction: no action with id "${id}". Call listActions for the current set.`);
      }
      if (action.enabled === false) {
        throw new Error(`runAction: action "${id}" is currently disabled.`);
      }
      await action.run();
      return { ok: true };
    },
  };

  return [
    // Orientation first so the LLM lands on it before mutating.
    getSedonOverview,
    // Reads.
    listNodeKinds,
    listGraphNodes,
    listGraphEdges,
    getNodeInputValue,
    getActiveEditing,
    listActions,
    // Mutations.
    addNode,
    removeNodes,
    connect,
    removeEdges,
    setInputValue,
    renameNode,
    createSubgraph,
    addSubgraphSocket,
    setActiveEditing,
    runAction,
  ];
}

// ─── Schema helpers ─────────────────────────────────────────────

function socketRefSchema(description: string): object {
  return {
    type: 'object',
    description,
    properties: {
      node: { type: 'string', description: 'node id' },
      socket: { type: 'string', description: 'socket name' },
    },
    required: ['node', 'socket'],
    additionalProperties: false,
  };
}

function parseSocketRef(raw: unknown, field: string): SocketRef {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${field}: expected { node, socket } object`);
  }
  const obj = raw as { node?: unknown; socket?: unknown };
  if (typeof obj.node !== 'string' || typeof obj.socket !== 'string') {
    throw new Error(`${field}: both .node and .socket must be strings`);
  }
  return { node: obj.node, socket: obj.socket };
}
