// core/for-each-point evaluates a body subgraph once per point in
// the wired PointCloud and merges the results into a single Scene.
// The interface contract pins:
//   • empty / missing points / missing body → empty Scene (no throw)
//   • body called N times; each call receives a per-iteration
//     __position from the points cloud and __index = i
//   • Float / Vec3 socket values from cloud inputs are deref'd per
//     iteration; scalar values are broadcast (every iteration gets
//     the same value)
//   • returned scenes' entity arrays concatenate

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNode, createGraph } from '../../src/core/graph.js';
import { evaluateGraph } from '../../src/core/evaluate.js';
import {
  createNodeRegistry,
  type NodeDef,
  type NodeInputs,
  type NodeOutputs,
  type NodeRegistry,
} from '../../src/core/node-def.js';
import { forEachPointNode } from '../../src/nodes/for-each-point.js';
import type { PointCloudValue, SceneValue } from '../../src/core/resources.js';

interface CallRecord {
  inputs: NodeInputs;
}

// Build a fake body NodeDef that records every per-iteration inputs
// object it sees and emits a Scene with one marker entity per call.
// The marker carries the per-iteration `__position` so tests can
// assert the for-each actually fed the right point per call.
function makeBody(opts: {
  bodyKind: string;
  bodyInputs: NodeDef['inputs'];
  calls: CallRecord[];
}): NodeDef {
  return {
    id: opts.bodyKind,
    category: 'Test',
    inputs: opts.bodyInputs,
    outputs: [{ name: 'scene', type: 'Scene' }],
    evaluate(_ctx, inputs): NodeOutputs {
      opts.calls.push({ inputs: { ...inputs } });
      // One entity per iteration, carrying the position so tests can
      // verify the deref. The entity payload is just a marker — for
      // the iteration tests we don't need real geometry / material.
      const position = (inputs.__position as [number, number, number] | undefined) ?? [0, 0, 0];
      const scene: SceneValue = {
        entities: [
          {
            // Cast — the test only cares about the shape carrying
            // through the for-each merge, not its strict typing.
            geometry: { position } as unknown,
          } as unknown as SceneValue['entities'][number],
        ],
      };
      return { scene };
    },
  };
}

