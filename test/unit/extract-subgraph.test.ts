// Unit tests for the pure extractSelectionAsSubgraph encapsulation
// algorithm. Builds tiny graphs by hand, runs the extractor, and
// asserts the boundary classification + wrapper rewiring is right.
//
// The store action that wraps this gets driven from the headless
// integration script.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import { createNodeRegistry, type NodeDef } from '../../src/core/node-def.js';
import { extractSelectionAsSubgraph } from '../../src/editor/extract-subgraph.js';

// ─── Tiny in-memory registry just for these tests ───────────────

const FLOAT: NodeDef = {
  id: 'test/float',
  category: 'test',
  inputs: [{ name: 'value', type: 'Float' }],
  outputs: [{ name: 'value', type: 'Float' }],
  evaluate: () => ({ value: 0 }),
};
const ADD: NodeDef = {
  id: 'test/add',
  category: 'test',
  inputs: [
    { name: 'a', type: 'Float' },
    { name: 'b', type: 'Float' },
  ],
  outputs: [{ name: 'sum', type: 'Float' }],
  evaluate: () => ({ sum: 0 }),
};
const SINK: NodeDef = {
  id: 'test/sink',
  category: 'test',
  inputs: [{ name: 'x', type: 'Float' }],
  outputs: [],
  evaluate: () => ({}),
};

const REG = (() => {
  const r = createNodeRegistry();
  r.register(FLOAT);
  r.register(ADD);
  r.register(SINK);
  return r;
})();

function opts(id = 'sg1') {
  return { newSubgraphId: id, newSubgraphLabel: 'untitled subgraph' };
}

// ─── Tests ─────────────────────────────────────────────────────

test('returns null for empty selection', () => {
  const g = createGraph();
  const result = extractSelectionAsSubgraph(g, new Set(), REG, opts());
  assert.equal(result, null);
});

test('returns null when only ids point at missing nodes', () => {
  const g = createGraph();
  const result = extractSelectionAsSubgraph(g, new Set(['ghost']), REG, opts());
  assert.equal(result, null);
});

test('single-node selection with one outer input and one outer output', () => {
  // Layout: A → B → C, select just B.
  const g = createGraph();
  const a = addNode(g, 'test/float', { position: { x: 0, y: 0 } });
  const b = addNode(g, 'test/add', { position: { x: 200, y: 0 } });
  const c = addNode(g, 'test/sink', { position: { x: 400, y: 0 } });
  addEdge(g, { node: a.id, socket: 'value' }, { node: b.id, socket: 'a' });
  addEdge(g, { node: b.id, socket: 'sum' }, { node: c.id, socket: 'x' });

  const result = extractSelectionAsSubgraph(g, new Set([b.id]), REG, opts())!;
  assert.ok(result);

  // Subgraph has one input (from A → B.a) and one output (B.sum → C).
  assert.equal(result.newSubgraph.inputs.length, 1);
  assert.equal(result.newSubgraph.inputs[0]!.type, 'Float');
  assert.equal(result.newSubgraph.inputs[0]!.label, 'a');
  assert.equal(result.newSubgraph.outputs.length, 1);
  assert.equal(result.newSubgraph.outputs[0]!.type, 'Float');
  assert.equal(result.newSubgraph.outputs[0]!.label, 'sum');

  // Parent: A and C still there; B gone; wrapper added.
  const parentKinds = result.newParentGraph.nodes.map((n) => n.kind).sort();
  assert.deepEqual(parentKinds, ['subgraph/sg1', 'test/float', 'test/sink'].sort());

  // Parent edges: A → wrapper.<inSocket>, wrapper.<outSocket> → C.
  // External edges = none, both touched the selection.
  assert.equal(result.newParentGraph.edges.length, 2);
  const inSocket = result.newSubgraph.inputs[0]!.name;
  const outSocket = result.newSubgraph.outputs[0]!.name;
  const aToWrapper = result.newParentGraph.edges.find(
    (e) => e.from.node === a.id && e.to.node === result.wrapperId,
  );
  const wrapperToC = result.newParentGraph.edges.find(
    (e) => e.from.node === result.wrapperId && e.to.node === c.id,
  );
  assert.ok(aToWrapper);
  assert.equal(aToWrapper.to.socket, inSocket);
  assert.ok(wrapperToC);
  assert.equal(wrapperToC.from.socket, outSocket);

  // Inner graph: B is there, the two boundary nodes, internal edges
  // rewired to the boundaries.
  const innerKinds = result.newSubgraph.graph.nodes.map((n) => n.kind);
  assert.ok(innerKinds.includes('subgraph-input/sg1'));
  assert.ok(innerKinds.includes('subgraph-output/sg1'));
  assert.ok(innerKinds.includes('test/add'));
  // Inner edges: 1 from boundary-in → B.a, 1 from B.sum → boundary-out.
  assert.equal(result.newSubgraph.graph.edges.length, 2);
});

