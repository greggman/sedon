// Editing a `core/for-each-point`'s private bridge subgraph
// (adding / removing / renaming sockets on its `subgraph-input` or
// `iteration-output` boundaries) must reach back through the store
// to refresh the owning for-each-point's outer `extraInputs` /
// `extraOutputs`. Without that auto-sync, sockets added inside the
// bridge live in a parallel universe nothing outside the bridge can
// wire into.
//
// `addSubgraphSocket` assigns the socket NAME from `crypto.randomUUID()`
// (a stable handle id) and stores the user-facing string in `label`,
// so these tests look extras up by type or by reading the freshly-
// added socket's name out of the bridge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import { useEditorStore } from '../../src/editor/store.js';
import type { SubgraphDef } from '../../src/core/subgraph.js';

function seedWithForEachAndBridge(): { feNodeId: string; bridgeId: string } {
  const feNodeId = 'fep';
  const bridgeId = 'bridge-fep';
  const main = createGraph();
  addNode(main, 'core/for-each-point', {
    id: feNodeId,
    inputValues: { __bridgeId: bridgeId },
    extraInputs: [],
    extraOutputs: [],
  });
  const bridgeGraph = createGraph();
  const inputBoundary = addNode(bridgeGraph, `subgraph-input/${bridgeId}`);
  addNode(bridgeGraph, `iteration-input/${bridgeId}`);
  const iterOutputBoundary = addNode(bridgeGraph, `iteration-output/${bridgeId}`);
  const bridge: SubgraphDef = {
    id: bridgeId,
    label: 'test bridge',
    category: 'Subgraphs',
    inputs: [],
    outputs: [],
    graph: bridgeGraph,
    inputNodeId: inputBoundary.id,
    outputNodeId: iterOutputBoundary.id,
    owner: { kind: 'iteration-bridge', nodeId: feNodeId },
    iterationKind: 'core/for-each-point',
  };
  useEditorStore.setState({
    mainGraph: main,
    graph: main,
    currentEditingId: 'main',
    subgraphs: [bridge],
    folders: [],
    undoStack: [],
    redoStack: [],
  });
  return { feNodeId, bridgeId };
}

function feNode() {
  return useEditorStore.getState().graph.nodes.find((n) => n.id === 'fep');
}

function getBridge(bridgeId: string) {
  return useEditorStore.getState().subgraphs.find((s) => s.id === bridgeId)!;
}

test('adding a Vec3 bridge input lifts to Vec3Cloud on for-each-point', () => {
  const { bridgeId } = seedWithForEachAndBridge();
  useEditorStore.getState().addSubgraphSocket(bridgeId, 'input', { label: 'size', type: 'Vec3' });
  const bridge = getBridge(bridgeId);
  const bridgeInputName = bridge.inputs[0]!.name; // UUID
  const fe = feNode();
  assert.equal(fe?.extraInputs?.length, 1);
  assert.equal(fe?.extraInputs?.[0]?.name, bridgeInputName);
  assert.equal(fe?.extraInputs?.[0]?.type, 'Vec3Cloud');
});

test('adding a Float bridge input lifts to FloatCloud on for-each-point', () => {
  const { bridgeId } = seedWithForEachAndBridge();
  useEditorStore.getState().addSubgraphSocket(bridgeId, 'input', { label: 'weight', type: 'Float' });
  assert.equal(feNode()?.extraInputs?.[0]?.type, 'FloatCloud');
});

test('non-liftable bridge input (Material) stays broadcast-only on for-each-point', () => {
  const { bridgeId } = seedWithForEachAndBridge();
  useEditorStore.getState().addSubgraphSocket(bridgeId, 'input', { label: 'material', type: 'Material' });
  assert.equal(feNode()?.extraInputs?.[0]?.type, 'Material');
});

test('adding an iteration-output socket on the bridge surfaces as an extraOutput', () => {
  const { bridgeId } = seedWithForEachAndBridge();
  useEditorStore.getState().addSubgraphSocket(bridgeId, 'output', { label: 'scene', type: 'Scene' });
  const bridge = getBridge(bridgeId);
  const fe = feNode();
  assert.equal(fe?.extraOutputs?.length, 1);
  assert.equal(fe?.extraOutputs?.[0]?.name, bridge.outputs[0]!.name);
  assert.equal(fe?.extraOutputs?.[0]?.type, 'Scene');
});

test('removing a bridge input drops the matching extraInput AND any incoming edge', () => {
  const { feNodeId, bridgeId } = seedWithForEachAndBridge();
  useEditorStore.getState().addSubgraphSocket(bridgeId, 'input', { label: 'size', type: 'Vec3' });
  const bridgeInputName = getBridge(bridgeId).inputs[0]!.name;
  // Wire an upstream into the newly-mirrored socket on the for-each-point.
  const state = useEditorStore.getState();
  const main = state.graph;
  const src = addNode(main, 'core/perlin');
  addEdge(main, { node: src.id, socket: 'texture' }, { node: feNodeId, socket: bridgeInputName });
  useEditorStore.setState({ mainGraph: main, graph: main });
  // Remove the bridge input — for-each-point's extra and the edge
  // pointing at it should both go.
  useEditorStore.getState().removeSubgraphSocket(bridgeId, 'input', bridgeInputName);
  const fe = feNode();
  assert.equal(fe?.extraInputs?.length, 0);
  const edgesToFe = useEditorStore.getState().graph.edges.filter((e) => e.to.node === feNodeId);
  assert.equal(edgesToFe.length, 0);
});

test('the points socket (static, not an extra) survives bridge IO edits', () => {
  const { feNodeId, bridgeId } = seedWithForEachAndBridge();
  const main = useEditorStore.getState().graph;
  const grid = addNode(main, 'core/grid-distribute');
  addEdge(main, { node: grid.id, socket: 'points' }, { node: feNodeId, socket: 'points' });
  useEditorStore.setState({ mainGraph: main, graph: main });
  useEditorStore.getState().addSubgraphSocket(bridgeId, 'output', { label: 'scene', type: 'Scene' });
  const edgesToFe = useEditorStore.getState().graph.edges.filter((e) => e.to.node === feNodeId);
  assert.equal(edgesToFe.length, 1);
  assert.equal(edgesToFe[0]?.to.socket, 'points');
});
