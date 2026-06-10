// Validation contract for mutating store actions. Every rejection path
// has a test so a regression to "silent corruption on bad input" can't
// land unnoticed.
//
// Layered:
//   1. Helpers in graph-validation.ts — pure functions, easy to pin.
//   2. Store actions (addNode / connect / setInputValue) call the
//      helpers and propagate the throw.
//   3. MCP tool handlers wrap the throw into `{ ok: false, error }`.
//
// Tests cover all three layers so the contract holds end-to-end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import {
  assertConnectIsValid,
  assertInputSocketExists,
  assertKnownKind,
  assertNodeExists,
  assertNotDuplicateEdgeId,
  assertNotDuplicateNodeId,
  assertOutputSocketExists,
  assertTypeCompatible,
  assertValueShapeForType,
  GraphValidationError,
} from '../../src/editor/graph-validation.js';
import { buildRegistry } from '../../src/editor/registry.js';
import { useEditorStore } from '../../src/editor/store.js';
import { buildSedonTools, type SedonTool } from '../../src/editor/mcp/tools.js';
import { createCoreTypeRegistry } from '../../src/core/types.js';

// -----------------------------------------------------------------
// Pure-helper assertions
// -----------------------------------------------------------------

test('assertNodeExists throws node_not_found for an unknown id', () => {
  const g = createGraph();
  addNode(g, 'tex/perlin', { id: 'real' });
  assert.throws(() => assertNodeExists(g, 'missing'), (e) => {
    return e instanceof GraphValidationError
      && e.code === 'node_not_found'
      && e.detail['nodeId'] === 'missing';
  });
});

test('assertNotDuplicateNodeId throws duplicate_node_id when id is taken', () => {
  const g = createGraph();
  addNode(g, 'tex/perlin', { id: 'a' });
  assert.throws(() => assertNotDuplicateNodeId(g, 'a'), (e) =>
    e instanceof GraphValidationError && e.code === 'duplicate_node_id',
  );
});

test('assertNotDuplicateEdgeId throws on a taken edge id', () => {
  const g = createGraph();
  const a = addNode(g, 'tex/perlin');
  const b = addNode(g, 'tex/perlin');
  const edge = addEdge(g, { node: a.id, socket: 'texture' }, { node: b.id, socket: 'gain' });
  assert.throws(() => assertNotDuplicateEdgeId(g, edge.id), (e) =>
    e instanceof GraphValidationError && e.code === 'duplicate_edge_id',
  );
});

test('assertKnownKind throws unknown_kind on a bogus kind id', () => {
  const registry = buildRegistry([]);
  assert.throws(() => assertKnownKind(registry, 'core/not-a-real-node'), (e) =>
    e instanceof GraphValidationError && e.code === 'unknown_kind',
  );
});

test('assertInputSocketExists throws socket_not_found for a missing input', () => {
  const g = createGraph();
  const node = addNode(g, 'tex/perlin');
  const registry = buildRegistry([]);
  const def = registry.get('tex/perlin')!;
  assert.throws(() => assertInputSocketExists(node, def, 'nope'), (e) => {
    return e instanceof GraphValidationError
      && e.code === 'socket_not_found'
      && e.detail['side'] === 'input';
  });
});

test('assertOutputSocketExists throws socket_not_found for a missing output', () => {
  const g = createGraph();
  const node = addNode(g, 'tex/perlin');
  const registry = buildRegistry([]);
  const def = registry.get('tex/perlin')!;
  assert.throws(() => assertOutputSocketExists(node, def, 'nope'), (e) => {
    return e instanceof GraphValidationError
      && e.code === 'socket_not_found'
      && e.detail['side'] === 'output';
  });
});

test('assertTypeCompatible throws type_mismatch for incompatible types', () => {
  const types = createCoreTypeRegistry();
  assert.throws(() => assertTypeCompatible(types, 'Texture2D', 'Float'), (e) =>
    e instanceof GraphValidationError && e.code === 'type_mismatch',
  );
});

test('assertTypeCompatible PASSES on a registered conversion (Int → Float)', () => {
  const types = createCoreTypeRegistry();
  assert.doesNotThrow(() => assertTypeCompatible(types, 'Int', 'Float'));
});

test('assertConnectIsValid rejects self-loop', () => {
  const g = createGraph();
  const n = addNode(g, 'tex/perlin');
  const registry = buildRegistry([]);
  const types = createCoreTypeRegistry();
  assert.throws(
    () => assertConnectIsValid(g, registry, types, { node: n.id, socket: 'texture' }, { node: n.id, socket: 'gain' }),
    (e) => e instanceof GraphValidationError && e.code === 'self_loop',
  );
});

test('assertValueShapeForType: Float input rejects a string', () => {
  assert.throws(() => assertValueShapeForType('Float', 'hello'), (e) =>
    e instanceof GraphValidationError && e.code === 'type_mismatch',
  );
});

test('assertValueShapeForType: Vec3 input rejects a length-2 array', () => {
  assert.throws(() => assertValueShapeForType('Vec3', [1, 2]), (e) =>
    e instanceof GraphValidationError && e.code === 'type_mismatch',
  );
});

test('assertValueShapeForType: undefined ("clear override") is allowed for any type', () => {
  // This is the "reset to default" path — must always succeed
  // regardless of socket type.
  assert.doesNotThrow(() => assertValueShapeForType('Vec3', undefined));
  assert.doesNotThrow(() => assertValueShapeForType('Float', undefined));
});

// -----------------------------------------------------------------
// Store-action throws
// -----------------------------------------------------------------

