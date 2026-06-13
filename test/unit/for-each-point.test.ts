// iter/for-each-point evaluates a bridge subgraph once per point in
// the wired PointCloud, threading per-iteration context through
// `ctx.iterationContext` and merging / lifting per-iteration outputs.
//
// These tests bypass the full bridge-creation machinery and instead
// register a SYNTHETIC `bridge-eval/<id>` NodeDef that captures
// ctx + inputs each call. That isolates the for-each-point's own
// iteration / accumulation / lifting logic without dragging in the
// real subgraph-boundary infrastructure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNode, createGraph } from '../../src/core/graph.js';
import { evaluateGraph } from '../../src/core/evaluate.js';
import {
  createNodeRegistry,
  type NodeContext,
  type NodeDef,
  type NodeInputs,
  type NodeOutputs,
  type NodeRegistry,
} from '../../src/core/node-def.js';
import { forEachPointNode } from '../../src/nodes/for-each-point.js';
import type { PointCloudValue, SceneValue } from '../../src/core/resources.js';

interface CallRecord {
  inputs: NodeInputs;
  iterationContext: NodeInputs | undefined;
}

function makeBridge(opts: {
  bridgeId: string;
  bridgeInputs?: NodeDef['inputs'];
  bridgeOutputs?: NodeDef['outputs'];
  evaluate: (ctx: NodeContext, inputs: NodeInputs, call: CallRecord) => NodeOutputs;
  calls: CallRecord[];
}): NodeDef {
  return {
    id: `bridge-eval/${opts.bridgeId}`,
    category: '__internal__',
    inputs: opts.bridgeInputs ?? [],
    outputs: opts.bridgeOutputs ?? [{ name: 'scene', type: 'Scene' }],
    evaluate(ctx, inputs): NodeOutputs {
      const rec: CallRecord = {
        inputs: { ...inputs },
        iterationContext: ctx.iterationContext ? { ...ctx.iterationContext } : undefined,
      };
      opts.calls.push(rec);
      return opts.evaluate(ctx, inputs, rec);
    },
  };
}

function makeRegistry(bridge: NodeDef): NodeRegistry {
  const r = createNodeRegistry();
  r.register(forEachPointNode);
  r.register(bridge);
  return r;
}

function makePointCloud(points: [number, number, number][]): PointCloudValue {
  const positions = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    positions[i * 3] = points[i]![0];
    positions[i * 3 + 1] = points[i]![1];
    positions[i * 3 + 2] = points[i]![2];
  }
  return { positions, count: points.length };
}

test('for-each-point: empty points → empty scene, bridge never called', async () => {
  const calls: CallRecord[] = [];
  const bridge = makeBridge({
    bridgeId: 'b',
    calls,
    evaluate: () => ({ scene: { entities: [] } as SceneValue }),
  });
  const reg = makeRegistry(bridge);
  const g = createGraph();
  const pts = addNode(g, 'iter/for-each-point', {
    inputValues: { points: makePointCloud([]), __bridgeId: 'b' },
  });
  const result = await evaluateGraph(g, reg, { rootNodeId: pts.id });
  const scene = result.outputs.scene as SceneValue;
  assert.equal(scene.entities.length, 0);
  assert.equal(calls.length, 0);
});

test('for-each-point: missing __bridgeId → empty scene', async () => {
  const calls: CallRecord[] = [];
  const bridge = makeBridge({
    bridgeId: 'b',
    calls,
    evaluate: () => ({ scene: { entities: [] } as SceneValue }),
  });
  const reg = makeRegistry(bridge);
  const g = createGraph();
  const pts = addNode(g, 'iter/for-each-point', {
    inputValues: { points: makePointCloud([[0, 0, 0]]), __bridgeId: '' },
  });
  const result = await evaluateGraph(g, reg, { rootNodeId: pts.id });
  assert.equal((result.outputs.scene as SceneValue).entities.length, 0);
  assert.equal(calls.length, 0);
});

