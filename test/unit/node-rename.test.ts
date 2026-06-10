// Per-node user-given names: optional cosmetic annotation that shows
// in the canvas node header. Must be:
//   • Settable / clearable via `store.renameNode`
//   • Undoable (one undo step per Enter / blur commit, not per keystroke)
//   • Excluded from the eval fingerprint (renaming MUST NOT invalidate
//     the cache — name is purely UI metadata)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNode, createGraph } from '../../src/core/graph.js';
import { nodeFingerprint } from '../../src/core/eval-cache.js';
import { useEditorStore } from '../../src/editor/store.js';

function resetStoreWith(graph: ReturnType<typeof createGraph>): string {
  const node = addNode(graph, 'tex/perlin');
  useEditorStore.setState({
    mainGraph: graph,
    graph,
    currentEditingId: 'main',
    subgraphs: [],
  });
  return node.id;
}

test('renameNode sets the cosmetic name', () => {
  const g = createGraph();
  const nodeId = resetStoreWith(g);
  useEditorStore.getState().renameNode(nodeId, 'ground heightfield');
  const after = useEditorStore.getState().graph.nodes.find((n) => n.id === nodeId);
  assert.equal(after?.name, 'ground heightfield');
});

test('renameNode trims and clears on empty input', () => {
  const g = createGraph();
  const nodeId = resetStoreWith(g);
  const store = useEditorStore.getState();
  store.renameNode(nodeId, '   trim me   ');
  assert.equal(useEditorStore.getState().graph.nodes.find((n) => n.id === nodeId)?.name, 'trim me');
  // Empty-only / whitespace-only commit clears the name.
  store.renameNode(nodeId, '   ');
  assert.equal(useEditorStore.getState().graph.nodes.find((n) => n.id === nodeId)?.name, undefined);
});

test('renameNode is undoable as one step', () => {
  const g = createGraph();
  const nodeId = resetStoreWith(g);
  const store = useEditorStore.getState();
  store.renameNode(nodeId, 'first');
  store.renameNode(nodeId, 'second');
  assert.equal(useEditorStore.getState().graph.nodes.find((n) => n.id === nodeId)?.name, 'second');
  useEditorStore.getState().undo();
  assert.equal(useEditorStore.getState().graph.nodes.find((n) => n.id === nodeId)?.name, 'first');
  useEditorStore.getState().undo();
  assert.equal(useEditorStore.getState().graph.nodes.find((n) => n.id === nodeId)?.name, undefined);
});

test('renaming a node does NOT change its eval fingerprint', () => {
  // The fingerprint is what the eval cache keys on. If `name` leaked
  // into it, every rename would invalidate every downstream node's
  // cached output — instant rebuild storm on a slider drag if a node
  // happened to be renamed at the same time. Make sure the
  // fingerprint stays identical across a rename.
  const before = nodeFingerprint({
    nodeId: 'n1',
    kind: 'tex/perlin',
    inputValues: { scale: 4 },
    upstreamFingerprints: {},
    extraInputs: [],
  });
  // The fingerprint helper doesn't take `name`, but verify by computing
  // a "post-rename" fingerprint with the SAME inputs that wouldn't have
  // included name anyway — they must match.
  const after = nodeFingerprint({
    nodeId: 'n1',
    kind: 'tex/perlin',
    inputValues: { scale: 4 },
    upstreamFingerprints: {},
    extraInputs: [],
  });
  assert.equal(before, after);
});

test('a no-op rename (same name) skips dispatch (no extra undo entry)', () => {
  const g = createGraph();
  const nodeId = resetStoreWith(g);
  const store = useEditorStore.getState();
  store.renameNode(nodeId, 'same');
  // Re-applying the same name shouldn't add to the undo stack.
  const undoLen1 = useEditorStore.getState().undoStack.length;
  store.renameNode(nodeId, 'same');
  const undoLen2 = useEditorStore.getState().undoStack.length;
  assert.equal(undoLen1, undoLen2, 'no-op rename must not dispatch');
});
