// Regression: a `[r,g,b,a]` value arriving at a Texture2D input —
// from any of the three sources (a wired Color edge, an inputValue,
// or an InputDef.default) — must be auto-promoted to a 1×1 cached
// Texture2DValue before the node's evaluate runs. This is what lets
// the user skip a `core/solid-color` node for the "this material
// slot is just this colour" case AND lets builtin nodes declare a
// sensible Texture2D default that the inline color picker writes
// through.
//
// Cache semantics matter as much as the conversion itself: a 4×4
// grid of cabinets that all use the same basecolor colour must share
// ONE underlying GPUTexture handle. Without that, the renderer's
// (geometry, material) batching breaks — each entity gets its own
// material, no instancing, frame-time regresses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import { evaluateGraph } from '../../src/core/evaluate.js';
import {
  createNodeRegistry,
  type NodeContext,
  type NodeDef,
  type NodeRegistry,
} from '../../src/core/node-def.js';
import type { Texture2DValue } from '../../src/core/resources.js';

// Node 0 stubs (no node-test infra runs WebGPU). We need the WebGPU
// constants object for getColorTexture's `device.createTexture` call.
const g = globalThis as unknown as { GPUTextureUsage?: Record<string, number> };
if (!g.GPUTextureUsage) {
  g.GPUTextureUsage = {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
  };
}

// Each `createTexture` call returns a unique object (so the cache
// key test can detect duplicate allocations). queue.writeTexture
// is a no-op — we just need it to exist.
function makeFakeDevice(): { device: GPUDevice; createCount: () => number } {
  let count = 0;
  const device = {
    createTexture: () => {
      count++;
      return { __id: count } as unknown as GPUTexture;
    },
    queue: { writeTexture: () => {} },
  } as unknown as GPUDevice;
  return { device, createCount: () => count };
}

// Capture-the-input stub: records the resolved input value the
// evaluator hands to this node's `evaluate`. Lets tests assert on
// the post-promotion shape without needing real GPU plumbing.
function makeCaptureNode(): { def: NodeDef; capture: () => unknown } {
  let captured: unknown = undefined;
  const def: NodeDef = {
    id: 'test/capture-tex',
    category: '__test__',
    inputs: [
      { name: 'tex', type: 'Texture2D', default: [1, 0, 0, 1] },
    ],
    outputs: [],
    evaluate(_ctx, inputs) {
      captured = inputs.tex;
      return {};
    },
  };
  return { def, capture: () => captured };
}

function makeColorSource(): NodeDef {
  return {
    id: 'test/c2tex-color-source',
    category: '__test__',
    inputs: [{ name: 'color', type: 'Color', default: [0, 1, 0, 1] }],
    outputs: [{ name: 'color', type: 'Color' }],
    evaluate(_ctx, inputs) {
      return { color: inputs.color };
    },
  };
}

function buildRegistry(captureDef: NodeDef): NodeRegistry {
  const reg = createNodeRegistry();
  reg.register(captureDef);
  reg.register(makeColorSource());
  return reg;
}

test('Texture2D InputDef.default of [r,g,b,a] promotes to a real Texture2DValue at eval time', async () => {
  const { def: captureDef, capture } = makeCaptureNode();
  const reg = buildRegistry(captureDef);
  const { device } = makeFakeDevice();
  const graph = createGraph();
  const node = addNode(graph, 'test/capture-tex');
  await evaluateGraph(graph, reg, {
    rootNodeId: node.id,
    context: { device } as NodeContext,
  });
  const got = capture() as Texture2DValue;
  assert.ok(got, 'captured value is defined');
  assert.equal(got.format, 'rgba8unorm');
  assert.equal(got.width, 1);
  assert.equal(got.height, 1);
  assert.ok(got.texture, 'has a GPUTexture handle');
});

test('Texture2D inputValue of [r,g,b,a] (per-instance picker override) promotes too', async () => {
  const { def: captureDef, capture } = makeCaptureNode();
  const reg = buildRegistry(captureDef);
  const { device } = makeFakeDevice();
  const graph = createGraph();
  // inputValue overrides the InputDef.default — same path the
  // inspector's inline color picker writes through.
  const node = addNode(graph, 'test/capture-tex', {
    inputValues: { tex: [0, 0, 1, 1] },
  });
  await evaluateGraph(graph, reg, {
    rootNodeId: node.id,
    context: { device } as NodeContext,
  });
  const got = capture() as Texture2DValue;
  assert.ok(got);
  assert.ok(got.texture);
});