test('multi-node selection: internal edges move in, external stays out', () => {
  // Layout: A → B → C → D, select B and C.
  // Internal:  B → C
  // Input boundary: A → B
  // Output boundary: C → D
  // External: (none — every edge touches B or C)
  const g = createGraph();
  const a = addNode(g, 'test/float');
  const b = addNode(g, 'test/add');
  const c = addNode(g, 'test/add');
  const d = addNode(g, 'test/sink');
  addEdge(g, { node: a.id, socket: 'value' }, { node: b.id, socket: 'a' });
  addEdge(g, { node: b.id, socket: 'sum' }, { node: c.id, socket: 'a' });
  addEdge(g, { node: c.id, socket: 'sum' }, { node: d.id, socket: 'x' });

  const result = extractSelectionAsSubgraph(g, new Set([b.id, c.id]), REG, opts())!;
  assert.ok(result);

  // 1 input, 1 output.
  assert.equal(result.newSubgraph.inputs.length, 1);
  assert.equal(result.newSubgraph.outputs.length, 1);
  // Inner graph keeps B and C; the B→C edge is internal.
  const innerEdges = result.newSubgraph.graph.edges;
  // 1 boundary-in→B + 1 B→C + 1 C→boundary-out = 3.
  assert.equal(innerEdges.length, 3);
  const bToC = innerEdges.find(
    (e) => e.from.node === b.id && e.to.node === c.id,
  );
  assert.ok(bToC, 'internal B→C edge was lost');

  // Parent: A and D remain, wrapper replaces B+C, edges go A→wrapper
  // and wrapper→D.
  assert.equal(result.newParentGraph.nodes.length, 3); // A, D, wrapper
  assert.equal(result.newParentGraph.edges.length, 2);
});

test('output dedup: one inner output feeding multiple outer targets makes ONE subgraph output', () => {
  // Layout: A → B → C, A → B → D. The same inner output (B.sum)
  // feeds both C.x and D.x. The wrapper should expose a single
  // output that drives both outer targets.
  const g = createGraph();
  const a = addNode(g, 'test/float');
  const b = addNode(g, 'test/add');
  const c = addNode(g, 'test/sink');
  const d = addNode(g, 'test/sink');
  addEdge(g, { node: a.id, socket: 'value' }, { node: b.id, socket: 'a' });
  addEdge(g, { node: b.id, socket: 'sum' }, { node: c.id, socket: 'x' });
  addEdge(g, { node: b.id, socket: 'sum' }, { node: d.id, socket: 'x' });

  const result = extractSelectionAsSubgraph(g, new Set([b.id]), REG, opts())!;
  assert.equal(result.newSubgraph.outputs.length, 1, 'expected ONE deduped output');
  // Two parent-side edges from the single wrapper output socket.
  const outSocket = result.newSubgraph.outputs[0]!.name;
  const fanOut = result.newParentGraph.edges.filter(
    (e) => e.from.node === result.wrapperId && e.from.socket === outSocket,
  );
  assert.equal(fanOut.length, 2, 'expected wrapper output to fan out to both outer targets');
});

