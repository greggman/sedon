// store.setForEachBody: atomically attach (or clear) a body subgraph
// on a core/for-each-point node. The action:
//   • sets the hidden `__body` inputValue to the wrapper kind
//   • rebuilds `node.extraInputs` to mirror the body subgraph's
//     inputs (Float → FloatCloud, Vec3 → Vec3Cloud, implicit
//     `__position` / `__index` skipped, everything else broadcast)
//   • drops incoming edges whose target socket disappears
//   • is one undoable command

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import { createEmptySubgraph } from '../../src/core/subgraph.js';
import { useEditorStore } from '../../src/editor/store.js';

function seed(opts: {
  bodyInputs?: { name: string; type: string }[];
  extraEdgeNames?: string[];
}): { feNodeId: string; bodyKind: string } {
  const g = createGraph();
  const fe = addNode(g, 'core/for-each-point');
  // A tiny source node to wire edges to the for-each-point's mirrored
  // sockets. Any node with named outputs works — perlin has a single
  // `texture` output, so we just point to that for naming purposes.
  const src = addNode(g, 'core/perlin');
  for (const name of opts.extraEdgeNames ?? []) {
    addEdge(g, { node: src.id, socket: 'texture' }, { node: fe.id, socket: name });
  }
  const body = createEmptySubgraph('test-body', 'Test Body');
  body.inputs = (opts.bodyInputs ?? []).map((i) => ({ name: i.name, type: i.type }));
  useEditorStore.setState({
    mainGraph: g,
    graph: g,
    currentEditingId: 'main',
    subgraphs: [body],
    undoStack: [],
    redoStack: [],
  });
  return { feNodeId: fe.id, bodyKind: 'subgraph/test-body' };
}

function nodeOf(id: string) {
  return useEditorStore.getState().graph.nodes.find((n) => n.id === id);
}

test('setForEachBody: mirrors body outputs (Scene→Scene, Float→FloatCloud, Vec3→Vec3Cloud), skips non-cloudable', () => {
  // Body declares one of each cloudable output + a Texture2D which
  // can't be lifted (no "cloud of textures" type). The for-each
  // should expose the three cloudable ones and silently skip the
  // Texture2D.
  const g = createGraph();
  const fe = addNode(g, 'core/for-each-point');
  const body = createEmptySubgraph('test-body', 'Test Body');
  body.outputs = [
    { name: 'scene', type: 'Scene' },
    { name: 'area', type: 'Float' },
    { name: 'colour', type: 'Vec3' },
    { name: 'tex', type: 'Texture2D' },
  ];
  useEditorStore.setState({
    mainGraph: g, graph: g, currentEditingId: 'main',
    subgraphs: [body], folders: [], undoStack: [], redoStack: [],
  });
  useEditorStore.getState().setForEachBody(fe.id, 'subgraph/test-body');
  const after = useEditorStore.getState().graph.nodes.find((n) => n.id === fe.id);
  assert.deepEqual(after?.extraOutputs, [
    { name: 'scene', type: 'Scene' },
    { name: 'area', type: 'FloatCloud' },
    { name: 'colour', type: 'Vec3Cloud' },
    // tex omitted — Texture2D has no cloud variant
  ]);
});

test('setForEachBody: changing body drops outgoing edges whose source socket disappears', () => {
  // Body A has outputs [scene, area]. Wire a downstream consumer to
  // each. Swap to body B with only [scene]. The edge from `area`
  // should drop; the edge from `scene` survives.
  const g = createGraph();
  const fe = addNode(g, 'core/for-each-point');
  const sink = addNode(g, 'core/perlin'); // any target node; only used as edge endpoint
  const bodyA = createEmptySubgraph('body-a', 'Body A');
  bodyA.outputs = [
    { name: 'scene', type: 'Scene' },
    { name: 'area', type: 'Float' },
  ];
  useEditorStore.setState({
    mainGraph: g, graph: g, currentEditingId: 'main',
    subgraphs: [bodyA], folders: [], undoStack: [], redoStack: [],
  });
  useEditorStore.getState().setForEachBody(fe.id, 'subgraph/body-a');
  addEdge(useEditorStore.getState().graph, { node: fe.id, socket: 'scene' }, { node: sink.id, socket: 'octaves' });
  addEdge(useEditorStore.getState().graph, { node: fe.id, socket: 'area' }, { node: sink.id, socket: 'octaves' });

  const bodyB = createEmptySubgraph('body-b', 'Body B');
  bodyB.outputs = [{ name: 'scene', type: 'Scene' }];
  useEditorStore.setState((s) => ({ subgraphs: [...s.subgraphs, bodyB] }));
  useEditorStore.getState().setForEachBody(fe.id, 'subgraph/body-b');

  const outgoing = useEditorStore.getState().graph.edges.filter((e) => e.from.node === fe.id);
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0]?.from.socket, 'scene');
});

