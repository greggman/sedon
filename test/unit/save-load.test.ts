import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import { createEmptySubgraph } from '../../src/core/subgraph.js';
import { createForestDemo } from '../../src/editor/demos/forest.js';
import {
  parseSaveFile,
  SAVE_FORMAT_VERSION,
  serializeSaveFile,
  type SaveFile,
} from '../../src/editor/save-load.js';

test('save → load round-trips an empty project', () => {
  const file: SaveFile = {
    formatVersion: SAVE_FORMAT_VERSION,
    graph: createGraph(),
    rootNodeId: 'nothing',
    subgraphs: [],
  };
  const restored = parseSaveFile(serializeSaveFile(file));
  assert.equal(restored.formatVersion, SAVE_FORMAT_VERSION);
  assert.equal(restored.rootNodeId, 'nothing');
  assert.equal(restored.subgraphs.length, 0);
  assert.equal(restored.graph.nodes.length, 0);
  assert.equal(restored.graph.edges.length, 0);
});

test('save → load preserves a graph with inputValues and edges', () => {
  const g = createGraph();
  const a = addNode(g, 'core/perlin', {
    inputValues: { scale: [4, 4], octaves: 3, seed: 0.7 },
  });
  const b = addNode(g, 'core/material', {
    inputValues: { roughness: 0.85, metallic: 0, detail_scale: 6, detail_strength: 0.55 },
  });
  addEdge(g, { node: a.id, socket: 'texture' }, { node: b.id, socket: 'basecolor' });

  const file: SaveFile = {
    formatVersion: SAVE_FORMAT_VERSION,
    graph: g,
    rootNodeId: b.id,
    subgraphs: [],
  };
  const restored = parseSaveFile(serializeSaveFile(file));
  assert.equal(restored.graph.nodes.length, 2);
  assert.equal(restored.graph.edges.length, 1);
  const restoredA = restored.graph.nodes.find((n) => n.id === a.id);
  const restoredB = restored.graph.nodes.find((n) => n.id === b.id);
  assert.deepEqual(restoredA?.inputValues, { scale: [4, 4], octaves: 3, seed: 0.7 });
  assert.deepEqual(restoredB?.inputValues, {
    roughness: 0.85,
    metallic: 0,
    detail_scale: 6,
    detail_strength: 0.55,
  });
  assert.deepEqual(restored.graph.edges[0]?.from, { node: a.id, socket: 'texture' });
  assert.deepEqual(restored.graph.edges[0]?.to, { node: b.id, socket: 'basecolor' });
});

test('save → load preserves subgraph inputs/outputs and the inner graph', () => {
  // Hand-author a subgraph that exercises both edited socket lists and
  // an inner graph with edges — same shape as a user-built subgraph in
  // the editor.
  const sg = createEmptySubgraph('greeter', 'Greeter');
  sg.inputs = [
    { name: 'who', type: 'Float', default: 0.5 },
    { name: 'mood', type: 'Color', default: [1, 0.5, 0.25, 1] },
  ];
  sg.outputs = [
    { name: 'greeting', type: 'Float' },
  ];
  // Wire the input boundary's 'who' output → output boundary's 'greeting' input.
  addEdge(
    sg.graph,
    { node: sg.inputNodeId, socket: 'who' },
    { node: sg.outputNodeId, socket: 'greeting' },
  );

  const file: SaveFile = {
    formatVersion: SAVE_FORMAT_VERSION,
    graph: createGraph(),
    rootNodeId: 'none',
    subgraphs: [sg],
  };

  const restored = parseSaveFile(serializeSaveFile(file));
  assert.equal(restored.subgraphs.length, 1);
  const rsg = restored.subgraphs[0]!;
  assert.equal(rsg.id, 'greeter');
  assert.equal(rsg.label, 'Greeter');
  assert.equal(rsg.category, 'Subgraphs');
  assert.deepEqual(rsg.inputs, [
    { name: 'who', type: 'Float', default: 0.5 },
    { name: 'mood', type: 'Color', default: [1, 0.5, 0.25, 1] },
  ]);
  assert.deepEqual(rsg.outputs, [{ name: 'greeting', type: 'Float' }]);
  assert.equal(rsg.inputNodeId, sg.inputNodeId);
  assert.equal(rsg.outputNodeId, sg.outputNodeId);
  assert.equal(rsg.graph.nodes.length, 2);
  assert.equal(rsg.graph.edges.length, 1);
});

