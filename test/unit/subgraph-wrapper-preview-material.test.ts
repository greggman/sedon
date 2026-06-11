// Regression: dropping a subgraph wrapper on a parent canvas (e.g.
// `subgraph/cushion` from the assets panel) used to show no node
// preview when the wrapper's Material input was unwired. The
// `subgraph-input` boundary already supplied a lazy 1×1 grey
// preview Material for the STANDALONE preview path, but the parent-
// graph evaluator's input-resolution bailed out (`canEvaluate =
// false`) before it ever called the wrapper because the wrapper's
// Material input had no wire, no inputValue, and no `default`.
//
// Fix: the wrapper NodeDef now marks unwired Material / Texture2D
// inputs as `optional`. Parent evaluator passes them through as
// undefined; the wrapper's evaluate forwards undefined to the inner
// boundary via `subgraphInputs`; `resolveBoundaryInputs` injects the
// lazy preview material. End result: the wrapper evaluates and the
// canvas thumbnail renders.

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

// Same minimal fake GPUDevice as the boundary-side regression test.
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
function makeFakeDevice(): GPUDevice {
  const fakeTexture = { stub: 'preview-texture' } as unknown as GPUTexture;
  return {
    createTexture: () => fakeTexture,
    queue: { writeTexture: () => {} },
  } as unknown as GPUDevice;
}

// Smallest subgraph that mirrors the cushion's surface: one
// Material input (no default), passthrough to a Material output.
function buildMaterialSinkSubgraph(): SubgraphDef {
  const id = 'mat-sink';
  const sg = createEmptySubgraph(id, 'mat-sink');
  sg.inputs = [{ name: 'material', type: 'Material' }];
  sg.outputs = [{ name: 'materialOut', type: 'Material' }];
  const inner = createGraph();
  const inputBoundary = addNode(inner, `subgraph-input/${id}`);
  const outputBoundary = addNode(inner, `subgraph-output/${id}`);
  addEdge(inner,
    { node: inputBoundary.id, socket: 'material' },
    { node: outputBoundary.id, socket: 'materialOut' });
  sg.graph = inner;
  sg.inputNodeId = inputBoundary.id;
  sg.outputNodeId = outputBoundary.id;
  return sg;
}

test('wrapper on a parent canvas: unwired Material input still resolves via the lazy preview default', async () => {
  // Parent graph with just the wrapper, NO material wired in.
  const sg = buildMaterialSinkSubgraph();
  const registry = createNodeRegistry();
  for (const def of defineSubgraph(sg, registry)) registry.register(def);

  const parent = createGraph();
  const wrap = addNode(parent, `subgraph/${sg.id}`);
  const result = await evaluateGraph(parent, registry, {
    rootNodeId: wrap.id,
    context: { device: makeFakeDevice() },
  });
  // Without the fix this would be undefined because the parent
  // evaluator would skip the wrapper entirely.
  const mat = result.outputs.materialOut as { kind: string; basecolor: unknown } | undefined;
  assert.ok(mat, 'wrapper must evaluate and emit a Material when the input is unwired');
  assert.equal(mat.kind, 'pbr');
  assert.ok(mat.basecolor, 'preview material carries a basecolor texture');
});

test('wrapper marks Material / Texture2D inputs as optional (so the parent evaluator passes undefined through)', () => {
  const sg = buildMaterialSinkSubgraph();
  const defs = defineSubgraph(sg, createNodeRegistry());
  const wrapper = defs.find((d) => d.id === `subgraph/${sg.id}`)!;
  const mat = wrapper.inputs.find((i) => i.name === 'material')!;
  assert.equal(mat.optional, true);
});

