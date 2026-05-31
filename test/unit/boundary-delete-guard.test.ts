// Deleting a subgraph's boundary node (subgraph-input / subgraph-output /
// iteration-input / iteration-output / bridge-eval) would leave the
// subgraph un-evaluatable with no UI path to add one back — the inner
// evaluator looks them up by id, and the canvas has no toolbar entry
// for "re-add the input boundary." `removeNodes` filters these kinds
// out before delegating to the dispatch path so accidental Delete
// inside a subgraph is a silent no-op rather than a footgun.
//
// Mixed-selection (boundary + ordinary node in the same delete batch)
// still removes the ordinary node — the guard only skips the
// load-bearing kinds, not the whole operation.
//
// Regression cover: keeps the guard from regressing back to "delete
// everything in the set" if the surrounding orphan-bridge cleanup gets
// refactored.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNode, createGraph } from '../../src/core/graph.js';
import { useEditorStore } from '../../src/editor/store.js';
import type { SubgraphDef } from '../../src/core/subgraph.js';

function seedBridgeAsActiveGraph(): {
  bridgeId: string;
  inputBoundaryId: string;
  iterInputBoundaryId: string;
  iterOutputBoundaryId: string;
  filler1Id: string;
  filler2Id: string;
} {
  const bridgeId = 'bridge-fep';
  const main = createGraph();
  // The for-each-point owner lives on `main` (out of view here);
  // tests focus on what happens when the user is editing the bridge
  // graph itself.
  addNode(main, 'core/for-each-point', {
    id: 'fep',
    inputValues: { __bridgeId: bridgeId },
  });
  const bridgeGraph = createGraph();
  const inputBoundary = addNode(bridgeGraph, `subgraph-input/${bridgeId}`);
  const iterInputBoundary = addNode(bridgeGraph, `iteration-input/${bridgeId}`);
  const iterOutputBoundary = addNode(bridgeGraph, `iteration-output/${bridgeId}`);
  const filler1 = addNode(bridgeGraph, 'core/perlin');
  const filler2 = addNode(bridgeGraph, 'core/perlin');
  const bridge: SubgraphDef = {
    id: bridgeId,
    label: 'test bridge',
    category: 'Subgraphs',
    inputs: [],
    outputs: [],
    graph: bridgeGraph,
    inputNodeId: inputBoundary.id,
    outputNodeId: iterOutputBoundary.id,
    owner: { kind: 'iteration-bridge', nodeId: 'fep' },
    iterationKind: 'core/for-each-point',
  };
  useEditorStore.setState({
    mainGraph: main,
    graph: bridgeGraph,
    currentEditingId: bridgeId,
    subgraphs: [bridge],
    folders: [],
    undoStack: [],
    redoStack: [],
  });
  return {
    bridgeId,
    inputBoundaryId: inputBoundary.id,
    iterInputBoundaryId: iterInputBoundary.id,
    iterOutputBoundaryId: iterOutputBoundary.id,
    filler1Id: filler1.id,
    filler2Id: filler2.id,
  };
}

test('removeNodes skips subgraph-input boundary nodes', () => {
  const seed = seedBridgeAsActiveGraph();
  const before = useEditorStore.getState().graph.nodes.length;
  useEditorStore.getState().removeNodes(new Set([seed.inputBoundaryId]));
  const after = useEditorStore.getState().graph.nodes;
  assert.equal(after.length, before, 'boundary should survive Delete');
  assert.ok(after.find((n) => n.id === seed.inputBoundaryId), 'subgraph-input still present');
});

test('removeNodes skips iteration-input boundary nodes', () => {
  const seed = seedBridgeAsActiveGraph();
  const before = useEditorStore.getState().graph.nodes.length;
  useEditorStore.getState().removeNodes(new Set([seed.iterInputBoundaryId]));
  const nodes = useEditorStore.getState().graph.nodes;
  assert.equal(nodes.length, before);
  assert.ok(nodes.find((n) => n.id === seed.iterInputBoundaryId));
});

test('removeNodes skips iteration-output boundary nodes', () => {
  const seed = seedBridgeAsActiveGraph();
  const before = useEditorStore.getState().graph.nodes.length;
  useEditorStore.getState().removeNodes(new Set([seed.iterOutputBoundaryId]));
  const nodes = useEditorStore.getState().graph.nodes;
  assert.equal(nodes.length, before);
  assert.ok(nodes.find((n) => n.id === seed.iterOutputBoundaryId));
});

test('mixed selection: ordinary node deletes, boundary survives', () => {
  const seed = seedBridgeAsActiveGraph();
  useEditorStore.getState().removeNodes(new Set([seed.inputBoundaryId, seed.filler1Id]));
  const nodes = useEditorStore.getState().graph.nodes;
  assert.ok(nodes.find((n) => n.id === seed.inputBoundaryId), 'boundary survived');
  assert.ok(!nodes.find((n) => n.id === seed.filler1Id), 'ordinary node was removed');
  assert.ok(nodes.find((n) => n.id === seed.filler2Id), 'untouched filler still here');
});

test('all-boundary selection is a complete no-op (no undo entry)', () => {
  const seed = seedBridgeAsActiveGraph();
  const undoBefore = useEditorStore.getState().undoStack.length;
  useEditorStore.getState().removeNodes(new Set([
    seed.inputBoundaryId,
    seed.iterInputBoundaryId,
    seed.iterOutputBoundaryId,
  ]));
  const undoAfter = useEditorStore.getState().undoStack.length;
  assert.equal(undoAfter, undoBefore, 'no undo entry pushed for skipped delete');
});