function makeRegistry(body: NodeDef): NodeRegistry {
  const r = createNodeRegistry();
  r.register(forEachPointNode);
  r.register(body);
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

test('for-each-point: empty points → empty scene, body never called', async () => {
  const calls: CallRecord[] = [];
  const body = makeBody({ bodyKind: 'subgraph/test-body', bodyInputs: [], calls });
  const reg = makeRegistry(body);

  const g = createGraph();
  const pts = addNode(g, 'core/for-each-point', {
    inputValues: { points: makePointCloud([]), __body: 'subgraph/test-body' },
  });
  const result = await evaluateGraph(g, reg, { rootNodeId: pts.id });
  const scene = result.outputs.scene as SceneValue;
  assert.equal(scene.entities.length, 0);
  assert.equal(calls.length, 0);
});

test('for-each-point: missing body kind → empty scene', async () => {
  const calls: CallRecord[] = [];
  const body = makeBody({ bodyKind: 'subgraph/test-body', bodyInputs: [], calls });
  const reg = makeRegistry(body);

  const g = createGraph();
  const pts = addNode(g, 'core/for-each-point', {
    inputValues: { points: makePointCloud([[0, 0, 0]]), __body: '' }, // empty body
  });
  const result = await evaluateGraph(g, reg, { rootNodeId: pts.id });
  const scene = result.outputs.scene as SceneValue;
  assert.equal(scene.entities.length, 0);
  assert.equal(calls.length, 0);
});

test('for-each-point: unknown body kind → empty scene (no throw)', async () => {
  const calls: CallRecord[] = [];
  const body = makeBody({ bodyKind: 'subgraph/test-body', bodyInputs: [], calls });
  const reg = makeRegistry(body);

  const g = createGraph();
  const pts = addNode(g, 'core/for-each-point', {
    inputValues: { points: makePointCloud([[0, 0, 0]]), __body: 'subgraph/does-not-exist' },
  });
  const result = await evaluateGraph(g, reg, { rootNodeId: pts.id });
  const scene = result.outputs.scene as SceneValue;
  assert.equal(scene.entities.length, 0);
  assert.equal(calls.length, 0);
});

test('for-each-point: invokes body once per point with auto-fed __position and __index', async () => {
  const calls: CallRecord[] = [];
  const body = makeBody({
    bodyKind: 'subgraph/test-body',
    bodyInputs: [
      { name: '__position', type: 'Vec3' },
      { name: '__index', type: 'Int' },
    ],
    calls,
  });
  const reg = makeRegistry(body);

  const g = createGraph();
  const points = makePointCloud([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  const pts = addNode(g, 'core/for-each-point', {
    inputValues: { points, __body: 'subgraph/test-body' },
  });
  const result = await evaluateGraph(g, reg, { rootNodeId: pts.id });

  // 3 calls, one per point.
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]!.inputs.__position, [1, 2, 3]);
  assert.equal(calls[0]!.inputs.__index, 0);
  assert.deepEqual(calls[1]!.inputs.__position, [4, 5, 6]);
  assert.equal(calls[1]!.inputs.__index, 1);
  assert.deepEqual(calls[2]!.inputs.__position, [7, 8, 9]);
  assert.equal(calls[2]!.inputs.__index, 2);

  // 3 entities in the merged scene.
  const scene = result.outputs.scene as SceneValue;
  assert.equal(scene.entities.length, 3);
});

test('for-each-point: scalar broadcast — Float in inputs goes to every iteration unchanged', async () => {
  // The for-each-point's mirrored socket for a body Float input is
  // `FloatCloud`. A plain Float wired into it broadcasts via the
  // `Float → FloatCloud` core conversion. At eval time the value
  // arrives as a number; pickForIteration should pass it through.
  const calls: CallRecord[] = [];
  const body = makeBody({
    bodyKind: 'subgraph/test-body',
    bodyInputs: [{ name: 'size', type: 'Float' }],
    calls,
  });
  const reg = makeRegistry(body);

  const g = createGraph();
  const points = makePointCloud([[0, 0, 0], [1, 0, 0]]);
  const pts = addNode(g, 'core/for-each-point', {
    extraInputs: [{ name: 'size', type: 'FloatCloud', optional: true }],
    inputValues: { points, __body: 'subgraph/test-body', size: 1.5 },
  });
  await evaluateGraph(g, reg, { rootNodeId: pts.id });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.inputs.size, 1.5);
  assert.equal(calls[1]!.inputs.size, 1.5);
});

test('for-each-point: FloatCloud derefs per iteration', async () => {
  const calls: CallRecord[] = [];
  const body = makeBody({
    bodyKind: 'subgraph/test-body',
    bodyInputs: [{ name: 'size', type: 'Float' }],
    calls,
  });
  const reg = makeRegistry(body);

  const g = createGraph();
  const points = makePointCloud([[0, 0, 0], [1, 0, 0], [2, 0, 0]]);
  const sizes = { count: 3, values: new Float32Array([10, 20, 30]) };
  const pts = addNode(g, 'core/for-each-point', {
    extraInputs: [{ name: 'size', type: 'FloatCloud', optional: true }],
    inputValues: { points, __body: 'subgraph/test-body', size: sizes },
  });
  await evaluateGraph(g, reg, { rootNodeId: pts.id });

  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.inputs.size, 10);
  assert.equal(calls[1]!.inputs.size, 20);
  assert.equal(calls[2]!.inputs.size, 30);
});

test('for-each-point: Vec3Cloud derefs per iteration', async () => {
  const calls: CallRecord[] = [];
  const body = makeBody({
    bodyKind: 'subgraph/test-body',
    bodyInputs: [{ name: 'colour', type: 'Vec3' }],
    calls,
  });
  const reg = makeRegistry(body);

  const g = createGraph();
  const points = makePointCloud([[0, 0, 0], [1, 0, 0]]);
  const colours = { count: 2, values: new Float32Array([1, 0, 0, 0, 1, 0]) };
  const pts = addNode(g, 'core/for-each-point', {
    extraInputs: [{ name: 'colour', type: 'Vec3Cloud', optional: true }],
    inputValues: { points, __body: 'subgraph/test-body', colour: colours },
  });
  await evaluateGraph(g, reg, { rootNodeId: pts.id });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.inputs.colour, [1, 0, 0]);
  assert.deepEqual(calls[1]!.inputs.colour, [0, 1, 0]);
});