test('wrapper LEAVES non-Material/Texture2D inputs as their author declared (no blanket optional)', () => {
  // Float inputs without defaults must still cause the evaluator to
  // bail when unwired — the lazy-preview-material trick only applies
  // to GPU-resource types that have no static default but DO have a
  // lazy preview path.
  const sg = createEmptySubgraph('mixed', 'mixed');
  sg.inputs = [
    { name: 'material', type: 'Material' }, // optional via our fix
    { name: 'width',    type: 'Float' },    // unchanged
    { name: 'segs',     type: 'Int', default: 16 }, // unchanged (has default)
  ];
  sg.outputs = [{ name: 'materialOut', type: 'Material' }];
  const inner = createGraph();
  const inputBoundary = addNode(inner, `subgraph-input/${sg.id}`);
  const outputBoundary = addNode(inner, `subgraph-output/${sg.id}`);
  addEdge(inner,
    { node: inputBoundary.id, socket: 'material' },
    { node: outputBoundary.id, socket: 'materialOut' });
  sg.graph = inner;
  sg.inputNodeId = inputBoundary.id;
  sg.outputNodeId = outputBoundary.id;

  const defs = defineSubgraph(sg, createNodeRegistry());
  const wrapper = defs.find((d) => d.id === `subgraph/${sg.id}`)!;
  const inputsByName = Object.fromEntries(wrapper.inputs.map((i) => [i.name, i]));
  assert.equal(inputsByName['material']!.optional, true, 'Material made optional');
  // Float without default stays NON-optional — the parent evaluator's
  // existing "skip when required input has no value" behaviour still
  // catches user wiring mistakes.
  assert.notStrictEqual(inputsByName['width']!.optional, true);
  // Int with author default is also untouched.
  assert.notStrictEqual(inputsByName['segs']!.optional, true);
});

test('wrapper does NOT overwrite a Material input the author already marked optional', () => {
  const sg = createEmptySubgraph('preset', 'preset');
  sg.inputs = [{ name: 'material', type: 'Material', optional: true }];
  sg.outputs = [{ name: 'materialOut', type: 'Material' }];
  const inner = createGraph();
  const inputBoundary = addNode(inner, `subgraph-input/${sg.id}`);
  const outputBoundary = addNode(inner, `subgraph-output/${sg.id}`);
  addEdge(inner,
    { node: inputBoundary.id, socket: 'material' },
    { node: outputBoundary.id, socket: 'materialOut' });
  sg.graph = inner;
  sg.inputNodeId = inputBoundary.id;
  sg.outputNodeId = outputBoundary.id;

  const defs = defineSubgraph(sg, createNodeRegistry());
  const wrapper = defs.find((d) => d.id === `subgraph/${sg.id}`)!;
  const mat = wrapper.inputs.find((i) => i.name === 'material')!;
  assert.equal(mat.optional, true);
});

test('wrapper does NOT overwrite an input the author gave a default to', () => {
  // If the SubgraphDef author wrote a Material default (today: no
  // sensible one exists in Sedon, but the test pins the policy),
  // that default takes precedence over the lazy preview material
  // and `optional` should NOT be flipped on.
  const sg = createEmptySubgraph('with-default', 'with-default');
  const authorDefault = { kind: 'sentinel' };
  sg.inputs = [{ name: 'material', type: 'Material', default: authorDefault }];
  sg.outputs = [{ name: 'materialOut', type: 'Material' }];
  const inner = createGraph();
  const inputBoundary = addNode(inner, `subgraph-input/${sg.id}`);
  const outputBoundary = addNode(inner, `subgraph-output/${sg.id}`);
  addEdge(inner,
    { node: inputBoundary.id, socket: 'material' },
    { node: outputBoundary.id, socket: 'materialOut' });
  sg.graph = inner;
  sg.inputNodeId = inputBoundary.id;
  sg.outputNodeId = outputBoundary.id;

  const defs = defineSubgraph(sg, createNodeRegistry());
  const wrapper = defs.find((d) => d.id === `subgraph/${sg.id}`)!;
  const mat = wrapper.inputs.find((i) => i.name === 'material')!;
  assert.notStrictEqual(mat.optional, true);
});