test('external edges (neither endpoint in selection) carry over unchanged', () => {
  // Layout: A → B, C → D. Select only A. The C→D edge is purely
  // external — it must survive unchanged in the new parent graph.
  const g = createGraph();
  const a = addNode(g, 'test/float');
  const b = addNode(g, 'test/sink');
  const c = addNode(g, 'test/float');
  const d = addNode(g, 'test/sink');
  addEdge(g, { node: a.id, socket: 'value' }, { node: b.id, socket: 'x' });
  const cToD = addEdge(g, { node: c.id, socket: 'value' }, { node: d.id, socket: 'x' });

  const result = extractSelectionAsSubgraph(g, new Set([a.id]), REG, opts())!;
  const survivor = result.newParentGraph.edges.find((e) => e.id === cToD.id);
  assert.ok(survivor, 'external C→D edge was dropped');
});

test('skips boundary nodes in the selection', () => {
  // Boundary nodes inside a subgraph (kind = subgraph-input/<id>)
  // can't be encapsulated — they only mean anything as I/O of their
  // owning subgraph. The extractor filters them out.
  const g = createGraph();
  const bnd = addNode(g, 'subgraph-input/some-outer-id');
  const real = addNode(g, 'test/float');
  const result = extractSelectionAsSubgraph(
    g, new Set([bnd.id, real.id]), REG, opts(),
  );
  // Only `real` was extractable, so the inner subgraph contains it.
  assert.ok(result);
  const inner = result.newSubgraph.graph.nodes.map((n) => n.kind);
  assert.ok(inner.includes('test/float'));
  // The original boundary node stays in the parent graph (its kind
  // is owned by a different subgraph; we don't touch it).
  assert.ok(result.newParentGraph.nodes.some((n) => n.id === bnd.id));
});

test('inputValues on selected nodes are deep-cloned, not shared', () => {
  // Mutating the inner node's inputValues post-extract must not
  // touch the original parent-side node (which has already been
  // removed, but the principle still matters if a caller keeps a
  // reference to the original graph).
  const g = createGraph();
  const a = addNode(g, 'test/float', {
    inputValues: { value: 42 },
  });
  const result = extractSelectionAsSubgraph(g, new Set([a.id]), REG, opts())!;
  const inner = result.newSubgraph.graph.nodes.find(
    (n) => n.kind === 'test/float',
  )!;
  assert.notEqual(inner.inputValues, a.inputValues, 'inputValues shared by reference');
  assert.deepEqual(inner.inputValues, a.inputValues);
});

test('wrapper sits at the bounding-box centroid of the selection', () => {
  const g = createGraph();
  const a = addNode(g, 'test/float', { position: { x: -100, y: 50 } });
  const b = addNode(g, 'test/float', { position: { x: 100, y: 150 } });
  const result = extractSelectionAsSubgraph(g, new Set([a.id, b.id]), REG, opts())!;
  const wrapper = result.newParentGraph.nodes.find((n) => n.id === result.wrapperId)!;
  // Centroid = average of (min, max) corners = ((-100+100)/2, (50+150)/2).
  assert.deepEqual(wrapper.position, { x: 0, y: 100 });
});

test('socket label collisions disambiguate with a suffix', () => {
  // Two boundary inputs whose preferred names are the same inner
  // socket name should produce labels "a" and "a_2" so the user
  // can tell them apart even though `name` (the UUID) is unique.
  const g = createGraph();
  const a = addNode(g, 'test/float');
  const c = addNode(g, 'test/float');
  const b1 = addNode(g, 'test/add');
  const b2 = addNode(g, 'test/add');
  addEdge(g, { node: a.id, socket: 'value' }, { node: b1.id, socket: 'a' });
  addEdge(g, { node: c.id, socket: 'value' }, { node: b2.id, socket: 'a' });

  const result = extractSelectionAsSubgraph(g, new Set([b1.id, b2.id]), REG, opts())!;
  const labels = result.newSubgraph.inputs.map((i) => i.label).sort();
  assert.deepEqual(labels, ['a', 'a_2']);
});
