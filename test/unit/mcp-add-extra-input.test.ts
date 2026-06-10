// `addNodeExtraInput` is the MCP entry point an agent uses to grow a
// variadic node's input list (e.g. `scene/merge` — which starts with
// zero input sockets). Without this tool, the recipe documented in the
// overview ("merge two scenes → wire scene_0 and scene_1") was
// physically impossible from an MCP session because the slots didn't
// exist and `connect` rejects unknown sockets.
//
// These tests pin:
//   • the new socket name is returned so the caller can immediately connect
//   • slot indices increment per call (scene_0, scene_1, …)
//   • the connect path actually accepts the new slot afterwards
//   • non-variadic nodes are rejected with `not_variadic`
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

function seedWithSceneMerge(): string {
  const g = createGraph();
  const m = addNode(g, 'scene/merge', { id: 'merge1' });
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

test('addNodeExtraInput on scene/merge returns the new socket name (scene_0 first)', () => {
  const mergeId = seedWithSceneMerge();
  const result = tool('addNodeExtraInput').handler({ nodeId: mergeId }) as {
    socket: string;
    type: string;
  };
  assert.equal(result.socket, 'scene_0', 'first extra slot is scene_0');
  assert.equal(result.type, 'Scene', 'spec.type carries through');
});

test('addNodeExtraInput is sequential — second call returns scene_1', () => {
  const mergeId = seedWithSceneMerge();
  tool('addNodeExtraInput').handler({ nodeId: mergeId });
  const result = tool('addNodeExtraInput').handler({ nodeId: mergeId }) as { socket: string };
  assert.equal(result.socket, 'scene_1');
});

test('after addNodeExtraInput, connect to the new slot succeeds (round-trip)', () => {
  // The whole reason this tool exists. Build the documented recipe end
  // to end: scene/entity → scene/merge.scene_0 must connect cleanly.
  const mergeId = seedWithSceneMerge();
  // Need a source of type Scene. scene/entity outputs Scene.
  const g = useEditorStore.getState().graph;
  const ent = addNode(g, 'scene/entity', { id: 'ent1' });
  // Pretend we just added it through the store; manually publish so
  // setActiveEditing-style consumers see it. (Tests run without the
  // store's add path because we're focused on connect+extra-input.)
  useEditorStore.setState({ graph: { ...g, nodes: [...g.nodes, ent] } });

  // Now grow scene/merge by one slot and connect.
  tool('addNodeExtraInput').handler({ nodeId: mergeId });
  const connectResult = tool('connect').handler({
    from: { node: ent.id, socket: 'scene' },
    to: { node: mergeId, socket: 'scene_0' },
  }) as { id?: string; ok?: false; error?: { code: string } };
  assert.ok(connectResult.id, `connect must succeed (got ${JSON.stringify(connectResult)})`);
  // Verify the edge actually landed in the graph.
  const edges = useEditorStore.getState().graph.edges;
  const newEdge = edges.find((e) => e.to.node === mergeId && e.to.socket === 'scene_0');
  assert.ok(newEdge, 'edge to merge.scene_0 must be in the graph');
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

test('addNodeExtraInput on unknown nodeId returns code "node_not_found"', () => {
  seedWithSceneMerge();
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