test('for-each-point: lifts body Float output into a FloatCloud collected per iteration', async () => {
  // Body declares `area: Float`. The for-each-point's output named
  // `area` should be a FloatCloud whose values[i] = the body's per-
  // iteration Float result.
  const body: NodeDef = {
    id: 'subgraph/area-body',
    category: 'Test',
    inputs: [{ name: '__index', type: 'Int' }],
    outputs: [{ name: 'area', type: 'Float' }],
    evaluate(_ctx, inputs) {
      // Per-iteration, return index * 10 so we can assert the indexing.
      return { area: (inputs.__index as number) * 10 };
    },
  };
  const reg = createNodeRegistry();
  reg.register(forEachPointNode);
  reg.register(body);

  const g = createGraph();
  const pts = addNode(g, 'core/for-each-point', {
    inputValues: {
      points: makePointCloud([[0, 0, 0], [1, 0, 0], [2, 0, 0]]),
      __body: 'subgraph/area-body',
    },
  });
  const result = await evaluateGraph(g, reg, { rootNodeId: pts.id });
  const area = result.outputs.area as { count: number; values: Float32Array };
  assert.equal(area.count, 3);
  assert.deepEqual(Array.from(area.values), [0, 10, 20]);
});

test('for-each-point: lifts body Vec3 output into a Vec3Cloud', async () => {
  const body: NodeDef = {
    id: 'subgraph/vec-body',
    category: 'Test',
    inputs: [{ name: '__index', type: 'Int' }],
    outputs: [{ name: 'colour', type: 'Vec3' }],
    evaluate(_ctx, inputs) {
      const i = inputs.__index as number;
      return { colour: [i, i + 1, i + 2] };
    },
  };
  const reg = createNodeRegistry();
  reg.register(forEachPointNode);
  reg.register(body);

  const g = createGraph();
  const pts = addNode(g, 'core/for-each-point', {
    inputValues: {
      points: makePointCloud([[0, 0, 0], [1, 0, 0]]),
      __body: 'subgraph/vec-body',
    },
  });
  const result = await evaluateGraph(g, reg, { rootNodeId: pts.id });
  const colour = result.outputs.colour as { count: number; values: Float32Array };
  assert.equal(colour.count, 2);
  // iter 0 → [0,1,2], iter 1 → [1,2,3]
  assert.deepEqual(Array.from(colour.values), [0, 1, 2, 1, 2, 3]);
});

test('for-each-point: multiple body outputs lift independently', async () => {
  // Body emits BOTH a Scene and a Float per iteration; the for-each
  // should produce both `scene` (merged) and `area` (FloatCloud).
  const body: NodeDef = {
    id: 'subgraph/multi-body',
    category: 'Test',
    inputs: [{ name: '__index', type: 'Int' }],
    outputs: [
      { name: 'scene', type: 'Scene' },
      { name: 'area', type: 'Float' },
    ],
    evaluate(_ctx, inputs) {
      const i = inputs.__index as number;
      return {
        scene: { entities: [{ marker: i } as unknown as never] } as SceneValue,
        area: i + 1,
      };
    },
  };
  const reg = createNodeRegistry();
  reg.register(forEachPointNode);
  reg.register(body);

  const g = createGraph();
  const pts = addNode(g, 'core/for-each-point', {
    inputValues: {
      points: makePointCloud([[0, 0, 0], [1, 0, 0], [2, 0, 0]]),
      __body: 'subgraph/multi-body',
    },
  });
  const result = await evaluateGraph(g, reg, { rootNodeId: pts.id });
  const scene = result.outputs.scene as SceneValue;
  assert.equal(scene.entities.length, 3);
  const area = result.outputs.area as { count: number; values: Float32Array };
  assert.equal(area.count, 3);
  assert.deepEqual(Array.from(area.values), [1, 2, 3]);
});

test('for-each-point: unwired body input falls back to body\'s declared default', async () => {
  const calls: CallRecord[] = [];
  const body = makeBody({
    bodyKind: 'subgraph/test-body',
    bodyInputs: [{ name: 'size', type: 'Float', default: 7.0 }],
    calls,
  });
  const reg = makeRegistry(body);

  const g = createGraph();
  const pts = addNode(g, 'core/for-each-point', {
    // no `size` in inputValues and no extraInputs / edge
    inputValues: { points: makePointCloud([[0, 0, 0]]), __body: 'subgraph/test-body' },
  });
  await evaluateGraph(g, reg, { rootNodeId: pts.id });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.inputs.size, 7.0);
});
