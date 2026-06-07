// Pins the four paste-scenario semantics for subgraph assets.
//
// Verbatim from the user spec for asset→asset:
//   "copy node in asset view -> paste to asset view. Is the same as
//    these steps:
//     1. edit subgraph
//     2. copy all nodes in subgraph
//     3. exit subgraph
//     4. create new subgraph name <original-name>_copy(<n>),
//        if n <= 1 can leave off '(1)'
//     5. paste all the nodes into the new subgraph
//     6. connect the inputs and output the same as a original subgraph"
//
// The bug that motivated this: cloneSubgraphDef shared the original
// SubgraphDef's `inputs` array AND each entry by reference (via
// `{ ...sg }`), so mutating the clone's color_dark default rewrote the
// original's wrapper inputs — every chair pinned to the ORIGINAL
// wood-texture turned red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNode, createGraph } from '../../src/core/graph.js';
import {
  cloneSubgraphDef,
  nextCopyLabel,
} from '../../src/editor/asset-ops.js';
import { createEmptySubgraph } from '../../src/core/subgraph.js';
import type { SubgraphDef } from '../../src/core/subgraph.js';

function makeWoodTexture(): SubgraphDef {
  const sg = createEmptySubgraph('wood-texture', 'Wood Texture');
  sg.inputs = [
    { name: 'color_dark', type: 'Vec4', default: [0.18, 0.1, 0.05, 1] },
    { name: 'color_light', type: 'Vec4', default: [0.6, 0.4, 0.2, 1] },
  ];
  sg.outputs = [{ name: 'material', type: 'Material' }];
  // Add a non-boundary node so we can verify ALL inner nodes get fresh ids.
  addNode(sg.graph, 'core/box', { inputValues: { w: 1, h: 1, d: 1 } });
  return sg;
}

// ─── nextCopyLabel: <name>_copy / <name>_copy(2) / ... ────────────

test('nextCopyLabel: first copy omits "(1)"', () => {
  assert.equal(nextCopyLabel(new Set(), 'wood-texture'), 'wood-texture_copy');
});

test('nextCopyLabel: second copy adds "(2)"', () => {
  const taken = new Set(['wood-texture_copy']);
  assert.equal(nextCopyLabel(taken, 'wood-texture'), 'wood-texture_copy(2)');
});

test('nextCopyLabel: walks until free slot', () => {
  const taken = new Set([
    'wood-texture_copy',
    'wood-texture_copy(2)',
    'wood-texture_copy(3)',
  ]);
  assert.equal(nextCopyLabel(taken, 'wood-texture'), 'wood-texture_copy(4)');
});

// ─── cloneSubgraphDef: deep clone ─────────────────────────────────

test('cloneSubgraphDef: clone has a fresh id and the requested label', () => {
  const orig = makeWoodTexture();
  const clone = cloneSubgraphDef(orig, 'clone-id', null, 'wood-texture_copy');
  assert.equal(clone.id, 'clone-id');
  assert.equal(clone.label, 'wood-texture_copy');
});

test('cloneSubgraphDef: inputs array is a fresh reference (not shared)', () => {
  const orig = makeWoodTexture();
  const clone = cloneSubgraphDef(orig, 'clone-id', null, 'x');
  assert.notEqual(clone.inputs, orig.inputs, 'inputs array shared by reference');
  for (let i = 0; i < orig.inputs.length; i++) {
    assert.notEqual(
      clone.inputs[i],
      orig.inputs[i],
      `inputs[${i}] entry object shared by reference`,
    );
  }
});

test('cloneSubgraphDef: outputs array is a fresh reference (not shared)', () => {
  const orig = makeWoodTexture();
  const clone = cloneSubgraphDef(orig, 'clone-id', null, 'x');
  assert.notEqual(clone.outputs, orig.outputs);
  for (let i = 0; i < orig.outputs.length; i++) {
    assert.notEqual(clone.outputs[i], orig.outputs[i]);
  }
});

test('cloneSubgraphDef: mutating clone defaults leaves original untouched', () => {
  // The original repro from the user: changed clone's color_dark to red,
  // every chair pinned to ORIGINAL wood-texture turned red.
  const orig = makeWoodTexture();
  const clone = cloneSubgraphDef(orig, 'clone-id', null, 'x');
  // Simulate the store mutation: replace the entry with a new one.
  clone.inputs = clone.inputs.map((i) =>
    i.name === 'color_dark' ? { ...i, default: [1, 0, 0, 1] } : i,
  );
  const origEntry = orig.inputs.find((i) => i.name === 'color_dark')!;
  assert.deepEqual(
    origEntry.default,
    [0.18, 0.1, 0.05, 1],
    'original color_dark default was mutated through the shared reference',
  );
});

