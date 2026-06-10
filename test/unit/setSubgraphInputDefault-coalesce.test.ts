// `setSubgraphInputDefault` goes through `dispatchProject` (a
// project-scoped change because it edits `SubgraphDef.inputs`). The
// matching coalescing path lives in `dispatchProject` itself —
// consecutive `replaceProject` commands sharing a `coalesceKey`
// merge into one undo entry, the same way `setInputValue` already
// did for node-scoped scrubs.
//
// Regression context: scrubbing a number field on a
// `subgraph-input/<id>` boundary node (e.g. "num_floors" on the
// fire-escape-assembled subgraph) used to push one full-project
// undo step per pixel of drag, so a single drag would bury hundreds
// of intermediate states in the history. This test pins the new
// coalescing rule so that doesn't come back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SubgraphDef } from '../../src/core/subgraph.js';
import { createGraph } from '../../src/core/graph.js';
import { useEditorStore } from '../../src/editor/store.js';

function resetStoreWith(): { subgraphId: string; inputName: string } {
  const subgraphId = 'sg-test';
  const inputName = 'num_floors';
  const sg: SubgraphDef = {
    id: subgraphId,
    label: 'test',
    category: 'Subgraphs',
    inputs: [{ name: inputName, type: 'Float', default: 7 }],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: createGraph(),
    inputNodeId: 'in',
    outputNodeId: 'out',
  };
  useEditorStore.setState({
    mainGraph: createGraph(),
    graph: createGraph(),
    currentEditingId: 'main',
    subgraphs: [sg],
    undoStack: [],
    redoStack: [],
  });
  return { subgraphId, inputName };
}

function currentDefault(subgraphId: string, inputName: string): unknown {
  const sg = useEditorStore
    .getState()
    .subgraphs.find((s) => s.id === subgraphId);
  return sg?.inputs.find((i) => i.name === inputName)?.default;
}

test('consecutive setSubgraphInputDefault on same (subgraphId, inputName) coalesce into one undo entry', () => {
  const { subgraphId, inputName } = resetStoreWith();
  const s = useEditorStore.getState();
  s.setSubgraphInputDefault(subgraphId, inputName, 8);
  s.setSubgraphInputDefault(subgraphId, inputName, 9);
  s.setSubgraphInputDefault(subgraphId, inputName, 10);
  assert.equal(useEditorStore.getState().undoStack.length, 1);
  assert.equal(currentDefault(subgraphId, inputName), 10);
  useEditorStore.getState().undo();
  // Undo should land on the value BEFORE the scrub started.
  assert.equal(currentDefault(subgraphId, inputName), 7);
});

test('coalesce:false marks each setSubgraphInputDefault call as its own undo entry', () => {
  const { subgraphId, inputName } = resetStoreWith();
  const s = useEditorStore.getState();
  s.setSubgraphInputDefault(subgraphId, inputName, 8,  { coalesce: false });
  s.setSubgraphInputDefault(subgraphId, inputName, 9,  { coalesce: false });
  s.setSubgraphInputDefault(subgraphId, inputName, 10, { coalesce: false });
  assert.equal(useEditorStore.getState().undoStack.length, 3);
  useEditorStore.getState().undo();
  assert.equal(currentDefault(subgraphId, inputName), 9);
  useEditorStore.getState().undo();
  assert.equal(currentDefault(subgraphId, inputName), 8);
});

test('setSubgraphInputDefault on a DIFFERENT input acts as a barrier', () => {
  // Coalescing must be keyed on BOTH subgraphId and inputName, so
  // editing input A then input B then input A should give three
  // entries, not one merged blob.
  const { subgraphId } = resetStoreWith();
  // Add a second input to the same subgraph.
  useEditorStore.setState({
    subgraphs: [{
      ...useEditorStore.getState().subgraphs[0]!,
      inputs: [
        { name: 'num_floors', type: 'Float', default: 7 },
        { name: 'floor_height', type: 'Float', default: 3.5 },
      ],
    }],
  });
  const s = useEditorStore.getState();
  s.setSubgraphInputDefault(subgraphId, 'num_floors',   8);
  s.setSubgraphInputDefault(subgraphId, 'floor_height', 4);
  s.setSubgraphInputDefault(subgraphId, 'num_floors',   9);
  assert.equal(useEditorStore.getState().undoStack.length, 3);
});

test('a non-coalescing setSubgraphInputDefault is a barrier for the NEXT scrub', () => {
  const { subgraphId, inputName } = resetStoreWith();
  const s = useEditorStore.getState();
  s.setSubgraphInputDefault(subgraphId, inputName, 8);                          // entry A (coalesce-enabled)
  s.setSubgraphInputDefault(subgraphId, inputName, 9, { coalesce: false });     // entry B (barrier)
  s.setSubgraphInputDefault(subgraphId, inputName, 10);                         // entry C (cannot merge with B)
  assert.equal(useEditorStore.getState().undoStack.length, 3);
});

test('typed commits (coalesce:false) stay discrete, scrubs that follow them coalesce normally', () => {
  // The canonical UX flow on a number widget:
  //   • User types 456 ⏎  (typed → coalesce: false → entry A)
  //   • User types 789 ⏎  (typed → coalesce: false → entry B, NOT merged with A)
  //   • User drags from 789 to 1100 across many pixels
  //     (scrub → coalesce default → entry C, all the pixel updates
  //      collapsed into one)
  // After:  undo → 789, undo → 456, undo → 7 (original).
  const { subgraphId, inputName } = resetStoreWith();
  const s = useEditorStore.getState();
  s.setSubgraphInputDefault(subgraphId, inputName, 456, { coalesce: false });
  s.setSubgraphInputDefault(subgraphId, inputName, 789, { coalesce: false });
  // Now simulate a scrub that fires per-pixel updates.
  for (let v = 790; v <= 1100; v++) {
    s.setSubgraphInputDefault(subgraphId, inputName, v);
  }
  assert.equal(useEditorStore.getState().undoStack.length, 3, 'expected three undo entries: typed 456, typed 789, scrub 790→1100');
  assert.equal(currentDefault(subgraphId, inputName), 1100);
  useEditorStore.getState().undo();
  assert.equal(currentDefault(subgraphId, inputName), 789, 'undo from scrub lands on the value before the scrub started');
  useEditorStore.getState().undo();
  assert.equal(currentDefault(subgraphId, inputName), 456, 'undo from typed 789 lands on typed 456');
  useEditorStore.getState().undo();
  assert.equal(currentDefault(subgraphId, inputName), 7, 'undo from typed 456 lands on the original default');
});
