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

// Helper: run the user's flow against one cache shared by N consumers.
// Each "consumer" gets its own evaluateGraph call. After every edit
// every consumer re-evaluates against the shared cache. Counters live
// on the mock device so the test can assert "edit caused N more
// createBuffer calls" vs "edit caused 0".
async function simulateUserFlow(opts: {
  evalsPerRound: ('standalone' | 'viaWrapper')[];
}) {
  const device = createMockDevice();
  const { registry, bark } = buildRegistry();
  const cache = createEvalCache();

  // Wrap bark in a synthetic "tree" wrapper so the viaWrapper path
  // exercises the wrapper.evaluate code-path (which sets up
  // subgraphInputFingerprints and uses scope: 'rootAncestors'). The
  // wrapper kind is just `subgraph/<bark.id>` — we instantiate it in
  // a tiny outer graph.
  const wrapperGraph = {
    version: 1 as const,
    nodes: [
      { id: 'bark-instance', kind: `subgraph/${bark.id}` },
    ],
    edges: [],
  };

  async function runRound(): Promise<void> {
    for (const kind of opts.evalsPerRound) {
      if (kind === 'standalone') {
        await evaluateGraph(bark.graph, registry, {
          rootNodeId: bark.outputNodeId,
          context: { device: device as unknown as GPUDevice, evalCache: cache },
          cache,
        });
      } else {
        await evaluateGraph(wrapperGraph, registry, {
          rootNodeId: 'bark-instance',
          context: { device: device as unknown as GPUDevice, evalCache: cache },
          cache,
        });
      }
    }
  }

  // Find fibers perlin so we can mutate octaves.
  const fibers = bark.graph.nodes.find(
    (n) =>
      n.kind === 'tex/perlin' &&
      Array.isArray(n.inputValues?.scale) &&
      (n.inputValues!.scale as number[])[1] === 14,
  );
  if (!fibers) throw new Error('fibers perlin not found');

  // Round 1 — warm-up. Populates cache for both consumer trackerKeys.
  await runRound();
  // Round 2 — edit octaves 4 → 3. This is the user's "step 4".
  fibers.inputValues = { ...fibers.inputValues, octaves: 3 };
  const before4 = {
    createdBuffers: device.stats.createdBuffers,
    createdBindGroups: device.stats.createdBindGroups,
    createdTextures: device.stats.createdTextures,
  };
  await runRound();
  const after4 = {
    createdBuffers: device.stats.createdBuffers,
    createdBindGroups: device.stats.createdBindGroups,
    createdTextures: device.stats.createdTextures,
  };
  // Round 3 — edit octaves 3 → 2. This is the user's "step 5".
  fibers.inputValues = { ...fibers.inputValues, octaves: 2 };
  await runRound();
  const after5 = {
    createdBuffers: device.stats.createdBuffers,
    createdBindGroups: device.stats.createdBindGroups,
    createdTextures: device.stats.createdTextures,
  };
  return {
    step4Delta: {
      buffers: after4.createdBuffers - before4.createdBuffers,
      bindGroups: after4.createdBindGroups - before4.createdBindGroups,
      textures: after4.createdTextures - before4.createdTextures,
    },
    step5Delta: {
      buffers: after5.createdBuffers - after4.createdBuffers,
      bindGroups: after5.createdBindGroups - after4.createdBindGroups,
      textures: after5.createdTextures - after4.createdTextures,
    },
  };
}

test('bark scenario: two consumers (viaWrapper + standalone) on the same cache — first edit allocates same as second edit', async () => {
  // Reproduces the user's "step 4 allocates, step 5 doesn't" report.
  // Both rounds use the same eval order: viaWrapper, then standalone.
  // The asymmetry (if any) would mean the first re-eval hits a state
  // the second doesn't — typically a stale trackerKey or an evicted
  // previousOutput.
  const { step4Delta, step5Delta } = await simulateUserFlow({
    evalsPerRound: ['viaWrapper', 'standalone'],
  });
  assert.deepEqual(
    step4Delta,
    step5Delta,
    `first edit and second edit should have identical allocation deltas (got step4=${JSON.stringify(step4Delta)} vs step5=${JSON.stringify(step5Delta)})`,
  );
});

test('bark scenario: two consumers — edit allocates zero new resources on either edit', async () => {
  const { step4Delta, step5Delta } = await simulateUserFlow({
    evalsPerRound: ['viaWrapper', 'standalone'],
  });
  assert.equal(step4Delta.buffers, 0, `step 4 should not allocate buffers (allocated ${step4Delta.buffers})`);
  assert.equal(step5Delta.buffers, 0, `step 5 should not allocate buffers (allocated ${step5Delta.buffers})`);
  assert.equal(step4Delta.bindGroups, 0, `step 4 should not allocate bind groups (allocated ${step4Delta.bindGroups})`);
  assert.equal(step5Delta.bindGroups, 0, `step 5 should not allocate bind groups (allocated ${step5Delta.bindGroups})`);
  assert.equal(step4Delta.textures, 0, `step 4 should not allocate textures (allocated ${step4Delta.textures})`);
  assert.equal(step5Delta.textures, 0, `step 5 should not allocate textures (allocated ${step5Delta.textures})`);
});

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
      n.kind === 'tex/perlin' &&
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
