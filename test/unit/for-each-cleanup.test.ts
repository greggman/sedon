// When a body subgraph is deleted, any `core/for-each-point` that
// references it via `__body` must auto-clear — without this the node
// holds a dead kind reference and the inspector renders a stale
// label. Wrapper instances (`kind === 'subgraph/<id>'`) are NOT
// touched by this cleanup; the long-standing behaviour is "leave the
// wrapper for the user to remove" and that doesn't change here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import {
  cleanupForEachBodyReferences,
  countBrokenRefs,
} from '../../src/editor/asset-ops.js';
import { createEmptySubgraph } from '../../src/core/subgraph.js';
import { useEditorStore } from '../../src/editor/store.js';

test('cleanupForEachBodyReferences: empty deleted-kind set is a no-op', () => {
  const g = createGraph();
  addNode(g, 'core/for-each-point', { inputValues: { __body: 'subgraph/drawer' } });
  const out = cleanupForEachBodyReferences(g, new Set());
  assert.equal(out, g, 'identity preserved when nothing was deleted');
});

test('cleanupForEachBodyReferences: leaves unrelated for-each-points alone', () => {
  const g = createGraph();
  addNode(g, 'core/for-each-point', { inputValues: { __body: 'subgraph/shelf' } });
  const out = cleanupForEachBodyReferences(g, new Set(['subgraph/drawer']));
  assert.equal(out, g);
});

test('cleanupForEachBodyReferences: clears __body and extraInputs on matching node', () => {
  const g = createGraph();
  const fe = addNode(g, 'core/for-each-point', {
    inputValues: { __body: 'subgraph/drawer', size: 1.5 },
    extraInputs: [
      { name: 'size', type: 'FloatCloud', optional: true },
      { name: 'colour', type: 'Vec3Cloud', optional: true },
    ],
  });
  const out = cleanupForEachBodyReferences(g, new Set(['subgraph/drawer']));
  const cleared = out.nodes.find((n) => n.id === fe.id);
  assert.equal(cleared?.inputValues?.__body, '');
  assert.deepEqual(cleared?.extraInputs, []);
  // Sibling inputValues that aren't __body are left alone (they have
  // no meaning once extraInputs is empty, but pruning the keys would
  // be lossy if the user later re-attaches the same body).
  assert.equal(cleared?.inputValues?.size, 1.5);
});

test('cleanupForEachBodyReferences: drops edges to vanished extra sockets, keeps edges to static sockets', () => {
  const g = createGraph();
  const src = addNode(g, 'core/perlin');
  const fe = addNode(g, 'core/for-each-point', {
    inputValues: { __body: 'subgraph/drawer' },
    extraInputs: [
      { name: 'size', type: 'FloatCloud', optional: true },
    ],
  });
  // Edge to a vanished extra socket — should drop.
  addEdge(g, { node: src.id, socket: 'texture' }, { node: fe.id, socket: 'size' });
  // Edge to the static `points` socket — should survive.
  addEdge(g, { node: src.id, socket: 'texture' }, { node: fe.id, socket: 'points' });
  const out = cleanupForEachBodyReferences(g, new Set(['subgraph/drawer']));
  const edgesIntoFe = out.edges.filter((e) => e.to.node === fe.id);
  assert.equal(edgesIntoFe.length, 1);
  assert.equal(edgesIntoFe[0]?.to.socket, 'points');
});

test('countBrokenRefs: includes for-each-point __body references in the count', () => {
  const g = createGraph();
  // One wrapper and one for-each-point both reference drawer.
  addNode(g, 'subgraph/drawer');
  addNode(g, 'core/for-each-point', { inputValues: { __body: 'subgraph/drawer' } });
  const count = countBrokenRefs(new Set(['drawer']), g, []);
  assert.equal(count.refs, 2);
  assert.equal(count.graphs, 1);
});

test('deleteAssets: clears matching for-each-point bodies end-to-end', () => {
  const drawer = createEmptySubgraph('drawer', 'Drawer');
  drawer.inputs = [{ name: 'size', type: 'Float' }];
  const main = createGraph();
  const fe = addNode(main, 'core/for-each-point', {
    inputValues: { __body: 'subgraph/drawer' },
    extraInputs: [{ name: 'size', type: 'FloatCloud', optional: true }],
  });
  useEditorStore.setState({
    mainGraph: main,
    graph: main,
    currentEditingId: 'main',
    subgraphs: [drawer],
    folders: [],
    undoStack: [],
    redoStack: [],
  });
  useEditorStore.getState().deleteAssets({ subgraphIds: ['drawer'], folderIds: [] });
  const after = useEditorStore.getState().graph.nodes.find((n) => n.id === fe.id);
  assert.equal(after?.inputValues?.__body, '');
  assert.deepEqual(after?.extraInputs, []);
  assert.equal(useEditorStore.getState().subgraphs.length, 0);
});