test('for-each-point: unknown bridge id → empty scene (no throw)', async () => {
  const calls: CallRecord[] = [];
  const bridge = makeBridge({
    bridgeId: 'b',
    calls,
    evaluate: () => ({ scene: { entities: [] } as SceneValue }),
  });
  const reg = makeRegistry(bridge);
  const g = createGraph();
  const pts = addNode(g, 'iter/for-each-point', {
    inputValues: { points: makePointCloud([[0, 0, 0]]), __bridgeId: 'does-not-exist' },
  });
  const result = await evaluateGraph(g, reg, { rootNodeId: pts.id });
  assert.equal((result.outputs.scene as SceneValue).entities.length, 0);
  assert.equal(calls.length, 0);
});

test('for-each-point: invokes bridge once per point with position + index in iterationContext', async () => {
  const calls: CallRecord[] = [];
  const bridge = makeBridge({
    bridgeId: 'b',
    calls,
    evaluate: () => ({ scene: { entities: [{} as never] } as SceneValue }),
  });
  const reg = makeRegistry(bridge);
  const g = createGraph();
  const points = makePointCloud([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  const pts = addNode(g, 'iter/for-each-point', {
    inputValues: { points, __bridgeId: 'b' },
  });
  const result = await evaluateGraph(g, reg, { rootNodeId: pts.id });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]!.iterationContext?.position, [1, 2, 3]);
  assert.equal(calls[0]!.iterationContext?.index, 0);
  assert.deepEqual(calls[1]!.iterationContext?.position, [4, 5, 6]);
  assert.equal(calls[1]!.iterationContext?.index, 1);
  assert.deepEqual(calls[2]!.iterationContext?.position, [7, 8, 9]);
  assert.equal(calls[2]!.iterationContext?.index, 2);
  assert.equal((result.outputs.scene as SceneValue).entities.length, 3);
});

test('for-each-point: Float broadcast — same value every iteration', async () => {
  const calls: CallRecord[] = [];
  const bridge = makeBridge({
    bridgeId: 'b',
    bridgeInputs: [{ name: 'size', type: 'Float' }],
    calls,
    evaluate: () => ({ scene: { entities: [] } as SceneValue }),
  });
  const reg = makeRegistry(bridge);
  const g = createGraph();
  const pts = addNode(g, 'iter/for-each-point', {
    extraInputs: [{ name: 'size', type: 'FloatCloud', optional: true }],
    inputValues: {
      points: makePointCloud([[0, 0, 0], [1, 0, 0]]),
      __bridgeId: 'b',
      size: 1.5,
    },
  });
  await evaluateGraph(g, reg, { rootNodeId: pts.id });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.inputs.size, 1.5);
  assert.equal(calls[1]!.inputs.size, 1.5);
});

test('for-each-point: FloatCloud derefs per iteration', async () => {
  const calls: CallRecord[] = [];
  const bridge = makeBridge({
    bridgeId: 'b',
    bridgeInputs: [{ name: 'size', type: 'Float' }],
    calls,
    evaluate: () => ({ scene: { entities: [] } as SceneValue }),
  });
  const reg = makeRegistry(bridge);
  const g = createGraph();
  const sizes = { count: 3, values: new Float32Array([10, 20, 30]) };
  const pts = addNode(g, 'iter/for-each-point', {
    extraInputs: [{ name: 'size', type: 'FloatCloud', optional: true }],
    inputValues: {
      points: makePointCloud([[0, 0, 0], [1, 0, 0], [2, 0, 0]]),
      __bridgeId: 'b',
      size: sizes,
    },
  });
  await evaluateGraph(g, reg, { rootNodeId: pts.id });
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.inputs.size, 10);
  assert.equal(calls[1]!.inputs.size, 20);
  assert.equal(calls[2]!.inputs.size, 30);
});

