// Regression tests for subgraph socket creation + rename. The bug
// these guard against: when the user renames a socket, RF's
// `EdgeWrapper` looks up handle ids in DOM measurements that are
// re-registered asynchronously after handle remount, so changing the
// handle id (= socket name) on rename produces a one-frame window
// where the edge can't find its target. The fix is to keep the
// stable handle id (`name`, a UUID for new sockets) untouched and
// only rename the user-facing `label`. These tests lock that in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNode } from '../../src/core/graph.js';
import { createEmptySubgraph } from '../../src/core/subgraph.js';
import { useEditorStore } from '../../src/editor/store.js';

test('addSubgraphSocketWithEdge generates a stable UUID name and an "untitled" label', () => {
  const store = useEditorStore.getState();

  const sg = createEmptySubgraph('add-sg', 'add sg');
  const worley = addNode(sg.graph, 'core/worley', { position: { x: 0, y: 0 } });
  useEditorStore.setState({
    subgraphs: [sg],
    currentEditingId: sg.id,
    graph: sg.graph,
  });

  store.addSubgraphSocketWithEdge(sg.id, 'output', 'Texture2D', {
    node: worley.id,
    socket: 'cells',
  });
  let updated = useEditorStore.getState().subgraphs.find((s) => s.id === sg.id)!;
  assert.equal(updated.outputs.length, 1);
  assert.equal(updated.outputs[0]!.label, 'untitled', 'first drag labels "untitled"');
  assert.equal(updated.outputs[0]!.type, 'Texture2D');
  assert.match(
    updated.outputs[0]!.name,
    /^[0-9a-f-]{36}$/,
    'name is a UUID, not derived from the user-visible label',
  );
  // The edge must reference the stable name (not the label), since
  // that is what becomes the React Flow handle id.
  const firstEdge = updated.graph.edges.at(-1)!;
  assert.equal(firstEdge.to.socket, updated.outputs[0]!.name);

  // Second drag — label dedupes to "untitled-2", name is a fresh UUID.
  store.addSubgraphSocketWithEdge(sg.id, 'output', 'Texture2D', {
    node: worley.id,
    socket: 'cells',
  });
  updated = useEditorStore.getState().subgraphs.find((s) => s.id === sg.id)!;
  assert.deepEqual(
    updated.outputs.map((o) => o.label),
    ['untitled', 'untitled-2'],
    'second drag dedupes the label to "untitled-2"',
  );
  assert.notEqual(updated.outputs[0]!.name, updated.outputs[1]!.name, 'names are unique UUIDs');
});

test('rename updates the label but leaves the stable name (and thus every edge) untouched', () => {
  const store = useEditorStore.getState();

  // Reproduces the user-reported flow: new subgraph → worley → drag
  // output to "+ Add output" → rename "untitled" to "foo".
  const sg = createEmptySubgraph('flow-sg', 'flow sg');
  const worley = addNode(sg.graph, 'core/worley', { position: { x: 0, y: 0 } });
  useEditorStore.setState({
    subgraphs: [sg],
    currentEditingId: sg.id,
    graph: sg.graph,
  });

  store.addSubgraphSocketWithEdge(sg.id, 'output', 'Texture2D', {
    node: worley.id,
    socket: 'cells',
  });
  const created = useEditorStore.getState().subgraphs.find((s) => s.id === sg.id)!;
  const stableName = created.outputs[0]!.name;
  const edgeBefore = created.graph.edges.at(-1)!;

  store.renameSubgraphSocket(sg.id, 'output', stableName, 'foo');

  const final = useEditorStore.getState().subgraphs.find((s) => s.id === sg.id)!;
  assert.equal(final.outputs.length, 1);
  assert.equal(final.outputs[0]!.name, stableName, 'stable name unchanged across rename');
  assert.equal(final.outputs[0]!.label, 'foo', 'label is the new value');
  assert.equal(final.outputs[0]!.type, 'Texture2D');

  // The whole point of the refactor: edges are not rewired by rename.
  // The before/after edge objects should be reference-equal because
  // the inner graph is not touched at all.
  const edgeAfter = final.graph.edges.find((e) => e.id === edgeBefore.id)!;
  assert.equal(edgeAfter, edgeBefore, 'edge object identity preserved (no churn)');
  assert.equal(edgeAfter.to.socket, stableName);
});

test('rename refuses to collide labels on the same side', () => {
  const store = useEditorStore.getState();

  const sg = createEmptySubgraph('collide-sg', 'collide sg');
  const worley = addNode(sg.graph, 'core/worley', { position: { x: 0, y: 0 } });
  useEditorStore.setState({
    subgraphs: [sg],
    currentEditingId: sg.id,
    graph: sg.graph,
  });

  store.addSubgraphSocketWithEdge(sg.id, 'output', 'Texture2D', {
    node: worley.id,
    socket: 'cells',
  });
  store.addSubgraphSocketWithEdge(sg.id, 'output', 'Texture2D', {
    node: worley.id,
    socket: 'cells',
  });
  let sgState = useEditorStore.getState().subgraphs.find((s) => s.id === sg.id)!;
  const [first, second] = sgState.outputs;
  assert.ok(first && second);

  store.renameSubgraphSocket(sg.id, 'output', second.name, 'untitled');
  sgState = useEditorStore.getState().subgraphs.find((s) => s.id === sg.id)!;
  assert.equal(
    sgState.outputs[1]!.label,
    'untitled-2',
    'collision is rejected — second socket keeps its original label',
  );
});

test('legacy I/O entries without a label field render via the name fallback', () => {
  // Save files written before the label split have only `name`. The
  // rename action should still let users assign a label to those
  // entries without changing the underlying name (which keeps any
  // existing edges referencing that name intact).
  const store = useEditorStore.getState();

  const sg = createEmptySubgraph('legacy-sg', 'legacy sg');
  sg.outputs = [{ name: 'value', type: 'Float' }];
  const constNode = addNode(sg.graph, 'core/constant-float', {
    position: { x: 100, y: 100 },
  });
  sg.graph.edges.push({
    id: 'e1',
    from: { node: constNode.id, socket: 'value' },
    to: { node: sg.outputNodeId, socket: 'value' },
  });
  useEditorStore.setState({
    subgraphs: [sg],
    currentEditingId: sg.id,
    graph: sg.graph,
  });

  store.renameSubgraphSocket(sg.id, 'output', 'value', 'pretty-name');

  const final = useEditorStore.getState().subgraphs.find((s) => s.id === sg.id)!;
  assert.equal(final.outputs[0]!.name, 'value', 'legacy name preserved — edges still resolve');
  assert.equal(final.outputs[0]!.label, 'pretty-name');
  const edge = final.graph.edges.find((e) => e.id === 'e1')!;
  assert.equal(edge.to.socket, 'value', 'edge still points at the original name');
});
