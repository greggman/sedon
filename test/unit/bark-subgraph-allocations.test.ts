// Integration-level allocation test driving the actual bark texture
// subgraph through the real eval pipeline. The user reported seeing
// fresh buffers + bind groups every time they edit perlin.octaves
// despite the per-node `reusableTexture` / `reusableBuffer` /
// `getSampler` caches. This test reproduces that scenario against
// the mock GPU and asserts what should happen: same texture handles
// downstream + same bind groups + no buffer allocation for the
// per-node uniforms (which `reusableBuffer` already preserves).
//
// What the bark subgraph looks like (see editor/demos/texture-subgraphs.ts):
//
//   perlin (fibers)  → levels  → colorize  → basecolor
//                              ↘ normal-from-height → normal
//   perlin (detail)  → detail_basecolor
//                    ↘ normal-from-height → detail_normal
//
// Edit perlin.octaves → fibers re-evals, levels/colorize/normal
// cascade. Detail chain doesn't move. So a single edit shouldn't
// allocate ANY new GPUBuffer or GPUBindGroup if every node in the
// chain reuses correctly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockDevice } from '../mock-gpu.js';
import { createEvalCache } from '../../src/core/eval-cache.js';
import { evaluateGraph } from '../../src/core/evaluate.js';
import { defineSubgraph } from '../../src/core/subgraph.js';
import { createCoreNodeRegistry } from '../../src/nodes/index.js';
import { buildBarkTextureSubgraph } from '../../src/editor/demos/texture-subgraphs.js';

function buildRegistry() {
  const r = createCoreNodeRegistry();
  const bark = buildBarkTextureSubgraph();
  for (const def of defineSubgraph(bark, r)) r.register(def);
  return { registry: r, bark };
}

test('bark subgraph: editing perlin.octaves allocates zero buffers + zero bind groups after the warm-up eval', async () => {
  const device = createMockDevice();
  const { registry, bark } = buildRegistry();
  const cache = createEvalCache();

  // Warm-up eval: every node runs once, populates the cache, allocates
  // its texture / uniform buffer / bind group.
  await evaluateGraph(bark.graph, registry, {
    rootNodeId: bark.outputNodeId,
    context: { device: device as unknown as GPUDevice, evalCache: cache },
    cache,
  });
  const base = {
    createdBuffers: device.stats.createdBuffers,
    createdBindGroups: device.stats.createdBindGroups,
    createdTextures: device.stats.createdTextures,
    destroyedBuffers: device.stats.destroyedBuffers,
    destroyedTextures: device.stats.destroyedTextures,
  };

  // Find the fibers perlin (the one with anisotropic scale [2,14]).
  const fibers = bark.graph.nodes.find(
    (n) =>
      n.kind === 'core/perlin' &&
      Array.isArray(n.inputValues?.scale) &&
      (n.inputValues!.scale as number[])[1] === 14,
  );
  assert.ok(fibers, 'fibers perlin not found in the bark subgraph');

  // Edit perlin.octaves. Has to mutate the saved graph node so the
  // next evaluateGraph picks up the change — this mirrors what
  // store.setInputValue does (it constructs a new graph with the
  // changed node; we just shortcut by mutating the inputValues
  // record in place, which is fine for the test).
  fibers.inputValues = { ...fibers.inputValues, octaves: 2 };

  // Drag tick #1: re-eval. With everything cached this should
  // allocate nothing — perlin re-renders into its existing texture
  // via reusableTexture + reusableBuffer + reusableBindGroup;
  // levels/colorize/normal-from-height all cascade through their
  // own reusable resources.
  await evaluateGraph(bark.graph, registry, {
    rootNodeId: bark.outputNodeId,
    context: { device: device as unknown as GPUDevice, evalCache: cache },
    cache,
  });
  const after = {
    createdBuffers: device.stats.createdBuffers,
    createdBindGroups: device.stats.createdBindGroups,
    createdTextures: device.stats.createdTextures,
    destroyedBuffers: device.stats.destroyedBuffers,
    destroyedTextures: device.stats.destroyedTextures,
  };

  assert.equal(
    after.createdTextures - base.createdTextures,
    0,
    'editing perlin.octaves should not allocate any new textures',
  );
  assert.equal(
    after.createdBuffers - base.createdBuffers,
    0,
    'editing perlin.octaves should not allocate any new buffers',
  );
  assert.equal(
    after.createdBindGroups - base.createdBindGroups,
    0,
    'editing perlin.octaves should not allocate any new bind groups',
  );
  assert.equal(
    after.destroyedBuffers - base.destroyedBuffers,
    0,
    'editing perlin.octaves should not destroy any buffers (nothing to free)',
  );
});
