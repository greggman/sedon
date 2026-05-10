import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph, validateGraph } from '../../src/core/graph.js';
import { createCoreTypeRegistry } from '../../src/core/types.js';
import { createCoreNodeRegistry } from '../../src/nodes/index.js';

test('the POC graph (Grid → Material → SceneEntity ← Sphere → Output) validates', () => {
  const types = createCoreTypeRegistry();
  const nodes = createCoreNodeRegistry();
  const g = createGraph();
  const grid = addNode(g, 'core/grid', {
    inputValues: { fg: [0, 0, 0, 1], bg: [1, 1, 1, 1] },
  });
  const material = addNode(g, 'core/material');
  const sphere = addNode(g, 'core/sphere');
  const sceneEntity = addNode(g, 'core/scene-entity');
  const output = addNode(g, 'core/output');

  addEdge(g, { node: grid.id, socket: 'texture' }, { node: material.id, socket: 'basecolor' });
  addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: sceneEntity.id, socket: 'geometry' });
  addEdge(g, { node: material.id, socket: 'material' }, { node: sceneEntity.id, socket: 'material' });
  addEdge(g, { node: sceneEntity.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  const result = validateGraph(g, types, nodes);
  assert.ok(result.ok, JSON.stringify(result.issues, null, 2));
});

test('Material rejects non-Texture2D into basecolor', () => {
  const types = createCoreTypeRegistry();
  const nodes = createCoreNodeRegistry();
  const g = createGraph();
  // Sphere's geometry output (Geometry) into Material.basecolor (Texture2D)
  // — types are not compatible.
  const sphere = addNode(g, 'core/sphere');
  const material = addNode(g, 'core/material');
  addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: material.id, socket: 'basecolor' });

  const result = validateGraph(g, types, nodes);
  assert.ok(!result.ok);
  assert.ok(result.issues.some((i) => /incompatible/.test(i.message)));
});

test('Output requires scene to be connected', () => {
  const types = createCoreTypeRegistry();
  const nodes = createCoreNodeRegistry();
  const g = createGraph();
  addNode(g, 'core/output');

  const result = validateGraph(g, types, nodes);
  assert.ok(!result.ok);
  assert.equal(result.issues.filter((i) => /required input/.test(i.message)).length, 1);
});

test('all production nodes are registered', () => {
  const r = createCoreNodeRegistry();
  for (const id of [
    'core/mix',
    'core/sphere',
    'core/solid-color',
    'core/grid',
    'core/perlin',
    'core/blend',
    'core/material',
    'core/scene-entity',
    'core/scene-merge',
    'core/output',
  ]) {
    assert.ok(r.has(id), `missing node ${id}`);
  }
});

test('new socket types are registered', () => {
  const r = createCoreTypeRegistry();
  for (const id of ['Texture2D', 'Geometry', 'Material', 'Scene']) {
    assert.ok(r.has(id), `missing type ${id}`);
  }
});
