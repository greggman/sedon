import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph, validateGraph } from '../../src/core/graph.js';
import { createCoreTypeRegistry } from '../../src/core/types.js';
import { createCoreNodeRegistry } from '../../src/nodes/index.js';

test('Phase 2 POC graph validates', () => {
  const types = createCoreTypeRegistry();
  const nodes = createCoreNodeRegistry();
  const g = createGraph();
  const fg = addNode(g, 'core/color', { inputValues: { value: [0, 0, 0, 1] } });
  const bg = addNode(g, 'core/color', { inputValues: { value: [1, 1, 1, 1] } });
  const grid = addNode(g, 'core/grid');
  const material = addNode(g, 'core/material');
  const sphere = addNode(g, 'core/sphere');
  const output = addNode(g, 'core/output');

  addEdge(g, { node: fg.id, socket: 'color' }, { node: grid.id, socket: 'fg' });
  addEdge(g, { node: bg.id, socket: 'color' }, { node: grid.id, socket: 'bg' });
  addEdge(g, { node: grid.id, socket: 'texture' }, { node: material.id, socket: 'basecolor' });
  addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: output.id, socket: 'geometry' });
  addEdge(g, { node: material.id, socket: 'material' }, { node: output.id, socket: 'material' });

  const result = validateGraph(g, types, nodes);
  assert.ok(result.ok, JSON.stringify(result.issues, null, 2));
});

test('Material rejects non-Texture2D into basecolor', () => {
  const types = createCoreTypeRegistry();
  const nodes = createCoreNodeRegistry();
  const g = createGraph();
  const color = addNode(g, 'core/color');
  const material = addNode(g, 'core/material');
  // Color (Color type) wired into basecolor (Texture2D type) — incompatible.
  addEdge(g, { node: color.id, socket: 'color' }, { node: material.id, socket: 'basecolor' });

  const result = validateGraph(g, types, nodes);
  assert.ok(!result.ok);
  assert.ok(result.issues.some((i) => /incompatible/.test(i.message)));
});

test('Output requires geometry and material to be connected', () => {
  const types = createCoreTypeRegistry();
  const nodes = createCoreNodeRegistry();
  const g = createGraph();
  addNode(g, 'core/output');

  const result = validateGraph(g, types, nodes);
  assert.ok(!result.ok);
  // Both 'geometry' and 'material' are required (no defaults) — should be 2 issues.
  assert.equal(result.issues.filter((i) => /required input/.test(i.message)).length, 2);
});

test('all Phase 2 nodes are registered', () => {
  const r = createCoreNodeRegistry();
  for (const id of ['core/color', 'core/mix', 'core/sphere', 'core/grid', 'core/material', 'core/output']) {
    assert.ok(r.has(id), `missing node ${id}`);
  }
});

test('new socket types are registered', () => {
  const r = createCoreTypeRegistry();
  for (const id of ['Texture2D', 'Geometry', 'Material']) {
    assert.ok(r.has(id), `missing type ${id}`);
  }
});
