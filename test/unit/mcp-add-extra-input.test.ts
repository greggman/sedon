// `addNodeExtraInput` is the MCP entry point an agent uses to grow a
// node's variadic input list — the nodes still on the legacy
// `extraInputsSpec` pattern (poly/list, scene/switch, tex/grass,
// material/terrain-multi-layer). For `scene/merge` (migrated to a
// single multi-fan-in socket) this tool is now a no-op — that variant
// is tested below as well.
//
// Tests pin:
//   • the new socket name is returned so the caller can immediately connect
//   • slot indices increment per call (polygon_0, polygon_1, …)
//   • the connect path actually accepts the new slot afterwards
//   • non-variadic nodes (including the post-migration scene/merge)
//     are rejected with `not_variadic`
//   • unknown node id is rejected with `node_not_found`

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNode, createGraph } from '../../src/core/graph.js';
import { buildSedonTools, type SedonTool } from '../../src/editor/mcp/tools.js';
import { buildRegistry } from '../../src/editor/registry.js';
import { useEditorStore } from '../../src/editor/store.js';

function buildTools(): SedonTool[] {
  return buildSedonTools({
    getState: () => useEditorStore.getState(),
    getRegistry: () => buildRegistry(useEditorStore.getState().subgraphs),
    getActions: () => [],
  });
}
function tool(name: string): SedonTool {
  const t = buildTools().find((x) => x.name === name);
  if (!t) throw new Error(`no tool: ${name}`);
  return t;
}

function seedWithPolyList(): string {
  const g = createGraph();
  const m = addNode(g, 'poly/list', { id: 'list1' });
  useEditorStore.setState({
    mainGraph: g,
    graph: g,
    rootNodeId: m.id,
    currentEditingId: 'main',
    subgraphs: [],
    folders: [],
    undoStack: [],
    redoStack: [],
    nodePositions: { main: {} },
  });
  return m.id;
}

test('addNodeExtraInput on poly/list returns polygon_0 as the new socket name', () => {
  const listId = seedWithPolyList();
  const result = tool('addNodeExtraInput').handler({ nodeId: listId }) as {
    socket: string;
    type: string;
  };
  assert.equal(result.socket, 'polygon_0');
  assert.equal(result.type, 'Polygon');
});

test('addNodeExtraInput is sequential — second call returns polygon_1', () => {
  const listId = seedWithPolyList();
  tool('addNodeExtraInput').handler({ nodeId: listId });
  const result = tool('addNodeExtraInput').handler({ nodeId: listId }) as { socket: string };
  assert.equal(result.socket, 'polygon_1');
});

test('after addNodeExtraInput, connect to the new slot succeeds (round-trip)', () => {
  // Build a real connect path: poly/from-points emits Polygon, the
  // new slot accepts Polygon, the wire lands cleanly.
  const listId = seedWithPolyList();
  const g = useEditorStore.getState().graph;
  const src = addNode(g, 'poly/from-points', { id: 'src1' });
  useEditorStore.setState({ graph: { ...g, nodes: [...g.nodes, src] } });

  tool('addNodeExtraInput').handler({ nodeId: listId });
  const connectResult = tool('connect').handler({
    from: { node: src.id, socket: 'polygon' },
    to: { node: listId, socket: 'polygon_0' },
  }) as { id?: string; ok?: false; error?: { code: string } };
  assert.ok(connectResult.id, `connect must succeed (got ${JSON.stringify(connectResult)})`);
  const edges = useEditorStore.getState().graph.edges;
  const newEdge = edges.find((e) => e.to.node === listId && e.to.socket === 'polygon_0');
  assert.ok(newEdge, 'edge to list.polygon_0 must be in the graph');
});

test('addNodeExtraInput on a non-variadic node returns code "not_variadic"', () => {
  // `geom/cube` doesn't declare extraInputsSpec — must reject cleanly.
  const g = createGraph();
  const cube = addNode(g, 'geom/cube', { id: 'cube1' });
  useEditorStore.setState({
    mainGraph: g,
    graph: g,
    rootNodeId: cube.id,
    currentEditingId: 'main',
    subgraphs: [],
    folders: [],
    undoStack: [],
    redoStack: [],
    nodePositions: { main: {} },
  });
  const result = tool('addNodeExtraInput').handler({ nodeId: cube.id }) as {
    ok?: false;
    error?: { code: string };
  };
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'not_variadic');
});

test('addNodeExtraInput on the migrated scene/merge returns "not_variadic" (use the multi `scenes` socket directly)', () => {
  // scene/merge migrated from extraInputsSpec to a single
  // `scenes` multi-fan-in input. addNodeExtraInput no longer applies
  // — agents should connect straight to `scenes`.
  const g = createGraph();
  const m = addNode(g, 'scene/merge', { id: 'm1' });
  useEditorStore.setState({
    mainGraph: g,
    graph: g,
    rootNodeId: m.id,
    currentEditingId: 'main',
    subgraphs: [],
    folders: [],
    undoStack: [],
    redoStack: [],
    nodePositions: { main: {} },
  });
  const result = tool('addNodeExtraInput').handler({ nodeId: m.id }) as {
    ok?: false;
    error?: { code: string };
  };
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'not_variadic');
});

test('addNodeExtraInput on unknown nodeId returns code "node_not_found"', () => {
  seedWithPolyList();
  const result = tool('addNodeExtraInput').handler({ nodeId: 'GHOST' }) as {
    ok?: false;
    error?: { code: string };
  };
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'node_not_found');
});

test('addNodeExtraInput is registered on the tool list', () => {
  const names = buildTools().map((t) => t.name);
  assert.ok(names.includes('addNodeExtraInput'), 'tool must be in the canonical list');
});
