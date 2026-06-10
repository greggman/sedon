import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import { evaluateGraph, topologicalOrder } from '../../src/core/evaluate.js';
import { createRegistryForTests } from './test-nodes.js';

function approxEqual(a: number[], b: number[], eps = 1e-6) {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i]! - b[i]!) < eps, `index ${i}: ${a[i]} vs ${b[i]}`);
  }
}

test('a constant-emitting node returns its inputValue', async () => {
  const nodes = createRegistryForTests();
  const g = createGraph();
  const c = addNode(g, 'test/color-source', {
    inputValues: { value: [0.5, 0.25, 0.75, 1] },
  });

  const result = await evaluateGraph(g, nodes, { rootNodeId: c.id });
  approxEqual(result.outputs.color as number[], [0.5, 0.25, 0.75, 1]);
});

test('mix of red and blue with factor 0.5 produces purple', async () => {
  const nodes = createRegistryForTests();
  const g = createGraph();
  const red = addNode(g, 'test/color-source', { inputValues: { value: [1, 0, 0, 1] } });
  const blue = addNode(g, 'test/color-source', { inputValues: { value: [0, 0, 1, 1] } });
  const mix = addNode(g, 'math/mix');
  addEdge(g, { node: red.id, socket: 'color' }, { node: mix.id, socket: 'a' });
  addEdge(g, { node: blue.id, socket: 'color' }, { node: mix.id, socket: 'b' });

  const result = await evaluateGraph(g, nodes, { rootNodeId: mix.id });
  approxEqual(result.outputs.result as number[], [0.5, 0, 0.5, 1]);
});

test('input default fills in when nothing else is provided', async () => {
  const nodes = createRegistryForTests();
  const g = createGraph();
  const mix = addNode(g, 'math/mix');

  const result = await evaluateGraph(g, nodes, { rootNodeId: mix.id });
  // a default [0,0,0,1], b default [1,1,1,1], factor default 0.5 → [0.5, 0.5, 0.5, 1]
  approxEqual(result.outputs.result as number[], [0.5, 0.5, 0.5, 1]);
});

test('inputValues override defaults but yield to edges', async () => {
  const nodes = createRegistryForTests();
  const g = createGraph();
  const red = addNode(g, 'test/color-source', { inputValues: { value: [1, 0, 0, 1] } });
  // factor inputValue = 1 → should pick b entirely.
  const mix = addNode(g, 'math/mix', { inputValues: { factor: 1 } });
  addEdge(g, { node: red.id, socket: 'color' }, { node: mix.id, socket: 'a' });

  const result = await evaluateGraph(g, nodes, { rootNodeId: mix.id });
  // a from edge = red, b default white, factor = 1 → white
  approxEqual(result.outputs.result as number[], [1, 1, 1, 1]);
});

test('topological order processes upstream before downstream', () => {
  const g = createGraph();
  const a = addNode(g, 'test/color-source');
  const b = addNode(g, 'test/color-source');
  const mix = addNode(g, 'math/mix');
  addEdge(g, { node: a.id, socket: 'color' }, { node: mix.id, socket: 'a' });
  addEdge(g, { node: b.id, socket: 'color' }, { node: mix.id, socket: 'b' });

  const order = topologicalOrder(g, mix.id);
  assert.ok(order.indexOf(a.id) < order.indexOf(mix.id));
  assert.ok(order.indexOf(b.id) < order.indexOf(mix.id));
  assert.equal(order[order.length - 1], mix.id);
});

test('cycles are rejected', () => {
  const g = createGraph();
  const m1 = addNode(g, 'math/mix');
  const m2 = addNode(g, 'math/mix');
  addEdge(g, { node: m1.id, socket: 'result' }, { node: m2.id, socket: 'a' });
  addEdge(g, { node: m2.id, socket: 'result' }, { node: m1.id, socket: 'a' });

  assert.throws(() => topologicalOrder(g, m2.id), /cycle/);
});