test('Color → Texture2D wire promotes the wired colour to a 1×1 texture', async () => {
  const { def: captureDef, capture } = makeCaptureNode();
  const reg = buildRegistry(captureDef);
  const { device } = makeFakeDevice();
  const graph = createGraph();
  const src = addNode(graph, 'test/c2tex-color-source', {
    inputValues: { color: [0.7, 0.2, 0.4, 1] },
  });
  const sink = addNode(graph, 'test/capture-tex');
  addEdge(graph, { node: src.id, socket: 'color' }, { node: sink.id, socket: 'tex' });
  await evaluateGraph(graph, reg, {
    rootNodeId: sink.id,
    context: { device } as NodeContext,
  });
  const got = capture() as Texture2DValue;
  assert.ok(got);
  assert.ok(got.texture);
});

test('cache: two nodes with the same colour share a single GPUTexture (renderer batching invariant)', async () => {
  // Three capture nodes, three inputValue colours: A, A, B. The
  // cache should produce 2 distinct GPUTexture allocations
  // (A and B), not 3 — same-color reuse is what keeps the renderer
  // batching 4×4 cabinets into a few draws.
  const captures: { def: NodeDef; capture: () => unknown }[] = [];
  const reg = createNodeRegistry();
  for (let i = 0; i < 3; i++) {
    let captured: unknown = undefined;
    const def: NodeDef = {
      id: `test/cap-${i}`,
      category: '__test__',
      inputs: [{ name: 'tex', type: 'Texture2D', default: [1, 0, 0, 1] }],
      outputs: [],
      evaluate(_ctx, inputs) { captured = inputs.tex; return {}; },
    };
    captures.push({ def, capture: () => captured });
    reg.register(def);
  }
  const { device, createCount } = makeFakeDevice();
  const graph = createGraph();
  const a1 = addNode(graph, 'test/cap-0', { inputValues: { tex: [0.5, 0.5, 0.5, 1] } });
  const a2 = addNode(graph, 'test/cap-1', { inputValues: { tex: [0.5, 0.5, 0.5, 1] } });
  const b = addNode(graph, 'test/cap-2', { inputValues: { tex: [0.1, 0.2, 0.3, 1] } });
  // Each node is its own root so the test evaluates them all (eval
  // walks ancestors from the root; a single root that doesn't
  // depend on the others would skip them).
  await evaluateGraph(graph, reg, { rootNodeId: a1.id, context: { device } as NodeContext });
  await evaluateGraph(graph, reg, { rootNodeId: a2.id, context: { device } as NodeContext });
  await evaluateGraph(graph, reg, { rootNodeId: b.id, context: { device } as NodeContext });
  assert.equal(createCount(), 2, 'one GPUTexture per distinct colour, not per node');
  const t1 = captures[0]!.capture() as Texture2DValue;
  const t2 = captures[1]!.capture() as Texture2DValue;
  const t3 = captures[2]!.capture() as Texture2DValue;
  assert.strictEqual(t1.texture, t2.texture, 'same colour shares the texture handle');
  assert.notStrictEqual(t1.texture, t3.texture, 'different colour gets a distinct handle');
});

test('Texture2D socket receiving a real Texture2DValue (not a color array) passes through unchanged', async () => {
  // The promotion only fires for `[r,g,b,a]` shapes. A genuine
  // Texture2DValue (from an upstream texture-producing node) must
  // pass through untouched — otherwise we'd be re-allocating
  // material textures every eval round.
  const { def: captureDef, capture } = makeCaptureNode();
  const reg = createNodeRegistry();
  reg.register(captureDef);
  const realTexture = {
    texture: { __id: 'real' } as unknown as GPUTexture,
    format: 'rgba8unorm' as GPUTextureFormat,
    width: 256,
    height: 256,
    revision: 5,
  };
  const sourceDef: NodeDef = {
    id: 'test/tex-source',
    category: '__test__',
    inputs: [],
    outputs: [{ name: 'tex', type: 'Texture2D' }],
    evaluate() { return { tex: realTexture }; },
  };
  reg.register(sourceDef);
  const { device } = makeFakeDevice();
  const graph = createGraph();
  const src = addNode(graph, 'test/tex-source');
  const sink = addNode(graph, 'test/capture-tex');
  addEdge(graph, { node: src.id, socket: 'tex' }, { node: sink.id, socket: 'tex' });
  await evaluateGraph(graph, reg, {
    rootNodeId: sink.id,
    context: { device } as NodeContext,
  });
  assert.strictEqual(capture(), realTexture, 'real Texture2DValue passes through unchanged');
});
