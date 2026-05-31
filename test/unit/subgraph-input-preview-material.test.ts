// Regression: a body subgraph that takes a Material input previews
// standalone via a lazy GPU default supplied by the subgraph-input
// boundary. Material has no static default (it carries GPU texture
// handles that don't exist until something runs against a device),
// so the boundary builds a 1×1 grey PBR material per device — cached
// — when the wrapper hasn't supplied one. Without this, scene-entity
// sees `undefined` material, emits an empty scene, and the Assets-
// panel thumbnail / standalone preview shows nothing.
//
// User report: loading the for-each-point demo, "Cabinet cell" in the
// Assets panel rendered blank. Root cause was the missing Material
// default. Fix lives in src/core/subgraph.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import { evaluateGraph } from '../../src/core/evaluate.js';
import { createNodeRegistry } from '../../src/core/node-def.js';
import {
  createEmptySubgraph,
  defineSubgraph,
  type SubgraphDef,
} from '../../src/core/subgraph.js';

// Node doesn't expose the WebGPU constants; the preview-Texture builder
// references `GPUTextureUsage.{TEXTURE_BINDING,COPY_DST}`. The numeric
// values match the WebGPU spec — usage bits are stable and the fake
// device never reads them, so the constants just have to exist.
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

// Minimal fake GPUDevice: createTexture + queue.writeTexture is all
// getPreviewTexture2D needs. Returns a stable handle so the per-device
// cache works correctly and a second call returns the same reference.
function makeFakeDevice(): GPUDevice {
  const fakeTexture = { stub: 'preview-texture' } as unknown as GPUTexture;
  return {
    createTexture: () => fakeTexture,
    queue: { writeTexture: () => {} },
  } as unknown as GPUDevice;
}

// The smallest subgraph that exercises the path: declares a single
// Material input, wires it through to its scene-output side via a
// passthrough that just records what the boundary handed it. Asserts
// the boundary now supplies a flat PBR material for standalone
// preview where it used to supply undefined.
function buildMaterialSinkSubgraph(): SubgraphDef {
  const id = 'mat-sink';
  const sg = createEmptySubgraph(id, 'mat-sink');
  sg.inputs = [{ name: 'material', type: 'Material' }];
  sg.outputs = [{ name: 'materialOut', type: 'Material' }];
  const g = createGraph();
  const inputBoundary = addNode(g, `subgraph-input/${id}`);
  const outputBoundary = addNode(g, `subgraph-output/${id}`);
  addEdge(g,
    { node: inputBoundary.id, socket: 'material' },
    { node: outputBoundary.id, socket: 'materialOut' });
  sg.graph = g;
  sg.inputNodeId = inputBoundary.id;
  sg.outputNodeId = outputBoundary.id;
  return sg;
}

test('subgraph-input boundary supplies a lazy preview Material when unwired and a device is available', async () => {
  const sg = buildMaterialSinkSubgraph();
  const registry = createNodeRegistry();
  for (const def of defineSubgraph(sg, registry)) registry.register(def);
  const result = await evaluateGraph(sg.graph, registry, {
    rootNodeId: sg.outputNodeId,
    context: { device: makeFakeDevice() },
  });
  const mat = result.outputs.materialOut as { kind: string; basecolor: unknown };
  assert.ok(mat, 'output materialOut is defined');
  assert.equal(mat.kind, 'pbr');
  assert.ok(mat.basecolor, 'preview material carries a basecolor texture');
});

test('subgraph-input boundary leaves Material undefined when no device is available (server-side / non-GPU eval)', async () => {
  // Non-GPU contexts (currently none in the editor, but possible for
  // future server-side or test paths) shouldn't fabricate a Material.
  // Behavior matches the previous "missing material" path: scene-entity
  // would emit an empty scene gracefully.
  const sg = buildMaterialSinkSubgraph();
  const registry = createNodeRegistry();
  for (const def of defineSubgraph(sg, registry)) registry.register(def);
  const result = await evaluateGraph(sg.graph, registry, {
    rootNodeId: sg.outputNodeId,
    context: {},
  });
  assert.equal(result.outputs.materialOut, undefined);
});

test('explicit wrapper-supplied material wins over the lazy preview default', async () => {
  // Whatever the wrapper passes for `material` flows through, even
  // with a device available. The lazy default only fills genuinely-
  // undefined entries.
  const sg = buildMaterialSinkSubgraph();
  const registry = createNodeRegistry();
  for (const def of defineSubgraph(sg, registry)) registry.register(def);
  const explicitMaterial = { kind: 'pbr', basecolor: { sentinel: 'wired' } };
  const result = await evaluateGraph(sg.graph, registry, {
    rootNodeId: sg.outputNodeId,
    context: {
      device: makeFakeDevice(),
      subgraphInputs: { material: explicitMaterial },
    },
  });
  assert.strictEqual(result.outputs.materialOut, explicitMaterial);
});

test('per-device cache: two evals against the same device share the same preview Material instance', async () => {
  const sg = buildMaterialSinkSubgraph();
  const registry = createNodeRegistry();
  for (const def of defineSubgraph(sg, registry)) registry.register(def);
  const device = makeFakeDevice();
  const a = await evaluateGraph(sg.graph, registry, {
    rootNodeId: sg.outputNodeId,
    context: { device },
  });
  const b = await evaluateGraph(sg.graph, registry, {
    rootNodeId: sg.outputNodeId,
    context: { device },
  });
  assert.strictEqual(a.outputs.materialOut, b.outputs.materialOut,
    'preview Material is cached per device, not reallocated');
});
