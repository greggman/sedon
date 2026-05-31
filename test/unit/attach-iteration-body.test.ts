// Dropping a body subgraph onto a for-each-point goes through the
// `attachIterationBody` store action. It builds a private bridge
// SubgraphDef from scratch — three boundary nodes (subgraph-input,
// iteration-input, iteration-output) plus one wrapper instance of the
// body — and auto-wires:
//   • iteration-input.<name> → body.<name>   for every body input whose
//                                            name matches a provided
//                                            iteration-context name
//                                            (position, index)
//   • body.<name> → iteration-output.<name>  for every cloudable body
//                                            output (Scene / Float /
//                                            Vec3)
//   • subgraph-input.<name> → body.<name>    for every remaining body
//                                            input (broadcast inputs)
//
// The for-each-point's outer surface mirrors the bridge: broadcast
// inputs become cloud-lifted `extraInputs`, bridge outputs become
// cloud-lifted `extraOutputs`. `__bridgeId` on the for-each-point gets
// stamped with the new bridge's id so the runtime can find the bridge
// later (the runtime looks up `bridge-eval/<id>` in the registry).
//
// Re-attaching a different body REPLACES the bridge wholesale — the
// previous bridge's user-typed broadcast edits are discarded by design
// (the user can copy them over before re-attaching if they care).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNode, createGraph } from '../../src/core/graph.js';
import { useEditorStore } from '../../src/editor/store.js';
import type { SubgraphDef } from '../../src/core/subgraph.js';

