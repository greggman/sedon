import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addEdge,
  addNode,
  createGraph,
  fromJSON,
  removeNode,
  toJSON,
  validateGraph,
} from '../../src/core/graph.js';
import { createCoreTypeRegistry } from '../../src/core/types.js';
import { createCoreNodeRegistry } from '../../src/nodes/index.js';

test('graph round-trips through JSON', () => {
  const g = createGraph();
  const a = addNode(g, 'core/color', { inputValues: { value: [1, 0, 0, 1] } });
  const b = addNode(g, 'core/color', { inputValues: { value: [0, 0, 1, 1] } });
  const mix = addNode(g, 'core/mix');
  addEdge(g, { node: a.id, socket: 'color' }, { node: mix.id, socket: 'a' });
  addEdge(g, { node: b.id, socket: 'color' }, { node: mix.id, socket: 'b' });

  const restored = fromJSON(toJSON(g));
  assert.equal(restored.version, 1);
  assert.equal(restored.nodes.length, 3);
  assert.equal(restored.edges.length, 2);
  assert.deepEqual(restored.nodes[0]?.inputValues, { value: [1, 0, 0, 1] });
});

test('fromJSON rejects wrong version', () => {
  assert.throws(() => fromJSON('{"version":99,"nodes":[],"edges":[]}'), /version/);
});

test('removeNode also removes connected edges', () => {
  const g = createGraph();
  const a = addNode(g, 'core/color');
  const b = addNode(g, 'core/color');
  const mix = addNode(g, 'core/mix');
  addEdge(g, { node: a.id, socket: 'color' }, { node: mix.id, socket: 'a' });
  addEdge(g, { node: b.id, socket: 'color' }, { node: mix.id, socket: 'b' });

  removeNode(g, mix.id);
  assert.equal(g.nodes.length, 2);
  assert.equal(g.edges.length, 0);
});

test('validation accepts a well-formed graph', () => {
  const types = createCoreTypeRegistry();
  const nodes = createCoreNodeRegistry();
  const g = createGraph();
  const a = addNode(g, 'core/color');
  const mix = addNode(g, 'core/mix');
  addEdge(g, { node: a.id, socket: 'color' }, { node: mix.id, socket: 'a' });

  const result = validateGraph(g, types, nodes);
  assert.ok(result.ok, JSON.stringify(result.issues));
});

test('validation rejects unknown node kinds', () => {
  const types = createCoreTypeRegistry();
  const nodes = createCoreNodeRegistry();
  const g = createGraph();
  addNode(g, 'core/does-not-exist');

  const result = validateGraph(g, types, nodes);
  assert.ok(!result.ok);
  assert.match(result.issues[0]!.message, /unknown node kind/);
});

test('validation rejects type-incompatible edges', () => {
  const types = createCoreTypeRegistry();
  const nodes = createCoreNodeRegistry();
  const g = createGraph();
  const a = addNode(g, 'core/color');
  const mix = addNode(g, 'core/mix');
  // 'color' (Color) -> 'factor' (Float) is not allowed.
  addEdge(g, { node: a.id, socket: 'color' }, { node: mix.id, socket: 'factor' });

  const result = validateGraph(g, types, nodes);
  assert.ok(!result.ok);
  assert.ok(result.issues.some((i) => /incompatible/.test(i.message)));
});

test('validation rejects edges referencing missing sockets', () => {
  const types = createCoreTypeRegistry();
  const nodes = createCoreNodeRegistry();
  const g = createGraph();
  const a = addNode(g, 'core/color');
  const mix = addNode(g, 'core/mix');
  addEdge(g, { node: a.id, socket: 'no-such-output' }, { node: mix.id, socket: 'a' });

  const result = validateGraph(g, types, nodes);
  assert.ok(!result.ok);
  assert.ok(result.issues.some((i) => /not found/.test(i.message)));
});
