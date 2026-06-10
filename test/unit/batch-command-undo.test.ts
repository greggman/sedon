// `batch` is a Command-union variant that groups multiple graph-scoped
// sub-commands so the user sees one undo entry instead of N. The
// motivating case: deleting a node with connections used to dispatch
// `removeEdges` then `removeNodes`, leaving the user to press Cmd-Z
// twice to restore both. ReactFlow now reports the full delete set
// through `onDelete`, and the store routes it through the new
// `removeNodesAndEdges` action which builds the batch.
//
// These tests cover the primitive directly (apply/undo round-trip on
// nested batches) AND the high-level `removeNodesAndEdges` action.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNode, addEdge, createGraph } from '../../src/core/graph.js';
import { applyBackward, applyForward, type Command, type GraphState } from '../../src/editor/command.js';
import { useEditorStore } from '../../src/editor/store.js';

function seedTwoConnectedNodes(): { nodeAId: string; nodeBId: string; edgeId: string } {
  const g = createGraph();
  const a = addNode(g, 'tex/perlin');
  const b = addNode(g, 'tex/perlin');
  // Use a stable, real-looking output socket id from tex/perlin so
  // the connect doesn't have to invent anything implausible. The edge
  // identity is what these tests care about — sockets are just labels.
  const e = addEdge(g, { node: a.id, socket: 'value' }, { node: b.id, socket: 'evaluator' });
  useEditorStore.setState({
    graph: g,
    mainGraph: g,
    rootNodeId: '__root__',
    currentEditingId: 'main',
    subgraphs: [],
    folders: [],
    undoStack: [],
    redoStack: [],
  });
  return { nodeAId: a.id, nodeBId: b.id, edgeId: e.id };
}

test('applyForward(batch) threads state through sub-commands in declaration order', () => {
  const g = createGraph();
  const a = addNode(g, 'tex/perlin');
  const b = addNode(g, 'tex/perlin');
  const e = addEdge(g, { node: a.id, socket: 'value' }, { node: b.id, socket: 'evaluator' });
  const before: GraphState = { graph: g, rootNodeId: 'x' };
  const batch: Command = {
    kind: 'batch',
    commands: [
      { kind: 'removeEdges', edges: [e] },
      { kind: 'removeNodes', nodes: [a], edges: [], prevRootNodeId: 'x' },
    ],
  };
  const after = applyForward(before, batch);
  assert.equal(after.graph.edges.length, 0, 'edge removed');
  assert.equal(after.graph.nodes.length, 1, 'one node removed, one remains');
  assert.equal(after.graph.nodes[0]!.id, b.id, 'kept the right node');
});

test('applyBackward(batch) restores everything as a single step', () => {
  const g = createGraph();
  const a = addNode(g, 'tex/perlin');
  const b = addNode(g, 'tex/perlin');
  const e = addEdge(g, { node: a.id, socket: 'value' }, { node: b.id, socket: 'evaluator' });
  const before: GraphState = { graph: g, rootNodeId: 'x' };
  const batch: Command = {
    kind: 'batch',
    commands: [
      { kind: 'removeEdges', edges: [e] },
      { kind: 'removeNodes', nodes: [a], edges: [], prevRootNodeId: 'x' },
    ],
  };
  const forward = applyForward(before, batch);
  const restored = applyBackward(forward, batch);
  assert.equal(restored.graph.nodes.length, 2, 'both nodes restored');
  assert.equal(restored.graph.edges.length, 1, 'edge restored');
  assert.equal(restored.graph.edges[0]!.id, e.id, 'edge restored by id');
  assert.equal(restored.rootNodeId, 'x', 'rootNodeId restored');
});