function seedGraph(): { aId: string; bId: string } {
  const g = createGraph();
  const a = addNode(g, 'tex/perlin', { id: 'A' });
  const b = addNode(g, 'tex/perlin', { id: 'B' });
  useEditorStore.setState({
    mainGraph: g,
    graph: g,
    rootNodeId: '__root__',
    currentEditingId: 'main',
    subgraphs: [],
    folders: [],
    undoStack: [],
    redoStack: [],
    nodePositions: { main: {} },
  });
  return { aId: a.id, bId: b.id };
}

test('store.addNode throws on duplicate id', () => {
  seedGraph();
  assert.throws(
    () => useEditorStore.getState().addNode({ id: 'A', kind: 'tex/perlin' }),
    (e) => e instanceof GraphValidationError && e.code === 'duplicate_node_id',
  );
});

test('store.addNode throws on unknown kind', () => {
  seedGraph();
  assert.throws(
    () => useEditorStore.getState().addNode({ id: 'fresh', kind: 'core/not-real' }),
    (e) => e instanceof GraphValidationError && e.code === 'unknown_kind',
  );
});

test('store.connect throws when source node does not exist', () => {
  const { bId } = seedGraph();
  assert.throws(
    () => useEditorStore.getState().connect('e1', { node: 'GHOST', socket: 'texture' }, { node: bId, socket: 'gain' }),
    (e) => e instanceof GraphValidationError && e.code === 'node_not_found',
  );
});

test('store.connect throws when output socket does not exist', () => {
  const { aId, bId } = seedGraph();
  assert.throws(
    () => useEditorStore.getState().connect('e1', { node: aId, socket: 'nope' }, { node: bId, socket: 'gain' }),
    (e) => e instanceof GraphValidationError && e.code === 'socket_not_found',
  );
});

test('store.connect throws on type mismatch (Texture2D output → Float input)', () => {
  // perlin.value is Texture2D. perlin.gain is Float. There is no
  // Texture2D → Float conversion, so the connect must reject.
  const { aId, bId } = seedGraph();
  assert.throws(
    () => useEditorStore.getState().connect('e1', { node: aId, socket: 'texture' }, { node: bId, socket: 'gain' }),
    (e) => e instanceof GraphValidationError && e.code === 'type_mismatch',
  );
});

test('store.connect throws on self-loop', () => {
  const { aId } = seedGraph();
  assert.throws(
    () => useEditorStore.getState().connect('e1', { node: aId, socket: 'texture' }, { node: aId, socket: 'gain' }),
    (e) => e instanceof GraphValidationError && e.code === 'self_loop',
  );
});

test('store.setInputValue throws on unknown node', () => {
  seedGraph();
  assert.throws(
    () => useEditorStore.getState().setInputValue('GHOST', 'gain', 0.5),
    (e) => e instanceof GraphValidationError && e.code === 'node_not_found',
  );
});

test('store.setInputValue throws on unknown socket', () => {
  const { aId } = seedGraph();
  assert.throws(
    () => useEditorStore.getState().setInputValue(aId, 'no-such-socket', 0.5),
    (e) => e instanceof GraphValidationError && e.code === 'socket_not_found',
  );
});

test('store.setInputValue throws on value-shape mismatch (string into Float)', () => {
  const { aId } = seedGraph();
  assert.throws(
    () => useEditorStore.getState().setInputValue(aId, 'gain', 'wrong'),
    (e) => e instanceof GraphValidationError && e.code === 'type_mismatch',
  );
});

// -----------------------------------------------------------------
// MCP wrapping — each mutation returns { ok: false, error } on bad input
// -----------------------------------------------------------------

function buildTools(): SedonTool[] {
  return buildSedonTools({
    getState: () => useEditorStore.getState(),
    getRegistry: () => buildRegistry(useEditorStore.getState().subgraphs),
    getActions: () => [],
  });
}

function tool(name: string): SedonTool {
  const t = buildTools().find((x) => x.name === name);
  if (!t) throw new Error(`no tool: ${name}`);
  return t;
}

test('MCP addNode: duplicate id returns { ok: false, error.code: "duplicate_node_id" }', () => {
  seedGraph();
  const res = tool('addNode').handler({ kind: 'tex/perlin', id: 'A' }) as { ok?: false; error?: { code: string } };
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, 'duplicate_node_id');
});

test('MCP connect: type mismatch returns structured error, no edge added', () => {
  const { aId, bId } = seedGraph();
  const beforeEdges = useEditorStore.getState().graph.edges.length;
  const res = tool('connect').handler({
    from: { node: aId, socket: 'texture' },
    to: { node: bId, socket: 'gain' },
  }) as { ok?: false; error?: { code: string } };
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, 'type_mismatch');
  assert.equal(useEditorStore.getState().graph.edges.length, beforeEdges, 'no edge added on rejection');
});

test('MCP setInputValue: unknown socket returns structured error', () => {
  const { aId } = seedGraph();
  const res = tool('setInputValue').handler({
    nodeId: aId,
    name: 'no-such-socket',
    value: 1,
  }) as { ok?: false; error?: { code: string } };
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, 'socket_not_found');
});

test('MCP setInputValue: valid call returns the existing success shape unchanged', () => {
  // Catching validation must not change the shape of successful
  // returns — setInputValue returns { ok: true } on success today,
  // and code paths that already check for that must still work.
  const { aId } = seedGraph();
  const res = tool('setInputValue').handler({
    nodeId: aId,
    name: 'gain',
    value: 0.75,
  }) as { ok: boolean };
  assert.equal(res.ok, true);
});
