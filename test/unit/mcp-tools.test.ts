// Exercise every MCP tool handler against a fresh-seeded
// useEditorStore — the same store the runtime UI dispatches into —
// so the tests prove the tools really do drive the command pipeline
// (and therefore inherit undo for free) rather than maintaining
// their own parallel mutation path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from '../../src/core/graph.js';
import { buildRegistry } from '../../src/editor/registry.js';
import { useEditorStore } from '../../src/editor/store.js';
import { buildSedonTools, type SedonTool } from '../../src/editor/mcp/tools.js';

function resetStore(): void {
  useEditorStore.setState({
    mainGraph: createGraph(),
    graph: createGraph(),
    currentEditingId: 'main',
    subgraphs: [],
    folders: [],
    undoStack: [],
    redoStack: [],
    mainRootNodeId: '',
    rootNodeId: '',
  });
}

function makeTools(): SedonTool[] {
  return buildSedonTools({
    getState: () => useEditorStore.getState(),
    getRegistry: () => buildRegistry(useEditorStore.getState().subgraphs),
  });
}

function tool(tools: SedonTool[], name: string): SedonTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool "${name}"`);
  return t;
}

// ─── Orientation / metadata ────────────────────────────────────

test('getSedonOverview returns the orientation document', () => {
  resetStore();
  const tools = makeTools();
  const result = tool(tools, 'getSedonOverview').handler({}) as { overview: string };
  assert.match(result.overview, /node-based procedural 3D editor/);
  assert.match(result.overview, /Houdini/);
  assert.match(result.overview, /Blender/);
  assert.match(result.overview, /Scene as a first-class type/);
});

test('listNodeKinds returns every registered kind with input/output shapes', () => {
  resetStore();
  const tools = makeTools();
  const result = tool(tools, 'listNodeKinds').handler({}) as {
    kinds: Array<{ id: string; inputs: unknown[]; outputs: unknown[] }>;
  };
  // Sanity: should include known core nodes.
  const ids = new Set(result.kinds.map((k) => k.id));
  assert.ok(ids.has('core/sphere'), 'expected core/sphere among kinds');
  assert.ok(ids.has('core/transform-geometry'), 'expected core/transform-geometry');
  assert.ok(ids.has('core/scene-merge'), 'expected core/scene-merge');
  // Each kind has socket arrays.
  for (const k of result.kinds) {
    assert.ok(Array.isArray(k.inputs), `${k.id}.inputs is array`);
    assert.ok(Array.isArray(k.outputs), `${k.id}.outputs is array`);
  }
});

// ─── addNode + listGraphNodes round-trip ────────────────────────

test('addNode adds a node to the active graph; listGraphNodes sees it', () => {
  resetStore();
  const tools = makeTools();
  const add = tool(tools, 'addNode');
  const list = tool(tools, 'listGraphNodes');
  const { id } = add.handler({
    kind: 'core/sphere',
    position: { x: 100, y: 100 },
    inputValues: { radius: 2 },
  }) as { id: string };
  assert.ok(id, 'returned an id');
  const { nodes } = list.handler({}) as {
    nodes: Array<{ id: string; kind: string; inputValues: Record<string, unknown> }>;
  };
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.id, id);
  assert.equal(nodes[0]!.kind, 'core/sphere');
  assert.equal(nodes[0]!.inputValues.radius, 2);
});

test('addNode uses provided explicit id when given', () => {
  resetStore();
  const tools = makeTools();
  const { id } = tool(tools, 'addNode').handler({
    id: 'my-sphere',
    kind: 'core/sphere',
  }) as { id: string };
  assert.equal(id, 'my-sphere');
});

// ─── connect + listGraphEdges ───────────────────────────────────

test('connect adds an edge and listGraphEdges reports it', () => {
  resetStore();
  const tools = makeTools();
  const add = tool(tools, 'addNode');
  const sphereId = (add.handler({ kind: 'core/sphere' }) as { id: string }).id;
  const entityId = (add.handler({ kind: 'core/scene-entity' }) as { id: string }).id;
  const { id: edgeId } = tool(tools, 'connect').handler({
    from: { node: sphereId, socket: 'geometry' },
    to: { node: entityId, socket: 'geometry' },
  }) as { id: string };
  assert.ok(edgeId);
  const { edges } = tool(tools, 'listGraphEdges').handler({}) as {
    edges: Array<{ from: { node: string; socket: string }; to: { node: string; socket: string } }>;
  };
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.from.node, sphereId);
  assert.equal(edges[0]!.from.socket, 'geometry');
  assert.equal(edges[0]!.to.node, entityId);
});

test('connect rejects malformed socket refs', () => {
  resetStore();
  const tools = makeTools();
  assert.throws(() => tool(tools, 'connect').handler({ from: 'oops', to: 'oops' }), /from:/);
});

// ─── setInputValue + getNodeInputValue ──────────────────────────

test('setInputValue authors a value; getNodeInputValue reads it back', () => {
  resetStore();
  const tools = makeTools();
  const { id } = tool(tools, 'addNode').handler({ kind: 'core/sphere' }) as { id: string };
  tool(tools, 'setInputValue').handler({ nodeId: id, name: 'radius', value: 5 });
  const { value } = tool(tools, 'getNodeInputValue').handler({
    nodeId: id,
    name: 'radius',
  }) as { value: unknown };
  assert.equal(value, 5);
});

test('getNodeInputValue returns null for an unauthored socket', () => {
  resetStore();
  const tools = makeTools();
  const { id } = tool(tools, 'addNode').handler({ kind: 'core/sphere' }) as { id: string };
  const { value } = tool(tools, 'getNodeInputValue').handler({
    nodeId: id,
    name: 'radius',
  }) as { value: unknown };
  assert.equal(value, null);
});

test('getNodeInputValue throws for unknown node id', () => {
  resetStore();
  const tools = makeTools();
  assert.throws(
    () => tool(tools, 'getNodeInputValue').handler({ nodeId: 'nope', name: 'radius' }),
    /no node/,
  );
});

// ─── removeNodes / removeEdges ──────────────────────────────────

test('removeNodes drops the nodes from the graph', () => {
  resetStore();
  const tools = makeTools();
  const { id } = tool(tools, 'addNode').handler({ kind: 'core/sphere' }) as { id: string };
  const { removed } = tool(tools, 'removeNodes').handler({ ids: [id] }) as { removed: number };
  assert.equal(removed, 1);
  const { nodes } = tool(tools, 'listGraphNodes').handler({}) as { nodes: unknown[] };
  assert.equal(nodes.length, 0);
});

test('removeEdges drops a connected edge but leaves nodes alone', () => {
  resetStore();
  const tools = makeTools();
  const sphereId = (tool(tools, 'addNode').handler({ kind: 'core/sphere' }) as { id: string }).id;
  const entityId = (tool(tools, 'addNode').handler({ kind: 'core/scene-entity' }) as {
    id: string;
  }).id;
  const { id: edgeId } = tool(tools, 'connect').handler({
    from: { node: sphereId, socket: 'geometry' },
    to: { node: entityId, socket: 'geometry' },
  }) as { id: string };
  tool(tools, 'removeEdges').handler({ ids: [edgeId] });
  const { edges } = tool(tools, 'listGraphEdges').handler({}) as { edges: unknown[] };
  assert.equal(edges.length, 0);
  const { nodes } = tool(tools, 'listGraphNodes').handler({}) as { nodes: unknown[] };
  assert.equal(nodes.length, 2);
});

// ─── renameNode ─────────────────────────────────────────────────

test('renameNode sets the cosmetic name', () => {
  resetStore();
  const tools = makeTools();
  const { id } = tool(tools, 'addNode').handler({ kind: 'core/sphere' }) as { id: string };
  tool(tools, 'renameNode').handler({ nodeId: id, name: 'big sphere' });
  const { nodes } = tool(tools, 'listGraphNodes').handler({}) as {
    nodes: Array<{ name: string | null }>;
  };
  assert.equal(nodes[0]!.name, 'big sphere');
});

// ─── Subgraph: create + switch context + add socket ─────────────

test('createSubgraph + setActiveEditing land subsequent addNode inside the subgraph', () => {
  resetStore();
  const tools = makeTools();
  tool(tools, 'createSubgraph').handler({ id: 'leg', label: 'Leg' });
  // createSubgraph switches editing context automatically — confirm.
  const { id: editing } = tool(tools, 'getActiveEditing').handler({}) as { id: string };
  assert.equal(editing, 'leg');
  // Now any addNode goes into the leg subgraph.
  const { id: nodeId } = tool(tools, 'addNode').handler({ kind: 'core/cylinder' }) as {
    id: string;
  };
  const subgraph = useEditorStore.getState().subgraphs.find((s) => s.id === 'leg');
  assert.ok(subgraph, 'leg subgraph exists');
  assert.ok(
    subgraph!.graph.nodes.some((n) => n.id === nodeId),
    'cylinder added inside leg subgraph',
  );
  // Switch back to main and confirm the cylinder is NOT there.
  tool(tools, 'setActiveEditing').handler({ id: 'main' });
  const { nodes } = tool(tools, 'listGraphNodes').handler({}) as { nodes: unknown[] };
  assert.equal(nodes.length, 0);
});

test('addSubgraphSocket adds an input socket to an existing subgraph', () => {
  resetStore();
  const tools = makeTools();
  tool(tools, 'createSubgraph').handler({ id: 'leg', label: 'Leg' });
  tool(tools, 'addSubgraphSocket').handler({
    subgraphId: 'leg',
    side: 'input',
    label: 'height',
    socketType: 'Float',
  });
  const subgraph = useEditorStore.getState().subgraphs.find((s) => s.id === 'leg');
  assert.ok(subgraph);
  assert.equal(subgraph!.inputs.length, 1);
  // `name` is auto-generated by the store to dedupe across
  // simultaneous adds; the human-readable string we passed lives
  // on `label`.
  assert.equal((subgraph!.inputs[0] as { label?: string }).label, 'height');
  assert.equal(subgraph!.inputs[0]!.type, 'Float');
});

test('addSubgraphSocket rejects unknown side', () => {
  resetStore();
  const tools = makeTools();
  tool(tools, 'createSubgraph').handler({ id: 'leg', label: 'Leg' });
  assert.throws(
    () =>
      tool(tools, 'addSubgraphSocket').handler({
        subgraphId: 'leg',
        side: 'sideways',
        label: 'x',
        socketType: 'Float',
      }),
    /side must be/,
  );
});

// ─── Undoability sanity: every mutation tool pushes a command ───

test('addNode + connect + setInputValue together produce 3 undo entries', () => {
  resetStore();
  const tools = makeTools();
  const before = useEditorStore.getState().undoStack.length;
  const sphereId = (tool(tools, 'addNode').handler({ kind: 'core/sphere' }) as { id: string }).id;
  const entityId = (tool(tools, 'addNode').handler({ kind: 'core/scene-entity' }) as {
    id: string;
  }).id;
  tool(tools, 'connect').handler({
    from: { node: sphereId, socket: 'geometry' },
    to: { node: entityId, socket: 'geometry' },
  });
  tool(tools, 'setInputValue').handler({
    nodeId: sphereId,
    name: 'radius',
    value: 3,
    coalesce: false,
  });
  const after = useEditorStore.getState().undoStack.length;
  assert.equal(after - before, 4, '2 addNode + 1 connect + 1 setInputValue (non-coalesced) = 4 entries');
});