test('for-each-point: Vec3Cloud derefs per iteration', async () => {
  const calls: CallRecord[] = [];
  const bridge = makeBridge({
    bridgeId: 'b',
    bridgeInputs: [{ name: 'colour', type: 'Vec3' }],
    calls,
    evaluate: () => ({ scene: { entities: [] } as SceneValue }),
  });
  const reg = makeRegistry(bridge);
  const g = createGraph();
  const colours = { count: 2, values: new Float32Array([1, 0, 0, 0, 1, 0]) };
  const pts = addNode(g, 'iter/for-each-point', {
    extraInputs: [{ name: 'colour', type: 'Vec3Cloud', optional: true }],
    inputValues: {
      points: makePointCloud([[0, 0, 0], [1, 0, 0]]),
      __bridgeId: 'b',
      colour: colours,
    },
  });
  await evaluateGraph(g, reg, { rootNodeId: pts.id });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.inputs.colour, [1, 0, 0]);
  assert.deepEqual(calls[1]!.inputs.colour, [0, 1, 0]);
});

test('for-each-point: unwired broadcast input falls back to bridge\'s declared default', async () => {
  const calls: CallRecord[] = [];
  const bridge = makeBridge({
    bridgeId: 'b',
    bridgeInputs: [{ name: 'size', type: 'Float', default: 7.0 }],
    calls,
    evaluate: () => ({ scene: { entities: [] } as SceneValue }),
  });
  const reg = makeRegistry(bridge);
  const g = createGraph();
  const pts = addNode(g, 'iter/for-each-point', {
    inputValues: { points: makePointCloud([[0, 0, 0]]), __bridgeId: 'b' },
  });
  await evaluateGraph(g, reg, { rootNodeId: pts.id });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.inputs.size, 7.0);
});

test('for-each-point: lifts Float output into FloatCloud', async () => {
  const calls: CallRecord[] = [];
  const bridge = makeBridge({
    bridgeId: 'b',
    bridgeOutputs: [{ name: 'area', type: 'Float' }],
    calls,
    evaluate(_ctx, _inputs, call) {
      const i = call.iterationContext?.index as number;
      return { area: i * 10 };
    },
  });
  const reg = makeRegistry(bridge);
  const g = createGraph();
  const pts = addNode(g, 'iter/for-each-point', {
    extraOutputs: [{ name: 'area', type: 'FloatCloud' }],
    inputValues: { points: makePointCloud([[0, 0, 0], [1, 0, 0], [2, 0, 0]]), __bridgeId: 'b' },
  });
  const result = await evaluateGraph(g, reg, { rootNodeId: pts.id });
  const area = result.outputs.area as { count: number; values: Float32Array };
  assert.equal(area.count, 3);
  assert.deepEqual(Array.from(area.values), [0, 10, 20]);
});

test('for-each-point: lifts Vec3 output into Vec3Cloud', async () => {
  const calls: CallRecord[] = [];
  const bridge = makeBridge({
    bridgeId: 'b',
    bridgeOutputs: [{ name: 'colour', type: 'Vec3' }],
    calls,
    evaluate(_ctx, _inputs, call) {
      const i = call.iterationContext?.index as number;
      return { colour: [i, i + 1, i + 2] };
    },
  });
  const reg = makeRegistry(bridge);
  const g = createGraph();
  const pts = addNode(g, 'iter/for-each-point', {
    extraOutputs: [{ name: 'colour', type: 'Vec3Cloud' }],
    inputValues: { points: makePointCloud([[0, 0, 0], [1, 0, 0]]), __bridgeId: 'b' },
  });
  const result = await evaluateGraph(g, reg, { rootNodeId: pts.id });
  const colour = result.outputs.colour as { count: number; values: Float32Array };
  assert.equal(colour.count, 2);
  assert.deepEqual(Array.from(colour.values), [0, 1, 2, 1, 2, 3]);
});

