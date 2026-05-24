// The user can edit a subgraph input's captured default from inside
// the subgraph itself (input-boundary row editor). The store action
// must:
//   • Update SubgraphDef.inputs[].default
//   • Invalidate the eval cache so a wrapper instance that wasn't
//     wired for that input now uses the new default
//   • Be undoable
//   • Skip the dispatch when the value is unchanged (no spurious
//     undo entries from idle slider-touch)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useEditorStore } from '../../src/editor/store.js';
import {
  createEmptySubgraph,
  type SubgraphDef,
} from '../../src/core/subgraph.js';
import { addNode } from '../../src/core/graph.js';

function seedProject(): { sg: SubgraphDef; inputName: string } {
  const sg = createEmptySubgraph('test-sg', 'Test SG');
  // Add an input the user might later want to edit the default for.
  sg.inputs.push({
    name: 'color-input',
    type: 'Color',
    label: 'colour',
    default: [0.18, 0.36, 0.16, 1] as const,
  });
  // Put a wrapper of it in main so we can check it observes the new default.
  const main = useEditorStore.getState().mainGraph;
  addNode(main, `subgraph/${sg.id}`);
  useEditorStore.setState({
    subgraphs: [sg],
    mainGraph: main,
    graph: main,
    currentEditingId: 'main',
  });
  return { sg, inputName: 'color-input' };
}

test('setSubgraphInputDefault updates the def', () => {
  const { sg, inputName } = seedProject();
  useEditorStore.getState().setSubgraphInputDefault(sg.id, inputName, [1, 0, 0, 1]);
  const after = useEditorStore.getState().subgraphs.find((s) => s.id === sg.id);
  assert.deepEqual(after?.inputs.find((i) => i.name === inputName)?.default, [1, 0, 0, 1]);
});

test('setSubgraphInputDefault is undoable', () => {
  const { sg, inputName } = seedProject();
  const before = useEditorStore.getState().subgraphs.find((s) => s.id === sg.id)
    ?.inputs.find((i) => i.name === inputName)?.default;
  useEditorStore.getState().setSubgraphInputDefault(sg.id, inputName, [1, 0, 0, 1]);
  useEditorStore.getState().undo();
  const restored = useEditorStore.getState().subgraphs.find((s) => s.id === sg.id)
    ?.inputs.find((i) => i.name === inputName)?.default;
  assert.deepEqual(restored, before);
});

test('setSubgraphInputDefault on an unchanged value is a no-op', () => {
  const { sg, inputName } = seedProject();
  const before = useEditorStore.getState().subgraphs.find((s) => s.id === sg.id)
    ?.inputs.find((i) => i.name === inputName)?.default;
  const undoLenBefore = useEditorStore.getState().undoStack.length;
  useEditorStore.getState().setSubgraphInputDefault(sg.id, inputName, before);
  const undoLenAfter = useEditorStore.getState().undoStack.length;
  assert.equal(undoLenBefore, undoLenAfter, 'no dispatch on unchanged');
});

test('setSubgraphInputDefault on an unknown input is a no-op', () => {
  const { sg } = seedProject();
  const undoLenBefore = useEditorStore.getState().undoStack.length;
  useEditorStore.getState().setSubgraphInputDefault(sg.id, 'not-a-real-input', [1, 0, 0, 1]);
  const undoLenAfter = useEditorStore.getState().undoStack.length;
  assert.equal(undoLenBefore, undoLenAfter);
});

test('setSubgraphInputDefault on an unknown subgraph is a no-op', () => {
  seedProject();
  const undoLenBefore = useEditorStore.getState().undoStack.length;
  useEditorStore.getState().setSubgraphInputDefault('does-not-exist', 'color-input', [1, 0, 0, 1]);
  const undoLenAfter = useEditorStore.getState().undoStack.length;
  assert.equal(undoLenBefore, undoLenAfter);
});
