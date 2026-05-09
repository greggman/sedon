import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import { evaluateGraph, topologicalOrder } from '../../src/core/evaluate.js';
import { createCoreNodeRegistry } from '../../src/nodes/index.js';

function approxEqual(a: number[], b: number[], eps = 1e-6) {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i]! - b[i]!) < eps, `index ${i}: ${a[i]} vs ${b[i]}`);
  }
}

test('color node emits its constant', () => {
  const nodes = createCoreNodeRegistry();
  const g = createGraph();
  const c = addNode(g, 'core/color', { inputValues: { value: [0.5, 0.25, 0.75, 1] } });

  const result = evaluateGraph(g, nodes, { rootNodeId: c.id });
  approxEqual(result.outputs.color as number[], [0.5, 0.25, 0.75, 1]);
});

test('mix of red and blue with factor 0.5 produces purple', () => {
  const nodes = createCoreNodeRegistry();
  const g = createGraph();
  const red = addNode(g, 'core/color', { inputValues: { value: [1, 0, 0, 1] } });
  const blue = addNode(g, 'core/color', { inputValues: { value: [0, 0, 1, 1] } });
  const mix = addNode(g, 'core/mix');
  addEdge(g, { node: red.id, socket: 'color' }, { node: mix.id, socket: 'a' });
  addEdge(g, { node: blue.id, socket: 'color' }, { node: mix.id, socket: 'b' });

  const result = evaluateGraph(g, nodes, { rootNodeId: mix.id });
  approxEqual(result.outputs.result as number[], [0.5, 0, 0.5, 1]);
});

test('input default fills in when nothing else is provided', () => {
  const nodes = createCoreNodeRegistry();
  const g = createGraph();
  const mix = addNode(g, 'core/mix');

  const result = evaluateGraph(g, nodes, { rootNodeId: mix.id });
  // a default [0,0,0,1], b default [1,1,1,1], factor default 0.5 → [0.5, 0.5, 0.5, 1]
  approxEqual(result.outputs.result as number[], [0.5, 0.5, 0.5, 1]);
});

test('inputValues override defaults but yield to edges', () => {
  const nodes = createCoreNodeRegistry();
  const g = createGraph();
  const red = addNode(g, 'core/color', { inputValues: { value: [1, 0, 0, 1] } });
  // factor inputValue = 1 → should pick b entirely.
  const mix = addNode(g, 'core/mix', { inputValues: { factor: 1 } });
  addEdge(g, { node: red.id, socket: 'color' }, { node: mix.id, socket: 'a' });

  const result = evaluateGraph(g, nodes, { rootNodeId: mix.id });
  // a from edge = red, b default white, factor = 1 → white
  approxEqual(result.outputs.result as number[], [1, 1, 1, 1]);
});

test('topological order processes upstream before downstream', () => {
  const g = createGraph();
  const a = addNode(g, 'core/color');
  const b = addNode(g, 'core/color');
  const mix = addNode(g, 'core/mix');
  addEdge(g, { node: a.id, socket: 'color' }, { node: mix.id, socket: 'a' });
  addEdge(g, { node: b.id, socket: 'color' }, { node: mix.id, socket: 'b' });

  const order = topologicalOrder(g, mix.id);
  assert.ok(order.indexOf(a.id) < order.indexOf(mix.id));
  assert.ok(order.indexOf(b.id) < order.indexOf(mix.id));
  assert.equal(order[order.length - 1], mix.id);
});

test('cycles are rejected', () => {
  const g = createGraph();
  const m1 = addNode(g, 'core/mix');
  const m2 = addNode(g, 'core/mix');
  addEdge(g, { node: m1.id, socket: 'result' }, { node: m2.id, socket: 'a' });
  addEdge(g, { node: m2.id, socket: 'result' }, { node: m1.id, socket: 'a' });

  assert.throws(() => topologicalOrder(g, m2.id), /cycle/);
});

test('all reachable nodes are evaluated, with the root extracted as outputs', () => {
  const nodes = createCoreNodeRegistry();
  const g = createGraph();
  const red = addNode(g, 'core/color', { inputValues: { value: [1, 0, 0, 1] } });
  const blue = addNode(g, 'core/color', { inputValues: { value: [0, 0, 1, 1] } });
  // blue is in the graph but not connected to red — and yet it should be
  // evaluated, so the editor can show a preview on the disconnected node.

  const result = evaluateGraph(g, nodes, { rootNodeId: red.id });
  assert.ok(result.allOutputs.has(red.id));
  assert.ok(result.allOutputs.has(blue.id));
  approxEqual(result.outputs.color as number[], [1, 0, 0, 1]);
});

test('a node with required-but-missing inputs is skipped, not fatal', () => {
  const nodes = createCoreNodeRegistry();
  const g = createGraph();
  const red = addNode(g, 'core/color', { inputValues: { value: [1, 0, 0, 1] } });
  // core/material has a required Texture2D input (basecolor). Leaving it
  // unconnected used to throw; now we skip it and let the rest evaluate.
  const orphan = addNode(g, 'core/material');

  const result = evaluateGraph(g, nodes, { rootNodeId: red.id });
  assert.ok(result.allOutputs.has(red.id));
  assert.ok(!result.allOutputs.has(orphan.id));
});
