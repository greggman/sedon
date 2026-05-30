import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import { evaluateGraph } from '../../src/core/evaluate.js';
import { createNodeRegistry, type NodeDef, type NodeRegistry } from '../../src/core/node-def.js';

// Tiny test rig: a "capture" node with a single numeric input whose
// bounds we configure per-test. The node records whatever value the
// evaluator actually passes in, and we assert against that.

function makeRegistry(capture: { type: 'Int' | 'Float'; default?: number; min?: number; max?: number }): { reg: NodeRegistry; received: { value: unknown } } {
  const received = { value: undefined as unknown };
  const captureDef: NodeDef = {
    id: 'test/capture',
    category: 'Test',
    inputs: [
      {
        name: 'value',
        type: capture.type,
        ...(capture.default !== undefined ? { default: capture.default } : {}),
        ...(capture.min !== undefined ? { min: capture.min } : {}),
        ...(capture.max !== undefined ? { max: capture.max } : {}),
      },
    ],
    outputs: [{ name: 'out', type: capture.type }],
    evaluate: (_ctx, inputs) => {
      received.value = inputs.value;
      return { out: inputs.value };
    },
  };
  // Float producer used to feed an upstream wire into the capture node.
  const floatProducer: NodeDef = {
    id: 'test/float',
    category: 'Test',
    inputs: [{ name: 'v', type: capture.type, default: 0 }],
    outputs: [{ name: 'out', type: capture.type }],
    evaluate: (_ctx, inputs) => ({ out: inputs.v }),
  };
  const reg = createNodeRegistry();
  reg.register(captureDef);
  reg.register(floatProducer);
  return { reg, received };
}

test('evaluator clamps inputValue below declared min', async () => {
  const { reg, received } = makeRegistry({ type: 'Int', min: 3 });
  const g = createGraph();
  const n = addNode(g, 'test/capture', { inputValues: { value: 1 } });
  await evaluateGraph(g, reg, { rootNodeId: n.id });
  assert.equal(received.value, 3);
});

test('evaluator clamps inputValue above declared max', async () => {
  const { reg, received } = makeRegistry({ type: 'Int', max: 8 });
  const g = createGraph();
  const n = addNode(g, 'test/capture', { inputValues: { value: 999 } });
  await evaluateGraph(g, reg, { rootNodeId: n.id });
  assert.equal(received.value, 8);
});

test('evaluator leaves in-range values untouched', async () => {
  const { reg, received } = makeRegistry({ type: 'Int', min: 3, max: 8 });
  const g = createGraph();
  const n = addNode(g, 'test/capture', { inputValues: { value: 5 } });
  await evaluateGraph(g, reg, { rootNodeId: n.id });
  assert.equal(received.value, 5);
});

test('evaluator clamps upstream-wired values, not just inputValues', async () => {
  // The whole point of putting the clamp at the eval boundary rather
  // than in NumberInput: an upstream wire feeding a bad value must also
  // be brought into range before the consumer node sees it.
  const { reg, received } = makeRegistry({ type: 'Int', min: 3 });
  const g = createGraph();
  const src = addNode(g, 'test/float', { inputValues: { v: 1 } });
  const sink = addNode(g, 'test/capture');
  addEdge(g, { node: src.id, socket: 'out' }, { node: sink.id, socket: 'value' });
  await evaluateGraph(g, reg, { rootNodeId: sink.id });
  assert.equal(received.value, 3, 'wire value clamped to declared min');
});

test('evaluator clamps the default when nothing else is provided', async () => {
  // A node author who declares min:3 but default:1 has a bug, but the
  // runtime still hands evaluate a sane value rather than the bad
  // default.
  const { reg, received } = makeRegistry({ type: 'Int', default: 1, min: 3 });
  const g = createGraph();
  const n = addNode(g, 'test/capture');
  await evaluateGraph(g, reg, { rootNodeId: n.id });
  assert.equal(received.value, 3);
});

test('only one bound is required — min without max', async () => {
  const { reg, received } = makeRegistry({ type: 'Int', min: 3 });
  const g = createGraph();
  // Value of 1_000_000 is far above any reasonable max; with no max
  // declared it must pass through.
  const n = addNode(g, 'test/capture', { inputValues: { value: 1_000_000 } });
  await evaluateGraph(g, reg, { rootNodeId: n.id });
  assert.equal(received.value, 1_000_000);
});

test('only one bound is required — max without min', async () => {
  const { reg, received } = makeRegistry({ type: 'Int', max: 8 });
  const g = createGraph();
  const n = addNode(g, 'test/capture', { inputValues: { value: -1_000_000 } });
  await evaluateGraph(g, reg, { rootNodeId: n.id });
  assert.equal(received.value, -1_000_000);
});

test('clamp does not touch non-numeric inputs', async () => {
  // A Color input with stray min/max declared (a node-author mistake)
  // should not be reinterpreted as a number. The array passes through.
  const received = { value: undefined as unknown };
  const captureDef: NodeDef = {
    id: 'test/capture-color',
    category: 'Test',
    inputs: [{ name: 'value', type: 'Color', min: 3, max: 8, default: [1, 0, 0, 1] }],
    outputs: [{ name: 'out', type: 'Color' }],
    evaluate: (_ctx, inputs) => {
      received.value = inputs.value;
      return { out: inputs.value };
    },
  };
  const reg = createNodeRegistry();
  reg.register(captureDef);
  const g = createGraph();
  const n = addNode(g, 'test/capture-color', { inputValues: { value: [0.5, 0.5, 0.5, 1] } });
  await evaluateGraph(g, reg, { rootNodeId: n.id });
  assert.deepEqual(received.value, [0.5, 0.5, 0.5, 1]);
});

test('Float inputs also honor min/max', async () => {
  const { reg, received } = makeRegistry({ type: 'Float', min: 0, max: 1 });
  const g = createGraph();
  const n = addNode(g, 'test/capture', { inputValues: { value: 2.5 } });
  await evaluateGraph(g, reg, { rootNodeId: n.id });
  assert.equal(received.value, 1);
});
