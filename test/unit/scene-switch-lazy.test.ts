// Regression: scene/switch must be LAZY — its `scenes` input is
// marked `lazy: true`, so unselected branches never run. Without
// laziness an outer for-each loop with N variants per iteration
// would multiply real GPU work by N — see InputDef.lazy.
//
// We exercise the evaluator's lazy machinery directly: a counter
// node sits upstream of each branch and bumps a global tally on
// every evaluate() call. After running the switch once, the picked
// branch's tally is 1 and the unselected branches' tallies are 0.
// Re-running with a different index flips which counter advances.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import { evaluateGraph } from '../../src/core/evaluate.js';
import { createNodeRegistry, type NodeDef } from '../../src/core/node-def.js';
import { sceneSwitchNode } from '../../src/nodes/scene-switch.js';
import type { SceneValue } from '../../src/core/resources.js';

function makeCounterNode(): { def: NodeDef; getCount: (id: string) => number; reset: () => void } {
  const counts = new Map<string, number>();
  const def: NodeDef = {
    id: 'test/scene-counter',
    category: 'Test',
    inputs: [
      { name: 'tag', type: 'Float', default: 0 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    evaluate(ctx, _inputs): { scene: SceneValue } {
      const id = ctx.nodeId ?? 'unknown';
      counts.set(id, (counts.get(id) ?? 0) + 1);
      return { scene: { entities: [] } };
    },
  };
  return {
    def,
    getCount: (id) => counts.get(id) ?? 0,
    reset: () => counts.clear(),
  };
}

function makeOutputNode(): NodeDef {
  // Sink: forwards the scene downstream so the switch isn't the root
  // (we want to exercise the case where the switch is NOT the root
  // node — a realistic city graph has the switch buried inside).
  return {
    id: 'test/scene-sink',
    category: 'Test',
    inputs: [{ name: 'scene', type: 'Scene' }],
    outputs: [{ name: 'scene', type: 'Scene' }],
    evaluate(_ctx, inputs): { scene: SceneValue } {
      return { scene: (inputs.scene as SceneValue) ?? { entities: [] } };
    },
  };
}

test('scene/switch: only the picked branch evaluates', async () => {
  const counter = makeCounterNode();
  const registry = createNodeRegistry();
  registry.register(counter.def);
  registry.register(makeOutputNode());
  registry.register(sceneSwitchNode);

  const g = createGraph();
  const c0 = addNode(g, 'test/scene-counter', { id: 'c0' });
  const c1 = addNode(g, 'test/scene-counter', { id: 'c1' });
  const c2 = addNode(g, 'test/scene-counter', { id: 'c2' });
  const sw = addNode(g, 'scene/switch', { id: 'sw', inputValues: { index: 1 } });
  const sink = addNode(g, 'test/scene-sink', { id: 'sink' });
  addEdge(g, { node: c0.id, socket: 'scene' }, { node: sw.id, socket: 'scenes' });
  addEdge(g, { node: c1.id, socket: 'scene' }, { node: sw.id, socket: 'scenes' });
  addEdge(g, { node: c2.id, socket: 'scene' }, { node: sw.id, socket: 'scenes' });
  addEdge(g, { node: sw.id, socket: 'scene' }, { node: sink.id, socket: 'scene' });

  const result = await evaluateGraph(g, registry, {
    rootNodeId: sink.id,
    scope: 'rootAncestors',
  });

  assert.equal(counter.getCount('c0'), 0, 'branch 0 was not picked, must not have evaluated');
  assert.equal(counter.getCount('c1'), 1, 'branch 1 IS picked → exactly one eval');
  assert.equal(counter.getCount('c2'), 0, 'branch 2 was not picked, must not have evaluated');

  const sinkScene = result.outputs.scene as SceneValue | undefined;
  assert.ok(sinkScene, 'sink should still produce a scene');
});

test('scene/switch: changing index re-routes work to the new branch', async () => {
  const counter = makeCounterNode();
  const registry = createNodeRegistry();
  registry.register(counter.def);
  registry.register(makeOutputNode());
  registry.register(sceneSwitchNode);

  const g = createGraph();
  const c0 = addNode(g, 'test/scene-counter', { id: 'c0' });
  const c1 = addNode(g, 'test/scene-counter', { id: 'c1' });
  const sw = addNode(g, 'scene/switch', { id: 'sw', inputValues: { index: 0 } });
  const sink = addNode(g, 'test/scene-sink', { id: 'sink' });
  addEdge(g, { node: c0.id, socket: 'scene' }, { node: sw.id, socket: 'scenes' });
  addEdge(g, { node: c1.id, socket: 'scene' }, { node: sw.id, socket: 'scenes' });
  addEdge(g, { node: sw.id, socket: 'scene' }, { node: sink.id, socket: 'scene' });

  await evaluateGraph(g, registry, { rootNodeId: sink.id, scope: 'rootAncestors' });
  assert.equal(counter.getCount('c0'), 1);
  assert.equal(counter.getCount('c1'), 0);

  // Move the picker. Reset counters first so the second run's count
  // reflects ONLY the second eval.
  counter.reset();
  sw.inputValues = { ...sw.inputValues, index: 1 };
  await evaluateGraph(g, registry, { rootNodeId: sink.id, scope: 'rootAncestors' });
  assert.equal(counter.getCount('c0'), 0, 'index switched away → branch 0 idle');
  assert.equal(counter.getCount('c1'), 1, 'index switched to 1 → branch 1 ran');
});

test('scene/switch: with no wired branches, returns empty scene cleanly', async () => {
  const registry = createNodeRegistry();
  registry.register(sceneSwitchNode);

  const g = createGraph();
  const sw = addNode(g, 'scene/switch', { id: 'sw', inputValues: { index: 0 } });
  const result = await evaluateGraph(g, registry, {
    rootNodeId: sw.id,
    scope: 'rootAncestors',
  });
  const scene = result.outputs.scene as SceneValue;
  assert.deepEqual(scene.entities, []);
});

test('scene/switch: negative indices wrap modulo the wired count', async () => {
  // JS `%` keeps the dividend's sign — the switch's `((i % n) + n) % n`
  // normalises that. With 3 branches and index = -1, the picked branch
  // is 2 (the LAST one).
  const counter = makeCounterNode();
  const registry = createNodeRegistry();
  registry.register(counter.def);
  registry.register(sceneSwitchNode);

  const g = createGraph();
  const c0 = addNode(g, 'test/scene-counter', { id: 'c0' });
  const c1 = addNode(g, 'test/scene-counter', { id: 'c1' });
  const c2 = addNode(g, 'test/scene-counter', { id: 'c2' });
  const sw = addNode(g, 'scene/switch', { id: 'sw', inputValues: { index: -1 } });
  addEdge(g, { node: c0.id, socket: 'scene' }, { node: sw.id, socket: 'scenes' });
  addEdge(g, { node: c1.id, socket: 'scene' }, { node: sw.id, socket: 'scenes' });
  addEdge(g, { node: c2.id, socket: 'scene' }, { node: sw.id, socket: 'scenes' });

  await evaluateGraph(g, registry, { rootNodeId: sw.id, scope: 'rootAncestors' });

  assert.equal(counter.getCount('c0'), 0);
  assert.equal(counter.getCount('c1'), 0);
  assert.equal(counter.getCount('c2'), 1, 'index -1 wraps to last branch (2)');
});
