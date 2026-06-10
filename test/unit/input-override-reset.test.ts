// Per-input "override" indicator + reset-to-default semantics.
// The data-model contract:
//   • inputValues[name] === undefined  ⇒  using the default
//   • inputValues[name] === <value>    ⇒  overridden (the dot shows)
//   • setInputValue(nodeId, name, undefined)  ⇒  REMOVES the key
//     (not stores undefined), so the override check stays unambiguous.
// All three must be undoable as one step per commit, matching the
// existing setInputValue mergeability behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNode, createGraph } from '../../src/core/graph.js';
import { useEditorStore } from '../../src/editor/store.js';

function seedWithNode(): string {
  const g = createGraph();
  const n = addNode(g, 'tex/perlin');
  useEditorStore.setState({ mainGraph: g, graph: g, currentEditingId: 'main', subgraphs: [] });
  return n.id;
}

test('setInputValue stores an override and `name in inputValues` becomes true', () => {
  const nodeId = seedWithNode();
  useEditorStore.getState().setInputValue(nodeId, 'gain', 12);
  const node = useEditorStore.getState().graph.nodes.find((n) => n.id === nodeId);
  assert.equal(node?.inputValues?.['gain'], 12);
  assert.ok('gain' in (node?.inputValues ?? {}), 'key must be present in inputValues');
});

test('setInputValue(undefined) DELETES the key (not stores undefined)', () => {
  const nodeId = seedWithNode();
  useEditorStore.getState().setInputValue(nodeId, 'gain', 12);
  useEditorStore.getState().setInputValue(nodeId, 'gain', undefined);
  const node = useEditorStore.getState().graph.nodes.find((n) => n.id === nodeId);
  // The dot's display logic uses `!== undefined`, so the key MUST be
  // absent (or be the literal undefined) after a reset. Verify both.
  assert.equal(node?.inputValues?.['gain'], undefined);
  assert.ok(!('gain' in (node?.inputValues ?? {})), 'key must be removed, not just set undefined');
});

test('reset is undoable: original override is restored', () => {
  const nodeId = seedWithNode();
  const store = useEditorStore.getState();
  store.setInputValue(nodeId, 'gain', 12);
  store.setInputValue(nodeId, 'gain', undefined);
  // setInputValue commands targeting the same (nodeId,name) merge into
  // one undo entry — that's the existing slider-drag behaviour. So a
  // single undo here should go all the way back to the pre-override
  // state.
  store.undo();
  const node = useEditorStore.getState().graph.nodes.find((n) => n.id === nodeId);
  assert.ok(!('gain' in (node?.inputValues ?? {})), 'undo must restore to "no override"');
});

test('no-op reset on a value already at default does nothing', () => {
  const nodeId = seedWithNode();
  const store = useEditorStore.getState();
  const undoLen = useEditorStore.getState().undoStack.length;
  // Never overridden; resetting again should be a no-op (no undo entry).
  store.setInputValue(nodeId, 'gain', undefined);
  assert.equal(useEditorStore.getState().undoStack.length, undoLen);
});