test('all reachable nodes are evaluated, with the root extracted as outputs', async () => {
  const nodes = createRegistryForTests();
  const g = createGraph();
  const red = addNode(g, 'test/color-source', { inputValues: { value: [1, 0, 0, 1] } });
  const blue = addNode(g, 'test/color-source', { inputValues: { value: [0, 0, 1, 1] } });
  // blue is in the graph but not connected to red — and yet it should be
  // evaluated, so the editor can show a preview on the disconnected node.

  const result = await evaluateGraph(g, nodes, { rootNodeId: red.id });
  assert.ok(result.allOutputs.has(red.id));
  assert.ok(result.allOutputs.has(blue.id));
  approxEqual(result.outputs.color as number[], [1, 0, 0, 1]);
});

test('a node with required-but-missing inputs is skipped, not fatal', async () => {
  const nodes = createRegistryForTests();
  const g = createGraph();
  const red = addNode(g, 'test/color-source', { inputValues: { value: [1, 0, 0, 1] } });
  // tex/distance-transform has a required Texture2D input with no
  // default. Leaving it unconnected used to throw; now we skip it
  // and let the rest evaluate. (material/pbr used to be the choice
  // here, but its `basecolor` now declares an `[r,g,b,a]` default
  // that evaluate.ts auto-promotes — material no longer skips on a
  // missing basecolor wire.)
  const orphan = addNode(g, 'tex/distance-transform');

  const result = await evaluateGraph(g, nodes, { rootNodeId: red.id });
  assert.ok(result.allOutputs.has(red.id));
  assert.ok(!result.allOutputs.has(orphan.id));
});

test('a broken upstream on an OPTIONAL input is treated as unwired (downstream still evaluates)', async () => {
  // Regression: deleting the Fire Hydrant subgraph wrapper in the
  // city demo used to blank the whole preview. The hydrant scatter
  // lost its required `instance` input and stopped evaluating; the
  // city's scene-merge had that scatter wired to `scene_N` (an
  // OPTIONAL Scene), and the eval used to bail on the merge as soon
  // as it saw an upstream with no output — without consulting
  // `optional`. Fixed by treating a broken upstream the same as an
  // unwired socket: the optional / default / required logic now
  // applies uniformly. This test pins the working-branch case.
  const nodes = createRegistryForTests();
  const g = createGraph();
  const good = addNode(g, 'test/scene-source', { inputValues: { tag: 1 } });
  // distance-transform has a required Texture2D input with no default
  // and no inputValue → can't evaluate.
  const broken = addNode(g, 'tex/distance-transform');
  const merge = addNode(g, 'scene/merge', {
  });
  addEdge(g, { node: good.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  // Wire scene_1 to a node that won't evaluate. The fact that the
  // socket TYPES don't match (broken outputs Texture2D, scene_1
  // expects Scene) is incidental — eval propagates whatever upstream
  // produced, and here upstream produces nothing.
  addEdge(g, { node: broken.id, socket: 'texture' }, { node: merge.id, socket: 'scenes' });

  const result = await evaluateGraph(g, nodes, { rootNodeId: merge.id });
  assert.ok(result.allOutputs.has(merge.id), 'scene-merge must still evaluate when one input is broken');
  const scene = result.outputs.scene as { entities: { tag: number }[] };
  assert.equal(scene.entities.length, 1, 'merged scene contains only the working branch');
  assert.equal(scene.entities[0]!.tag, 1);
});

test('a broken upstream on a REQUIRED input still kills the consumer (when there is no default)', async () => {
  // The flip side of the fix: "broken upstream = treated as unwired"
  // means a required-with-no-default input STILL fails — same
  // behavior as deleting the wire entirely. This pins that we
  // didn't accidentally make required inputs forgiving.
  const nodes = createRegistryForTests();
  const g = createGraph();
  const broken = addNode(g, 'tex/distance-transform');
  // math/mix has a required `factor` Float — but it has a default,
  // so this scenario uses distance-transform itself (no default on
  // `input`).
  const consumer = addNode(g, 'tex/distance-transform');
  // Wire consumer.input to broken.texture. Both fail.
  addEdge(g, { node: broken.id, socket: 'texture' }, { node: consumer.id, socket: 'input' });
  const result = await evaluateGraph(g, nodes, { rootNodeId: consumer.id });
  assert.ok(!result.allOutputs.has(broken.id));
  assert.ok(!result.allOutputs.has(consumer.id));
});