test('save → load round-trips the full forest demo', () => {
  // createForestDemo just builds graph structures — no GPU calls — so it's
  // safe to run in plain Node. Use it as a realistic shape that exercises
  // multiple subgraphs nesting subgraphs (forest → oak → bark-texture).
  const demo = createForestDemo();
  const file: SaveFile = {
    formatVersion: SAVE_FORMAT_VERSION,
    graph: demo.graph,
    rootNodeId: demo.rootNodeId,
    subgraphs: demo.subgraphs,
  };
  const restored = parseSaveFile(serializeSaveFile(file));

  assert.equal(restored.rootNodeId, demo.rootNodeId);
  assert.equal(restored.graph.nodes.length, demo.graph.nodes.length);
  assert.equal(restored.graph.edges.length, demo.graph.edges.length);
  assert.equal(restored.subgraphs.length, demo.subgraphs.length);

  // Subgraph identity preserved.
  const restoredIds = restored.subgraphs.map((s) => s.id).sort();
  const originalIds = demo.subgraphs.map((s) => s.id).sort();
  assert.deepEqual(restoredIds, originalIds);

  // Pick the bark-texture subgraph and check a specific authored value
  // survives — catches "we silently dropped the inputs[].default field"
  // kinds of regression.
  const bark = restored.subgraphs.find((s) => s.id === 'bark-texture');
  assert.ok(bark, 'bark-texture should be present after restore');
  const seedInput = bark.inputs.find((i) => i.name === 'seed');
  assert.equal(seedInput?.type, 'Float');
  assert.equal(seedInput?.default, 0.3);

  // The bark subgraph also declares detail outputs since we moved detail
  // textures into the texture subgraphs — guard against future cleanup
  // dropping them.
  const outputNames = bark.outputs.map((o) => o.name).sort();
  assert.deepEqual(
    outputNames,
    ['basecolor', 'detail_basecolor', 'detail_normal', 'normal'],
  );
});

test('parseSaveFile accepts v1 (no subgraphs field)', () => {
  // v1 save: graph + rootNodeId, no subgraphs field. Files created
  // before subgraphs existed should still load.
  const v1Json = JSON.stringify({
    formatVersion: 1,
    graph: { version: 1, nodes: [], edges: [] },
    rootNodeId: 'foo',
  });
  const restored = parseSaveFile(v1Json);
  assert.equal(restored.rootNodeId, 'foo');
  assert.equal(restored.subgraphs.length, 0);
});

test('parseSaveFile rejects unknown format versions', () => {
  const futureJson = JSON.stringify({
    formatVersion: 99,
    graph: { version: 1, nodes: [], edges: [] },
    rootNodeId: 'foo',
    subgraphs: [],
  });
  assert.throws(() => parseSaveFile(futureJson), /unsupported save file format/);
});

test('parseSaveFile rejects missing rootNodeId', () => {
  const badJson = JSON.stringify({
    formatVersion: SAVE_FORMAT_VERSION,
    graph: { version: 1, nodes: [], edges: [] },
    subgraphs: [],
  });
  assert.throws(() => parseSaveFile(badJson), /missing rootNodeId/);
});

test('parseSaveFile rejects malformed subgraphs', () => {
  const badJson = JSON.stringify({
    formatVersion: SAVE_FORMAT_VERSION,
    graph: { version: 1, nodes: [], edges: [] },
    rootNodeId: 'r',
    subgraphs: [{ id: 'no-graph', label: 'Bad', category: 'Subgraphs' }],
  });
  assert.throws(() => parseSaveFile(badJson), /invalid subgraph/);
});
