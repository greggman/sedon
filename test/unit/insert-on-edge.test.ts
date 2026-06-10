// "Drop on wire": dropping a new node when exactly one edge is selected
// splices the node into the wire as ONE undo step. The high-level
// helper (`tryInsertOnSelectedEdge` in commands.ts) reads RF state and
// is exercised by the browser tests; this file pins the STORE-level
// contract — `insertNodeOnEdge` builds the right batch and undo/redo
// round-trip cleanly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import { useEditorStore } from '../../src/editor/store.js';

function seedSphereToOutput(): {
  sphereId: string;
  outputId: string;
  edgeId: string;
} {
  const g = createGraph();
  const sphere = addNode(g, 'geom/sphere', { id: 'sphere' });
  const output = addNode(g, 'core/output', { id: 'output' });
  const edge = addEdge(
    g,
    { node: sphere.id, socket: 'geometry' },
    { node: output.id, socket: 'scene' },
  );
  useEditorStore.setState({
    mainGraph: g,
    graph: g,
    rootNodeId: output.id,
    currentEditingId: 'main',
    subgraphs: [],
    folders: [],
    undoStack: [],
    redoStack: [],
    nodePositions: { main: {} },
  });
  return { sphereId: sphere.id, outputId: output.id, edgeId: edge.id };
}

test('insertNodeOnEdge: removes the old edge and adds node + two new edges (1 undo entry)', () => {
  // We don't run real type validation here — the caller in
  // commands.ts already picked compatible sockets. The store action
  // just dispatches the batch. Use geom/bevel as the inserted node;
  // it has a Geometry in + Geometry out so it logically fits between
  // sphere.geometry → output.scene (the test only cares about the
  // batch shape, not eval).
  const seed = seedSphereToOutput();
  const undoBefore = useEditorStore.getState().undoStack.length;

  const newNodeId = 'newnode';
  const result = useEditorStore.getState().insertNodeOnEdge({
    oldEdgeId: seed.edgeId,
    newNode: { id: newNodeId, kind: 'geom/bevel', position: { x: 100, y: 100 } },
    inputEdgeId: 'e-in',
    outputEdgeId: 'e-out',
    newInputSocket: 'geometry',
    newOutputSocket: 'geometry',
  });

  assert.deepEqual(result, { inputEdgeId: 'e-in', outputEdgeId: 'e-out' });

  const state = useEditorStore.getState();
  // Old edge gone.
  assert.equal(state.graph.edges.find((e) => e.id === seed.edgeId), undefined);
  // New node present.
  assert.ok(state.graph.nodes.find((n) => n.id === newNodeId), 'new node added');
  // Two new edges with the right wiring.
  const eIn = state.graph.edges.find((e) => e.id === 'e-in')!;
  const eOut = state.graph.edges.find((e) => e.id === 'e-out')!;
  assert.equal(eIn.from.node, seed.sphereId);
  assert.equal(eIn.from.socket, 'geometry');
  assert.equal(eIn.to.node, newNodeId);
  assert.equal(eIn.to.socket, 'geometry');
  assert.equal(eOut.from.node, newNodeId);
  assert.equal(eOut.from.socket, 'geometry');
  assert.equal(eOut.to.node, seed.outputId);
  assert.equal(eOut.to.socket, 'scene');
  // ONE undo step covers the entire operation.
  assert.equal(state.undoStack.length - undoBefore, 1);
});

test('insertNodeOnEdge: single Cmd-Z restores the original wire and removes the new node', () => {
  const seed = seedSphereToOutput();
  useEditorStore.getState().insertNodeOnEdge({
    oldEdgeId: seed.edgeId,
    newNode: { id: 'newnode', kind: 'geom/bevel', position: { x: 100, y: 100 } },
    inputEdgeId: 'e-in',
    outputEdgeId: 'e-out',
    newInputSocket: 'geometry',
    newOutputSocket: 'geometry',
  });
  useEditorStore.getState().undo();
  const state = useEditorStore.getState();
  // Original edge back.
  assert.ok(state.graph.edges.find((e) => e.id === seed.edgeId), 'old edge restored');
  // New node and its two edges gone.
  assert.equal(state.graph.nodes.find((n) => n.id === 'newnode'), undefined);
  assert.equal(state.graph.edges.find((e) => e.id === 'e-in'), undefined);
  assert.equal(state.graph.edges.find((e) => e.id === 'e-out'), undefined);
});

test('insertNodeOnEdge: redo re-plays the splice as one step', () => {
  const seed = seedSphereToOutput();
  useEditorStore.getState().insertNodeOnEdge({
    oldEdgeId: seed.edgeId,
    newNode: { id: 'newnode', kind: 'geom/bevel', position: { x: 100, y: 100 } },
    inputEdgeId: 'e-in',
    outputEdgeId: 'e-out',
    newInputSocket: 'geometry',
    newOutputSocket: 'geometry',
  });
  useEditorStore.getState().undo();
  useEditorStore.getState().redo();
  const state = useEditorStore.getState();
  assert.equal(state.graph.edges.find((e) => e.id === seed.edgeId), undefined, 'old edge gone again');
  assert.ok(state.graph.nodes.find((n) => n.id === 'newnode'));
  assert.ok(state.graph.edges.find((e) => e.id === 'e-in'));
  assert.ok(state.graph.edges.find((e) => e.id === 'e-out'));
});

test('insertNodeOnEdge: missing source edge throws (caller bug, not silent corruption)', () => {
  seedSphereToOutput();
  assert.throws(
    () =>
      useEditorStore.getState().insertNodeOnEdge({
        oldEdgeId: 'GHOST',
        newNode: { id: 'n', kind: 'geom/bevel', position: { x: 0, y: 0 } },
        inputEdgeId: 'a',
        outputEdgeId: 'b',
        newInputSocket: 'geometry',
        newOutputSocket: 'geometry',
      }),
    /no edge with id/,
  );
});

test('insertNodeOnEdge: preserves position on the new node (survives save round-trip)', () => {
  // commands.ts stamps position on the GraphNode so nodePositions is
  // seeded correctly. Verify the store wrote both.
  const seed = seedSphereToOutput();
  useEditorStore.getState().insertNodeOnEdge({
    oldEdgeId: seed.edgeId,
    newNode: { id: 'placed', kind: 'geom/bevel', position: { x: 250, y: 100 } },
    inputEdgeId: 'e-in',
    outputEdgeId: 'e-out',
    newInputSocket: 'geometry',
    newOutputSocket: 'geometry',
  });
  const node = useEditorStore.getState().graph.nodes.find((n) => n.id === 'placed')!;
  assert.deepEqual(node.position, { x: 250, y: 100 });
  // nodePositions slice picks the position up via mergeNodePositions
  // when dispatch reconciles. Verify the live slice is in sync — the
  // canvas reads from here, not from graph.nodes.
  const live = useEditorStore.getState().nodePositions.main!['placed']!;
  assert.deepEqual(live, { x: 250, y: 100 });
});
