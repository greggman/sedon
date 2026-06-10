// Dragging nodes used to write straight to `nodePositions` with no
// undo coverage — drop a node in the wrong spot and there was no path
// back. Position commits now push a `movePositions` command (its own
// undo entry, no coalescing) and undo/redo route around the graph
// state, swapping positions on the affected graph's slice only.
//
// These tests pin: (a) commit pushes one entry, (b) undo restores
// before-positions, (c) redo re-applies them, (d) no-op drags (sub-
// pixel jitter / drop at start) push nothing, (e) commits only carry
// the ids that actually moved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNode, createGraph } from '../../src/core/graph.js';
import { useEditorStore } from '../../src/editor/store.js';

function seedTwoNodes(): { aId: string; bId: string } {
  const g = createGraph();
  const a = addNode(g, 'tex/perlin', { position: { x: 100, y: 100 } });
  const b = addNode(g, 'tex/perlin', { position: { x: 200, y: 200 } });
  useEditorStore.setState({
    graph: g,
    mainGraph: g,
    rootNodeId: '__root__',
    currentEditingId: 'main',
    subgraphs: [],
    folders: [],
    undoStack: [],
    redoStack: [],
    nodePositions: { main: { [a.id]: { x: 100, y: 100 }, [b.id]: { x: 200, y: 200 } } },
  });
  return { aId: a.id, bId: b.id };
}

test('commitActivePositions: pushes ONE undo entry for a drag commit', () => {
  const { aId } = seedTwoNodes();
  const undoBefore = useEditorStore.getState().undoStack.length;
  useEditorStore.getState().commitActivePositions(new Map([[aId, { x: 500, y: 500 }]]));
  const undoAfter = useEditorStore.getState().undoStack.length;
  assert.equal(undoAfter - undoBefore, 1, 'one undo entry per drag commit');
  const top = useEditorStore.getState().undoStack.at(-1)!;
  assert.equal(top.kind, 'movePositions');
});

test('undo: a moved node returns to its pre-drag coordinates', () => {
  const { aId, bId } = seedTwoNodes();
  useEditorStore.getState().commitActivePositions(new Map([[aId, { x: 500, y: 500 }]]));
  // Move landed.
  assert.deepEqual(
    useEditorStore.getState().nodePositions.main![aId],
    { x: 500, y: 500 },
  );
  useEditorStore.getState().undo();
  assert.deepEqual(
    useEditorStore.getState().nodePositions.main![aId],
    { x: 100, y: 100 },
    'A back at origin after undo',
  );
  assert.deepEqual(
    useEditorStore.getState().nodePositions.main![bId],
    { x: 200, y: 200 },
    'B was never moved — unchanged',
  );
});

test('redo: a moved-then-undone node returns to its post-drag coordinates', () => {
  const { aId } = seedTwoNodes();
  useEditorStore.getState().commitActivePositions(new Map([[aId, { x: 500, y: 500 }]]));
  useEditorStore.getState().undo();
  useEditorStore.getState().redo();
  assert.deepEqual(
    useEditorStore.getState().nodePositions.main![aId],
    { x: 500, y: 500 },
    'A back at drop site after redo',
  );
});

test('multi-select drag: all dragged nodes restore together with one undo', () => {
  const { aId, bId } = seedTwoNodes();
  useEditorStore.getState().commitActivePositions(new Map([
    [aId, { x: 500, y: 500 }],
    [bId, { x: 600, y: 600 }],
  ]));
  useEditorStore.getState().undo();
  assert.deepEqual(useEditorStore.getState().nodePositions.main![aId], { x: 100, y: 100 });
  assert.deepEqual(useEditorStore.getState().nodePositions.main![bId], { x: 200, y: 200 });
});

test('no-op drag (drop at start) pushes nothing', () => {
  const { aId } = seedTwoNodes();
  const undoBefore = useEditorStore.getState().undoStack.length;
  useEditorStore.getState().commitActivePositions(new Map([[aId, { x: 100, y: 100 }]]));
  assert.equal(
    useEditorStore.getState().undoStack.length,
    undoBefore,
    'no entry when nothing actually moved',
  );
});

test('partial drag: nodes that did not move are NOT recorded — undo only restores the actual movers', () => {
  // ReactFlow's `onSelectionDragStop` reports ALL selected nodes, even
  // ones that didn't shift (e.g. when modifier keys lock an axis).
  // Recording the ones that DID move keeps the undo precise.
  const { aId, bId } = seedTwoNodes();
  useEditorStore.getState().commitActivePositions(new Map([
    [aId, { x: 500, y: 500 }], // moved
    [bId, { x: 200, y: 200 }], // didn't move
  ]));
  const top = useEditorStore.getState().undoStack.at(-1)!;
  assert.equal(top.kind, 'movePositions');
  if (top.kind !== 'movePositions') throw new Error('unreachable');
  assert.deepEqual(Object.keys(top.after).sort(), [aId].sort(), 'only A is in the after map');
  assert.equal(top.before[aId]?.x, 100);
});

test('marks the project dirty so Save picks up the new layout', () => {
  const { aId } = seedTwoNodes();
  useEditorStore.setState({ dirty: false });
  useEditorStore.getState().commitActivePositions(new Map([[aId, { x: 500, y: 500 }]]));
  assert.equal(useEditorStore.getState().dirty, true, 'drag commit dirties the project');
});