function makeBodySubgraph(opts: {
  id: string;
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
}): SubgraphDef {
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${opts.id}`);
  const outputNode = addNode(g, `subgraph-output/${opts.id}`);
  return {
    id: opts.id,
    label: opts.id,
    category: 'Subgraphs',
    inputs: opts.inputs,
    outputs: opts.outputs,
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

function seedWithForEachAndBody(body: SubgraphDef): { feNodeId: string } {
  const feNodeId = 'fep';
  const main = createGraph();
  addNode(main, 'core/for-each-point', { id: feNodeId });
  useEditorStore.setState({
    mainGraph: main,
    graph: main,
    currentEditingId: 'main',
    subgraphs: [body],
    folders: [],
    undoStack: [],
    redoStack: [],
  });
  return { feNodeId };
}

function feNode(id = 'fep') {
  return useEditorStore.getState().graph.nodes.find((n) => n.id === id);
}

function getBridge(forNodeId: string) {
  return useEditorStore.getState().subgraphs.find(
    (s) => s.owner?.kind === 'iteration-bridge' && s.owner.nodeId === forNodeId,
  )!;
}

test('attachIterationBody creates a bridge with the three boundary nodes + one body wrapper', () => {
  const body = makeBodySubgraph({
    id: 'b1',
    inputs: [{ name: 'position', type: 'Vec3' }],
    outputs: [{ name: 'scene', type: 'Scene' }],
  });
  const { feNodeId } = seedWithForEachAndBody(body);
  useEditorStore.getState().attachIterationBody(feNodeId, 'subgraph/b1');
  const bridge = getBridge(feNodeId);
  assert.ok(bridge, 'bridge was created');
  const kinds = bridge.graph.nodes.map((n) => n.kind).sort();
  assert.deepEqual(kinds, [
    `iteration-input/${bridge.id}`,
    `iteration-output/${bridge.id}`,
    `subgraph-input/${bridge.id}`,
    'subgraph/b1',
  ]);
});

test('attachIterationBody stamps __bridgeId on the for-each-point', () => {
  const body = makeBodySubgraph({
    id: 'b1',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
  });
  const { feNodeId } = seedWithForEachAndBody(body);
  useEditorStore.getState().attachIterationBody(feNodeId, 'subgraph/b1');
  const bridge = getBridge(feNodeId);
  const fe = feNode();
  assert.equal(fe?.inputValues?.__bridgeId, bridge.id);
});

test('attachIterationBody auto-wires iteration-input.position → body.position (name match)', () => {
  const body = makeBodySubgraph({
    id: 'b1',
    inputs: [{ name: 'position', type: 'Vec3' }],
    outputs: [{ name: 'scene', type: 'Scene' }],
  });
  const { feNodeId } = seedWithForEachAndBody(body);
  useEditorStore.getState().attachIterationBody(feNodeId, 'subgraph/b1');
  const bridge = getBridge(feNodeId);
  const iterIn = bridge.graph.nodes.find((n) => n.kind === `iteration-input/${bridge.id}`)!;
  const wrapper = bridge.graph.nodes.find((n) => n.kind === 'subgraph/b1')!;
  const edge = bridge.graph.edges.find(
    (e) =>
      e.from.node === iterIn.id &&
      e.from.socket === 'position' &&
      e.to.node === wrapper.id &&
      e.to.socket === 'position',
  );
  assert.ok(edge, 'iteration-input.position → body.position wired');
});

test('attachIterationBody auto-wires body.scene → iteration-output.scene (cloudable output)', () => {
  const body = makeBodySubgraph({
    id: 'b1',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
  });
  const { feNodeId } = seedWithForEachAndBody(body);
  useEditorStore.getState().attachIterationBody(feNodeId, 'subgraph/b1');
  const bridge = getBridge(feNodeId);
  const iterOut = bridge.graph.nodes.find((n) => n.kind === `iteration-output/${bridge.id}`)!;
  const wrapper = bridge.graph.nodes.find((n) => n.kind === 'subgraph/b1')!;
  const edge = bridge.graph.edges.find(
    (e) =>
      e.from.node === wrapper.id &&
      e.from.socket === 'scene' &&
      e.to.node === iterOut.id &&
      e.to.socket === 'scene',
  );
  assert.ok(edge, 'body.scene → iteration-output.scene wired');
});

test('broadcast inputs surface on the for-each-point as cloud-lifted extras (Vec3 → Vec3Cloud)', () => {
  const body = makeBodySubgraph({
    id: 'b1',
    // `size` is NOT a provided iteration-context name → broadcast input.
    inputs: [
      { name: 'position', type: 'Vec3' },
      { name: 'size', type: 'Vec3' },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
  });
  const { feNodeId } = seedWithForEachAndBody(body);
  useEditorStore.getState().attachIterationBody(feNodeId, 'subgraph/b1');
  const fe = feNode();
  const size = fe?.extraInputs?.find((i) => i.name === 'size');
  assert.ok(size, 'size lifted to outer surface');
  assert.equal(size?.type, 'Vec3Cloud');
  // position was matched to iteration-input → MUST NOT appear as an extra.
  const position = fe?.extraInputs?.find((i) => i.name === 'position');
  assert.equal(position, undefined, 'position not duplicated on outer surface');
});

test('non-cloudable broadcast input stays at its original type on the outer surface', () => {
  const body = makeBodySubgraph({
    id: 'b1',
    inputs: [
      { name: 'position', type: 'Vec3' },
      { name: 'material', type: 'Material' },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
  });
  const { feNodeId } = seedWithForEachAndBody(body);
  useEditorStore.getState().attachIterationBody(feNodeId, 'subgraph/b1');
  const fe = feNode();
  const material = fe?.extraInputs?.find((i) => i.name === 'material');
  assert.ok(material);
  assert.equal(material?.type, 'Material');
});

test('Scene body output lifts to Scene on the outer surface (Scene merges, no cloud)', () => {
  const body = makeBodySubgraph({
    id: 'b1',
    inputs: [{ name: 'position', type: 'Vec3' }],
    outputs: [{ name: 'scene', type: 'Scene' }],
  });
  const { feNodeId } = seedWithForEachAndBody(body);
  useEditorStore.getState().attachIterationBody(feNodeId, 'subgraph/b1');
  const fe = feNode();
  const scene = fe?.extraOutputs?.find((o) => o.name === 'scene');
  assert.ok(scene);
  assert.equal(scene?.type, 'Scene');
});

test('non-cloudable body outputs are dropped from the bridge entirely', () => {
  const body = makeBodySubgraph({
    id: 'b1',
    inputs: [],
    // Material isn't in the cloud-lift table → bridge ignores it.
    outputs: [
      { name: 'scene', type: 'Scene' },
      { name: 'mat', type: 'Material' },
    ],
  });
  const { feNodeId } = seedWithForEachAndBody(body);
  useEditorStore.getState().attachIterationBody(feNodeId, 'subgraph/b1');
  const bridge = getBridge(feNodeId);
  const names = bridge.outputs.map((o) => o.name);
  assert.deepEqual(names, ['scene']);
  // And the for-each-point's outer outputs match the bridge.
  const fe = feNode();
  const outerNames = (fe?.extraOutputs ?? []).map((o) => o.name);
  assert.deepEqual(outerNames, ['scene']);
});

test('marks the bridge node-owned (owner.kind === iteration-bridge) and tags iterationKind', () => {
  const body = makeBodySubgraph({
    id: 'b1',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
  });
  const { feNodeId } = seedWithForEachAndBody(body);
  useEditorStore.getState().attachIterationBody(feNodeId, 'subgraph/b1');
  const bridge = getBridge(feNodeId);
  assert.deepEqual(bridge.owner, { kind: 'iteration-bridge', nodeId: feNodeId });
  assert.equal(bridge.iterationKind, 'core/for-each-point');
});

test('re-attaching a different body replaces the bridge wholesale', () => {
  const bodyA = makeBodySubgraph({
    id: 'bodyA',
    inputs: [
      { name: 'position', type: 'Vec3' },
      { name: 'sizeA', type: 'Vec3' },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
  });
  const bodyB = makeBodySubgraph({
    id: 'bodyB',
    inputs: [
      { name: 'position', type: 'Vec3' },
      { name: 'colorB', type: 'Color' },
    ],
    outputs: [
      { name: 'scene', type: 'Scene' },
      { name: 'weight', type: 'Float' },
    ],
  });
  const feNodeId = 'fep';
  const main = createGraph();
  addNode(main, 'core/for-each-point', { id: feNodeId });
  useEditorStore.setState({
    mainGraph: main,
    graph: main,
    currentEditingId: 'main',
    subgraphs: [bodyA, bodyB],
    folders: [],
    undoStack: [],
    redoStack: [],
  });

  useEditorStore.getState().attachIterationBody(feNodeId, 'subgraph/bodyA');
  const firstBridge = getBridge(feNodeId);
  assert.ok(feNode()?.extraInputs?.find((i) => i.name === 'sizeA'));

  useEditorStore.getState().attachIterationBody(feNodeId, 'subgraph/bodyB');
  const secondBridge = getBridge(feNodeId);

  // Only one bridge for this node — the previous bridge object is gone.
  const allBridges = useEditorStore.getState().subgraphs.filter(
    (s) => s.owner?.kind === 'iteration-bridge' && s.owner.nodeId === feNodeId,
  );
  assert.equal(allBridges.length, 1, 'exactly one bridge after re-attach');
  assert.equal(allBridges[0]!.id, firstBridge.id, 'bridge id is stable across re-attach (derived from nodeId)');
  assert.equal(secondBridge.id, firstBridge.id);

  // Outer surface reflects bodyB now, not bodyA.
  const fe = feNode();
  assert.ok(!fe?.extraInputs?.find((i) => i.name === 'sizeA'), 'old extra dropped');
  assert.ok(fe?.extraInputs?.find((i) => i.name === 'colorB'), 'new extra present');
  assert.ok(fe?.extraOutputs?.find((o) => o.name === 'weight'), 'new lifted output present');
});

test('attachIterationBody is a no-op when the target node is not core/for-each-point', () => {
  const body = makeBodySubgraph({
    id: 'b1',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
  });
  const main = createGraph();
  addNode(main, 'core/perlin', { id: 'noise' });
  useEditorStore.setState({
    mainGraph: main,
    graph: main,
    currentEditingId: 'main',
    subgraphs: [body],
    folders: [],
    undoStack: [],
    redoStack: [],
  });
  useEditorStore.getState().attachIterationBody('noise', 'subgraph/b1');
  const bridges = useEditorStore.getState().subgraphs.filter(
    (s) => s.owner?.kind === 'iteration-bridge',
  );
  assert.equal(bridges.length, 0, 'no bridge created for non-for-each-point node');
});

test('attachIterationBody is a no-op when the body id is unknown', () => {
  const body = makeBodySubgraph({
    id: 'b1',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
  });
  const { feNodeId } = seedWithForEachAndBody(body);
  useEditorStore.getState().attachIterationBody(feNodeId, 'subgraph/does-not-exist');
  const bridges = useEditorStore.getState().subgraphs.filter(
    (s) => s.owner?.kind === 'iteration-bridge',
  );
  assert.equal(bridges.length, 0);
  assert.equal(feNode()?.inputValues?.__bridgeId, undefined);
});