test('cloneSubgraphDef: ALL internal nodes get fresh ids (not just boundaries)', () => {
  const orig = makeWoodTexture();
  const clone = cloneSubgraphDef(orig, 'clone-id', null, 'x');
  const origIds = new Set(orig.graph.nodes.map((n) => n.id));
  for (const n of clone.graph.nodes) {
    assert.ok(
      !origIds.has(n.id),
      `cloned node id ${n.id} (${n.kind}) collides with original`,
    );
  }
});

test('cloneSubgraphDef: boundary kinds are rewritten to the new subgraph id', () => {
  const orig = makeWoodTexture();
  const clone = cloneSubgraphDef(orig, 'clone-id', null, 'x');
  const input = clone.graph.nodes.find((n) => n.id === clone.inputNodeId);
  const output = clone.graph.nodes.find((n) => n.id === clone.outputNodeId);
  assert.equal(input?.kind, 'subgraph-input/clone-id');
  assert.equal(output?.kind, 'subgraph-output/clone-id');
});

test('cloneSubgraphDef: inputValues are deep-copied (not shared)', () => {
  const orig = makeWoodTexture();
  const clone = cloneSubgraphDef(orig, 'clone-id', null, 'x');
  const origBox = orig.graph.nodes.find((n) => n.kind === 'core/box')!;
  const cloneBox = clone.graph.nodes.find((n) => n.kind === 'core/box')!;
  assert.ok(origBox.inputValues);
  assert.ok(cloneBox.inputValues);
  assert.notEqual(
    origBox.inputValues,
    cloneBox.inputValues,
    'inputValues object shared',
  );
  // Mutate clone — original must stay put.
  cloneBox.inputValues!.w = 99;
  assert.equal(origBox.inputValues!.w, 1);
});

test('cloneSubgraphDef: edges reference the cloned node ids (not the originals)', () => {
  // Build a graph with one real edge so we can verify rewiring.
  const orig = createEmptySubgraph('s', 'S');
  orig.inputs = [{ name: 'v', type: 'Float', default: 0 }];
  orig.outputs = [{ name: 'v', type: 'Float' }];
  // input boundary → output boundary
  orig.graph.edges.push({
    id: 'e1',
    from: { node: orig.inputNodeId, socket: 'v' },
    to: { node: orig.outputNodeId, socket: 'v' },
  });

  const clone = cloneSubgraphDef(orig, 'clone', null, 'S_copy');
  const clonedIds = new Set(clone.graph.nodes.map((n) => n.id));
  for (const e of clone.graph.edges) {
    assert.ok(clonedIds.has(e.from.node), `edge.from.node ${e.from.node} not in cloned nodes`);
    assert.ok(clonedIds.has(e.to.node), `edge.to.node ${e.to.node} not in cloned nodes`);
  }
  assert.equal(clone.graph.edges[0]?.from.node, clone.inputNodeId);
  assert.equal(clone.graph.edges[0]?.to.node, clone.outputNodeId);
});

test('cloneSubgraphDef: version resets to 0', () => {
  const orig = makeWoodTexture();
  orig.version = 17;
  const clone = cloneSubgraphDef(orig, 'clone', null, 'x');
  assert.equal(clone.version, 0);
});

test('cloneSubgraphDef: parentFolderId is set to the requested target', () => {
  const orig = makeWoodTexture();
  orig.parentFolderId = 'old-folder';
  const clone = cloneSubgraphDef(orig, 'clone', 'new-folder', 'x');
  assert.equal(clone.parentFolderId, 'new-folder');
});

test('cloneSubgraphDef: also accepts null parentFolderId (root)', () => {
  const orig = makeWoodTexture();
  orig.parentFolderId = 'old-folder';
  const clone = cloneSubgraphDef(orig, 'clone', null, 'x');
  assert.equal(clone.parentFolderId, null);
});

// ─── Wrapper references inside the clone are intentional ──────────

test('cloneSubgraphDef: wrapper nodes inside the clone still point at the SAME other subgraphs', () => {
  // "Duplicate this subgraph" must not accidentally fork its
  // dependencies — a cloned `chair` should still reference the
  // ORIGINAL wood-texture, not a fork.
  const chair = createEmptySubgraph('chair', 'Chair');
  addNode(chair.graph, 'subgraph/wood-texture', {});
  const clone = cloneSubgraphDef(chair, 'chair-clone', null, 'chair_copy');
  const wrapper = clone.graph.nodes.find((n) =>
    n.kind === 'subgraph/wood-texture',
  );
  assert.ok(wrapper, 'wrapper missing in clone');
  assert.equal(
    wrapper.kind,
    'subgraph/wood-texture',
    'wrapper kind was rewritten — should still reference the original',
  );
});
