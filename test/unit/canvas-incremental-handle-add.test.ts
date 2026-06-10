// Regression: when a store action atomically (a) grows an existing
// node's handle set and (b) adds an edge to the new handle, the
// canvas sync used to land the new edge BEFORE the new handle was
// measured — ReactFlow logged error 008 "Couldn't create edge for
// target handle id". Caught by replaying a real bug-repro recording
// against the editor with this sequence in it.
//
// Repro (user-provided .sedon-rec): drop a second iter/for-each-point
// onto the for-each-point demo, wire grid + materials, then click +
// drag-onto the scene-merge node's "+ Add Input" handle to make a
// new `scene_N` socket and wire fep.scene → that new socket in one
// atomic store call. `addNodeExtraInputWithEdge` is the single store
// action that produces the (new handle + new edge) pair.
//
// Headless-only because the bug is a React/RF render-batching race
// on the editor canvas itself; node-test can verify the underlying
// store action produces a consistent graph (which it always did),
// but the visible symptom only manifests in a browser. The matching
// fix lives in src/editor/node-canvas.tsx (incremental path now
// routes through the same two-phase pendingEdgeSync the swap path
// uses).
//
// What this test asserts at the store layer: after
// addNodeExtraInputWithEdge, the target node has a new extraInput
// AND a new edge whose target.socket matches that extraInput's name.
// That's the invariant the canvas-sync code relies on; the React/RF
// fix is about WHEN React sees the new state, not WHAT the state is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNode, createGraph } from '../../src/core/graph.js';
import { useEditorStore } from '../../src/editor/store.js';

test('addNodeExtraInputWithEdge produces a new extraInput AND a matching incoming edge in one atomic update', () => {
  // poly/list still uses the older extraInputsSpec pattern (no static
  // base inputs, `polygon_<k>` extras). scene/merge migrated to a
  // single multi-fan-in socket — addNodeExtraInputWithEdge is a no-op
  // there, so we exercise the path on a node that still grows extras.
  const main = createGraph();
  const sourcePoly = addNode(main, 'poly/from-points', { id: 'src' });
  const polyList = addNode(main, 'poly/list', { id: 'list' });
  useEditorStore.setState({
    mainGraph: main,
    graph: main,
    currentEditingId: 'main',
    subgraphs: [],
    folders: [],
    undoStack: [],
    redoStack: [],
  });

  const baseInputCount = 0; // poly/list has no static base inputs
  useEditorStore.getState().addNodeExtraInputWithEdge(
    polyList.id,
    'Polygon',
    'polygon',
    baseInputCount,
    { node: sourcePoly.id, socket: 'polygon' },
  );

  const state = useEditorStore.getState();
  const updated = state.graph.nodes.find((n) => n.id === polyList.id)!;
  // Fresh node had no extras; one new appended.
  assert.equal(updated.extraInputs?.length, 1);
  const newExtra = updated.extraInputs![0]!;
  assert.equal(newExtra.type, 'Polygon');
  assert.equal(newExtra.name, 'polygon_0');

  // The edge added in the same call must reference the new socket by
  // name. If this asserted false, the canvas would receive an edge
  // whose target.socket has no matching node-handle — the exact
  // misalignment that triggered the ReactFlow error.
  const incoming = state.graph.edges.filter((e) => e.to.node === polyList.id);
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0]!.to.socket, 'polygon_0');
  assert.equal(incoming[0]!.from.node, sourcePoly.id);
});