test('setForEachBody: sets __body inputValue and mirrors body inputs', () => {
  const { feNodeId, bodyKind } = seed({
    bodyInputs: [
      { name: 'size', type: 'Float' },
      { name: 'colour', type: 'Vec3' },
      { name: 'texture', type: 'Texture2D' },
    ],
  });
  useEditorStore.getState().setForEachBody(feNodeId, bodyKind);
  const fe = nodeOf(feNodeId);
  assert.equal(fe?.inputValues?.__body, bodyKind);
  // Mirrored types: Float → FloatCloud, Vec3 → Vec3Cloud, everything
  // else broadcast as-is.
  assert.deepEqual(fe?.extraInputs, [
    { name: 'size', type: 'FloatCloud', optional: true },
    { name: 'colour', type: 'Vec3Cloud', optional: true },
    { name: 'texture', type: 'Texture2D', optional: true },
  ]);
});

test('setForEachBody: skips implicit __position / __index when mirroring', () => {
  const { feNodeId, bodyKind } = seed({
    bodyInputs: [
      { name: '__position', type: 'Vec3' },
      { name: '__index', type: 'Int' },
      { name: 'real', type: 'Float' },
    ],
  });
  useEditorStore.getState().setForEachBody(feNodeId, bodyKind);
  const fe = nodeOf(feNodeId);
  assert.deepEqual(fe?.extraInputs, [
    { name: 'real', type: 'FloatCloud', optional: true },
  ]);
});

test('setForEachBody: empty bodyKind clears extraInputs and __body', () => {
  const { feNodeId, bodyKind } = seed({ bodyInputs: [{ name: 'size', type: 'Float' }] });
  useEditorStore.getState().setForEachBody(feNodeId, bodyKind);
  assert.equal(nodeOf(feNodeId)?.extraInputs?.length, 1);
  useEditorStore.getState().setForEachBody(feNodeId, '');
  const fe = nodeOf(feNodeId);
  assert.equal(fe?.inputValues?.__body, '');
  assert.deepEqual(fe?.extraInputs, []);
});

test('setForEachBody: drops edges to extraInputs that vanish from the new mirror', () => {
  // Body originally has `size` + `colour`. We wire upstream → both.
  // Switching the body to one without `colour` drops that edge.
  const { feNodeId, bodyKind } = seed({
    bodyInputs: [
      { name: 'size', type: 'Float' },
      { name: 'colour', type: 'Vec3' },
    ],
    extraEdgeNames: ['size', 'colour'],
  });
  useEditorStore.getState().setForEachBody(feNodeId, bodyKind);
  // Sanity: both edges remain after the initial mirror.
  let edges = useEditorStore.getState().graph.edges
    .filter((e) => e.to.node === feNodeId);
  assert.equal(edges.length, 2);

  // Swap to a body without `colour`.
  const body2 = createEmptySubgraph('test-body-2', 'Test Body 2');
  body2.inputs = [{ name: 'size', type: 'Float' }];
  useEditorStore.setState((s) => ({ subgraphs: [...s.subgraphs, body2] }));

  useEditorStore.getState().setForEachBody(feNodeId, 'subgraph/test-body-2');
  edges = useEditorStore.getState().graph.edges.filter((e) => e.to.node === feNodeId);
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.to.socket, 'size');
});

test('setForEachBody: one undoable command — undo restores __body, extras, AND dropped edges', () => {
  const { feNodeId, bodyKind } = seed({
    bodyInputs: [{ name: 'size', type: 'Float' }],
    extraEdgeNames: ['size'], // pre-existing edge to a not-yet-mirrored socket
  });
  // Before: no extraInputs, no __body, but an edge points at `size`.
  // After: __body set, extras mirrored, edge SURVIVES (the name is in
  // the new mirror set). Undo: back to the original — extras gone,
  // edge restored.
  useEditorStore.getState().setForEachBody(feNodeId, bodyKind);
  const afterFe = nodeOf(feNodeId);
  assert.equal(afterFe?.inputValues?.__body, bodyKind);
  assert.equal(afterFe?.extraInputs?.length, 1);
  // Undo should rewind in ONE step (replaceGraph, not coalesced).
  useEditorStore.getState().undo();
  const undoneFe = nodeOf(feNodeId);
  assert.equal(undoneFe?.inputValues?.__body, undefined);
  assert.deepEqual(undoneFe?.extraInputs ?? [], []);
  // Edge should still be there post-undo (it was there before).
  const edges = useEditorStore.getState().graph.edges
    .filter((e) => e.to.node === feNodeId);
  assert.equal(edges.length, 1);
});