test('for-each-point: multiple bridge outputs lift independently', async () => {
  const calls: CallRecord[] = [];
  const bridge = makeBridge({
    bridgeId: 'b',
    bridgeOutputs: [
      { name: 'scene', type: 'Scene' },
      { name: 'area', type: 'Float' },
    ],
    calls,
    evaluate(_ctx, _inputs, call) {
      const i = call.iterationContext?.index as number;
      return {
        scene: { entities: [{ marker: i } as unknown as never] } as SceneValue,
        area: i + 1,
      };
    },
  });
  const reg = makeRegistry(bridge);
  const g = createGraph();
  const pts = addNode(g, 'iter/for-each-point', {
    extraOutputs: [
      { name: 'scene', type: 'Scene' },
      { name: 'area', type: 'FloatCloud' },
    ],
    inputValues: { points: makePointCloud([[0, 0, 0], [1, 0, 0], [2, 0, 0]]), __bridgeId: 'b' },
  });
  const result = await evaluateGraph(g, reg, { rootNodeId: pts.id });
  const scene = result.outputs.scene as SceneValue;
  assert.equal(scene.entities.length, 3);
  const area = result.outputs.area as { count: number; values: Float32Array };
  assert.equal(area.count, 3);
  assert.deepEqual(Array.from(area.values), [1, 2, 3]);
});

// Regression: per-iteration trackerKey scoping. The fast-path
// (anim affectedSet) reads each node's `lastFingerprintByNodeId`
// entry. Before iteration scoping was added to the tracker key,
// every iteration's `set(trackerKey, fp)` overwrote the previous
// iteration's — so a subsequent affectedSet-driven eval (the
// per-anim-frame re-eval) returned the LAST iteration's cached
// output for every iteration. Visible bug: animating an iter
// body stacked every lot's buildings at the last lot's position
// ("90% of buildings disappear on play"). This test repeats the
// eval twice with an affectedSet that lists ONLY the iter node
// itself (so its body's per-iter nodes go through the fast-path)
// and asserts every iteration's bridge call still gets its own
// per-iteration index — i.e. the fast-path returns iter-K's
// output for iter K, not iter-LAST for every iter.
test('per-iteration trackerKey scoping: affectedSet fast-path does not collapse all iters to the last iter', async () => {
  const calls: CallRecord[] = [];
  const bridge = makeBridge({
    bridgeId: 'b',
    bridgeOutputs: [{ name: 'index', type: 'Float' }],
    calls,
    evaluate(_ctx, _inputs, call) {
      const i = call.iterationContext?.index as number;
      return { index: i };
    },
  });
  const reg = makeRegistry(bridge);
  const g = createGraph();
  const pts = addNode(g, 'iter/for-each-point', {
    extraOutputs: [{ name: 'index', type: 'FloatCloud' }],
    inputValues: { points: makePointCloud([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]]), __bridgeId: 'b' },
  });
  // First eval populates cache.
  const cache = (await import('../../src/core/eval-cache.js')).createEvalCache();
  const r1 = await evaluateGraph(g, reg, { rootNodeId: pts.id, cache });
  const c1 = r1.outputs.index as { count: number; values: Float32Array };
  assert.deepEqual(Array.from(c1.values), [0, 1, 2, 3]);

  // Second eval with affectedSet listing only the iter node — its
  // bridge body's per-iter intermediate nodes (if any) would go
  // through the fast-path. We don't have intermediates here, so
  // bridge.evaluate runs each iter anyway. The point of this test
  // is the cache integrity around iteration trackerKeys: a re-run
  // with the same cache should still emit per-iteration outputs.
  const r2 = await evaluateGraph(g, reg, {
    rootNodeId: pts.id,
    cache,
    affectedSet: new Set([pts.id]),
  });
  const c2 = r2.outputs.index as { count: number; values: Float32Array };
  assert.deepEqual(
    Array.from(c2.values),
    [0, 1, 2, 3],
    'every iteration must keep its own index — not all 4 of [3, 3, 3, 3]',
  );
});
