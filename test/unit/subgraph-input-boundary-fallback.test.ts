// Regression: a subgraph-input boundary node must do PER-KEY fallback,
// not all-or-nothing.
//
// Background: when the for-each-point's owning code calls into a
// bridge-eval with broadcast inputs in hand, any extra socket the user
// hasn't wired arrives as `{name: undefined}`. The previous boundary
// evaluator was:
//     return ctx.subgraphInputs ?? standaloneDefaults;
// which is truthy even when EVERY value inside subgraphInputs is
// undefined — so the boundary handed the inner graph a bag of
// undefineds. Anything downstream that read those values (a transform
// node doing `scale[0]`, a material doing `basecolor.kind`, …) crashed
// during eval, producing JS errors per iteration.
//
// User-visible reproduction (the report this fix addresses):
//   1. Open scene=for-each-point
//   2. Duplicate the cabinet-cell body in Assets, rename the copy
//   3. Add a NEW for-each-point on main, wire grid-distribute → it
//   4. Drag the copy onto the new for-each-point
// → 16 `TypeError: Cannot read properties of undefined (reading '0')`
//   errors because the new for-each-point's `size` extra is unwired,
//   transform.scale gets undefined, transformMesh tries scale[0].
//
// Fix: the boundary now merges defaults under provided values per-key,
// so undefined entries pick up the system default for their type
// ([0,0,0] for Vec3, 0 for Float, etc.). The boundary's evaluate is
// the single place to do this — it benefits regular subgraph wrappers
// too (any caller passing partial inputs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import { evaluateGraph } from '../../src/core/evaluate.js';
import { createNodeRegistry, type NodeContext } from '../../src/core/node-def.js';
import {
  createEmptySubgraph,
  defineSubgraph,
  type SubgraphDef,
} from '../../src/core/subgraph.js';

function buildSimpleSubgraph(): SubgraphDef {
  // A trivial subgraph: declares a Vec3 input `size` and a Float input
  // `weight`, wires them straight to its output boundary's two sockets
  // so the boundary outputs the user-visible values directly.
  const sg = createEmptySubgraph('test-sg', 'test');
  sg.inputs = [
    { name: 'size', type: 'Vec3' },
    { name: 'weight', type: 'Float' },
  ];
  sg.outputs = [
    { name: 'sizeOut', type: 'Vec3' },
    { name: 'weightOut', type: 'Float' },
  ];
  // Re-add the boundary nodes now that we've declared inputs/outputs.
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${sg.id}`);
  const outputNode = addNode(g, `subgraph-output/${sg.id}`);
  addEdge(g, { node: inputNode.id, socket: 'size' }, { node: outputNode.id, socket: 'sizeOut' });
  addEdge(g, { node: inputNode.id, socket: 'weight' }, { node: outputNode.id, socket: 'weightOut' });
  sg.graph = g;
  sg.inputNodeId = inputNode.id;
  sg.outputNodeId = outputNode.id;
  return sg;
}

test('boundary returns system defaults for every key when caller passes no subgraphInputs at all', async () => {
  const sg = buildSimpleSubgraph();
  const registry = createNodeRegistry();
  for (const def of defineSubgraph(sg, registry)) registry.register(def);
  const ctx: NodeContext = {} as NodeContext;
  const result = await evaluateGraph(sg.graph, registry, {
    rootNodeId: sg.outputNodeId,
    context: ctx,
  });
  assert.deepEqual(result.outputs.sizeOut, [0, 0, 0]);
  assert.equal(result.outputs.weightOut, 0);
});

test('boundary fills in system default for any KEY whose value is undefined (per-key fallback)', async () => {
  const sg = buildSimpleSubgraph();
  const registry = createNodeRegistry();
  for (const def of defineSubgraph(sg, registry)) registry.register(def);
  // Simulating the bridge-eval call path: subgraphInputs IS provided
  // (truthy object), but `size` is explicitly undefined because nothing
  // was wired into it. Old behavior: returns the same object → inner
  // graph reads `undefined` for size → crashes downstream. New
  // behavior: per-key fallback fills size with [0,0,0].
  const ctx: NodeContext = {
    subgraphInputs: { size: undefined, weight: 4.5 },
  } as NodeContext;
  const result = await evaluateGraph(sg.graph, registry, {
    rootNodeId: sg.outputNodeId,
    context: ctx,
  });
  assert.deepEqual(result.outputs.sizeOut, [0, 0, 0]);
  assert.equal(result.outputs.weightOut, 4.5);
});

test('boundary still passes provided values through when the entry is non-undefined', async () => {
  const sg = buildSimpleSubgraph();
  const registry = createNodeRegistry();
  for (const def of defineSubgraph(sg, registry)) registry.register(def);
  const ctx: NodeContext = {
    subgraphInputs: { size: [2, 3, 5], weight: 7 },
  } as NodeContext;
  const result = await evaluateGraph(sg.graph, registry, {
    rootNodeId: sg.outputNodeId,
    context: ctx,
  });
  assert.deepEqual(result.outputs.sizeOut, [2, 3, 5]);
  assert.equal(result.outputs.weightOut, 7);
});

test('per-key fallback also applies to bridge-style subgraphs (the for-each-point reproduction path)', async () => {
  // Build a bridge SubgraphDef and verify its subgraph-input boundary
  // does per-key fallback. The bridge's owner+iterationKind switches
  // defineSubgraph into the bridge path, which has its own
  // boundary-evaluate (and historically a duplicate of the same
  // all-or-nothing bug).
  const bridgeId = 'test-bridge';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${bridgeId}`);
  // iteration-input boundary is part of every bridge's shape but
  // unused in this test (no per-iteration context flowing through).
  addNode(g, `iteration-input/${bridgeId}`);
  const iterOutputNode = addNode(g, `iteration-output/${bridgeId}`);
  addEdge(g,
    { node: inputNode.id, socket: 'size' },
    { node: iterOutputNode.id, socket: 'sizeOut' });
  const bridge: SubgraphDef = {
    id: bridgeId,
    label: 'bridge',
    category: 'Subgraphs',
    inputs: [{ name: 'size', type: 'Vec3' }],
    outputs: [{ name: 'sizeOut', type: 'Vec3' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: iterOutputNode.id,
    owner: { kind: 'iteration-bridge', nodeId: 'fep' },
    iterationKind: 'iter/for-each-point',
  };
  const registry = createNodeRegistry();
  for (const def of defineSubgraph(bridge, registry)) registry.register(def);

  const ctx: NodeContext = {
    subgraphInputs: { size: undefined },
  } as NodeContext;
  const result = await evaluateGraph(bridge.graph, registry, {
    rootNodeId: bridge.outputNodeId,
    context: ctx,
  });
  assert.deepEqual(result.outputs.sizeOut, [0, 0, 0]);
});
