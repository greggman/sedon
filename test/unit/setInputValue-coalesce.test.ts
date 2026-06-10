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

test('two consecutive scrubs separated by markUndoBarrier() produce TWO undo entries (the bug the user hit)', () => {
  // Two pointer-down → drag → pointer-up cycles on the same socket
  // with NO commands in between. Without a barrier the second
  // scrub's first pixel coalesces with the first scrub's last
  // pixel (same socket, both coalesce-true), so a single undo
  // rewinds past BOTH scrubs straight to the original value.
  // markUndoBarrier() — invoked by NumberInput on pointer-up after
  // a drag — is what makes the second scrub start a fresh undo
  // entry instead of merging.
  const id = resetStoreWith();
  const s = useEditorStore.getState();
  // Scrub 1: 0 → 222 → 333
  s.setInputValue(id, 'octaves', 222);
  s.setInputValue(id, 'octaves', 333);
  // Pointer-up after the drag.
  s.markUndoBarrier();
  // Scrub 2: 333 → 444 → 555
  s.setInputValue(id, 'octaves', 444);
  s.setInputValue(id, 'octaves', 555);
  assert.equal(useEditorStore.getState().undoStack.length, 2, 'two scrubs separated by a barrier produce two undo entries');
  useEditorStore.getState().undo();
  assert.equal(
    useEditorStore.getState().graph.nodes.find((n) => n.id === id)?.inputValues?.octaves,
    333,
    'first undo rewinds scrub 2, lands on 333 (end of scrub 1)',
  );
  useEditorStore.getState().undo();
  assert.equal(
    useEditorStore.getState().graph.nodes.find((n) => n.id === id)?.inputValues?.octaves,
    undefined,
    'second undo rewinds scrub 1, lands on the InputDef default (octaves was unset)',
  );
});

test('markUndoBarrier is single-use: only blocks the next dispatch, not all subsequent ones', () => {
  // After consuming the flag, subsequent commands coalesce normally
  // (so a scrub after the barrier still produces one merged entry,
  // not N micro-entries).
  const id = resetStoreWith();
  const s = useEditorStore.getState();
  s.setInputValue(id, 'octaves', 100);
  s.markUndoBarrier();
  s.setInputValue(id, 'octaves', 200);  // barrier consumed → new entry
  s.setInputValue(id, 'octaves', 300);  // no barrier → merges with 200
  s.setInputValue(id, 'octaves', 400);  // still merges
  assert.equal(useEditorStore.getState().undoStack.length, 2);
});

test('markUndoBarrier without a following dispatch is harmless (no entry pushed)', () => {
  const id = resetStoreWith();
  const s = useEditorStore.getState();
  s.setInputValue(id, 'octaves', 100);
  const stackLen = useEditorStore.getState().undoStack.length;
  s.markUndoBarrier();
  // No new dispatch — stack unchanged.
  assert.equal(useEditorStore.getState().undoStack.length, stackLen);
  assert.equal(useEditorStore.getState().undoBarrierPending, true);
});

test('typed commits stay discrete, scrubs that follow coalesce normally (mirrors NumberInput UX)', () => {
  // NumberInput typed-commit path passes `coalesce: false` so each
  // Enter/Tab/blur is its own undo step (you can step BACK through
  // typed values), while drag-scrub uses the default coalescing so
  // the per-pixel updates merge into one undo entry per
  // pointer-down → pointer-up cycle.
  //
  // Regression context: the typed path was inheriting the default
  // coalesce behaviour, so two consecutive typed commits would
  // merge into one entry — undoing from "789" jumped straight back
  // to the pre-456 value, skipping past 456 entirely.
  const id = resetStoreWith();
  const s = useEditorStore.getState();
  s.setInputValue(id, 'octaves', 456, { coalesce: false });   // typed entry A
  s.setInputValue(id, 'octaves', 789, { coalesce: false });   // typed entry B (NOT merged with A)
  // Now a scrub: many per-pixel calls that should all collapse.
  for (let v = 790; v <= 1100; v++) {
    s.setInputValue(id, 'octaves', v);
  }
  assert.equal(useEditorStore.getState().undoStack.length, 3);
  useEditorStore.getState().undo();
  assert.equal(
    useEditorStore.getState().graph.nodes.find((n) => n.id === id)?.inputValues?.octaves,
    789,
    'undo from scrub lands on typed 789',
  );
  useEditorStore.getState().undo();
  assert.equal(
    useEditorStore.getState().graph.nodes.find((n) => n.id === id)?.inputValues?.octaves,
    456,
    'undo from typed 789 lands on typed 456',
  );
});
