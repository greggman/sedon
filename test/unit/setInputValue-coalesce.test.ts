// dispatchProject coalesces consecutive setInputValue commands on the
// same (nodeId, name) so NumberInput drag-scrubbing (one command per
// pixel) collapses into one undo entry. Widgets that commit on
// discrete user actions (point-list add / drag-end / paste / delete)
// pass `{ coalesce: false }` to opt out — each becomes its own undo
// step, and a non-coalescing command also acts as a barrier preventing
// the NEXT command from merging into it.
//
// Regression context: the point-list editor briefly shipped without
// opt-out, so an entire editor session's worth of edits collapsed
// into one undo entry — pressing undo once rewound past every
// add/drag/paste back to before the editor was opened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNode, createGraph } from '../../src/core/graph.js';
import { useEditorStore } from '../../src/editor/store.js';

function resetStoreWith(): string {
  const g = createGraph();
  const node = addNode(g, 'core/perlin');
  useEditorStore.setState({
    mainGraph: g,
    graph: g,
    currentEditingId: 'main',
    subgraphs: [],
    undoStack: [],
    redoStack: [],
  });
  return node.id;
}

test('consecutive setInputValue on same socket coalesce into one undo entry', () => {
  const id = resetStoreWith();
  const s = useEditorStore.getState();
  s.setInputValue(id, 'octaves', 2);
  s.setInputValue(id, 'octaves', 3);
  s.setInputValue(id, 'octaves', 4);
  // All three merged into the same entry. Undo once → back to original.
  assert.equal(useEditorStore.getState().undoStack.length, 1);
  useEditorStore.getState().undo();
  const after = useEditorStore.getState().graph.nodes.find((n) => n.id === id);
  // Original `octaves` was unset (uses InputDef default); undo restores undefined.
  assert.equal(after?.inputValues?.octaves, undefined);
});

test('coalesce:false marks each command as its own undo entry', () => {
  const id = resetStoreWith();
  const s = useEditorStore.getState();
  s.setInputValue(id, 'octaves', 2, { coalesce: false });
  s.setInputValue(id, 'octaves', 3, { coalesce: false });
  s.setInputValue(id, 'octaves', 4, { coalesce: false });
  assert.equal(useEditorStore.getState().undoStack.length, 3);
  // Each undo rewinds exactly one step.
  useEditorStore.getState().undo();
  assert.equal(
    useEditorStore.getState().graph.nodes.find((n) => n.id === id)?.inputValues?.octaves,
    3,
  );
  useEditorStore.getState().undo();
  assert.equal(
    useEditorStore.getState().graph.nodes.find((n) => n.id === id)?.inputValues?.octaves,
    2,
  );
});

test('coalesce:false acts as a barrier for the NEXT command', () => {
  // A regular coalescing setInputValue followed by a non-coalescing
  // one, then another regular one. The second regular one must NOT
  // merge into the non-coalescing entry — otherwise the barrier
  // semantics aren't preserved.
  const id = resetStoreWith();
  const s = useEditorStore.getState();
  s.setInputValue(id, 'octaves', 2);                          // entry A
  s.setInputValue(id, 'octaves', 3, { coalesce: false });     // entry B (no merge with A)
  s.setInputValue(id, 'octaves', 4);                          // entry C (no merge with B)
  assert.equal(useEditorStore.getState().undoStack.length, 3);
});