test('batches nest: an inner batch can sit inside an outer batch and undo cleanly', () => {
  const g = createGraph();
  const a = addNode(g, 'tex/perlin');
  const b = addNode(g, 'tex/perlin');
  const c = addNode(g, 'tex/perlin');
  const e1 = addEdge(g, { node: a.id, socket: 'value' }, { node: b.id, socket: 'evaluator' });
  const e2 = addEdge(g, { node: b.id, socket: 'value' }, { node: c.id, socket: 'evaluator' });
  const before: GraphState = { graph: g, rootNodeId: 'x' };
  const outer: Command = {
    kind: 'batch',
    commands: [
      {
        kind: 'batch',
        commands: [
          { kind: 'removeEdges', edges: [e1] },
          { kind: 'removeNodes', nodes: [a], edges: [], prevRootNodeId: 'x' },
        ],
      },
      {
        kind: 'batch',
        commands: [
          { kind: 'removeEdges', edges: [e2] },
          { kind: 'removeNodes', nodes: [c], edges: [], prevRootNodeId: 'x' },
        ],
      },
    ],
  };
  const after = applyForward(before, outer);
  assert.equal(after.graph.nodes.length, 1, 'only b remains');
  assert.equal(after.graph.nodes[0]!.id, b.id);
  const restored = applyBackward(after, outer);
  assert.equal(restored.graph.nodes.length, 3, 'all three nodes back');
  assert.equal(restored.graph.edges.length, 2, 'both edges back');
});

test('removeNodesAndEdges: deleting a node with its connections is ONE undo entry', () => {
  const seed = seedTwoConnectedNodes();
  const undoBefore = useEditorStore.getState().undoStack.length;
  useEditorStore.getState().removeNodesAndEdges(
    new Set([seed.nodeAId]),
    new Set([seed.edgeId]),
  );
  const undoAfter = useEditorStore.getState().undoStack.length;
  assert.equal(undoAfter - undoBefore, 1, 'exactly one undo entry');

  const graph = useEditorStore.getState().graph;
  assert.equal(graph.nodes.length, 1, 'node A removed, B remains');
  assert.equal(graph.edges.length, 0, 'edge removed');

  // Single undo restores BOTH.
  useEditorStore.getState().undo();
  const restored = useEditorStore.getState().graph;
  assert.equal(restored.nodes.length, 2, 'both nodes restored by one undo');
  assert.equal(restored.edges.length, 1, 'edge restored by the same undo');
});

test('removeNodesAndEdges: redo replays both halves of the batch in one step', () => {
  const seed = seedTwoConnectedNodes();
  useEditorStore.getState().removeNodesAndEdges(
    new Set([seed.nodeAId]),
    new Set([seed.edgeId]),
  );
  useEditorStore.getState().undo();
  useEditorStore.getState().redo();
  const after = useEditorStore.getState().graph;
  assert.equal(after.nodes.length, 1, 'node removed again after redo');
  assert.equal(after.edges.length, 0, 'edge gone again after redo');
});

test('removeNodesAndEdges: node-only selection (no extra edges) skips the batch wrapper', () => {
  // When there are no "loose" edges (edges not attached to a removed
  // node), the action unwraps to a plain `removeNodes` command — keeps
  // undo entries minimal in the common case where Delete on a node
  // also wipes its connections via auto-cascade.
  const seed = seedTwoConnectedNodes();
  // Don't list the edge separately; just delete the node — the action
  // should pick up the connected edge by itself, but as part of the
  // single `removeNodes` command, not a batch wrapper.
  useEditorStore.getState().removeNodesAndEdges(new Set([seed.nodeAId]), new Set());
  const stack = useEditorStore.getState().undoStack;
  const last = stack[stack.length - 1]!;
  assert.equal(last.kind, 'removeNodes', 'unwraps to a plain removeNodes when no loose edges');
  // The connected edge is still gone, recorded inside removeNodes.edges:
  const graph = useEditorStore.getState().graph;
  assert.equal(graph.edges.length, 0, 'connected edge was cleaned up');
  // And single undo restores both.
  useEditorStore.getState().undo();
  assert.equal(useEditorStore.getState().graph.nodes.length, 2);
  assert.equal(useEditorStore.getState().graph.edges.length, 1);
});
