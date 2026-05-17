// Reproduces the exact call path from the user's stack trace:
//
//   GPUDevice.createBuffer (pbr-kind.ts:147, buildBindGroup)
//   ← scene.ts:622 (setScene)
//   ← scene-preview.tsx:95 (renderer.setScene(scene))
//
// The flow is:
//   1. Evaluate the bark texture subgraph (asset thumbnail does this on
//      every eval round).
//   2. Synthesize a tile from the result.outputs (planeWithBasecolor —
//      builds a fresh PbrMaterial wrapping the basecolor Texture2DValue).
//   3. Pass that scene to a SceneRenderer via setScene.
//   4. Edit perlin.octaves.
//   5. Re-evaluate. Re-synthesize. setScene again.
//
// The texture handle inside the produced material SHOULD be stable
// across edits (perlin's `reusableTexture` reuses the same GPUTexture).
// Therefore materialStructuralKey should match between calls, materialCache
// hits, no createBuffer for the per-material paramBuffer.
//
// If this test FAILS (createBuffer count > 0 on the second setScene),
// we've reproduced the bug and can fix it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockDevice } from '../mock-gpu.js';
import { createEvalCache } from '../../src/core/eval-cache.js';
import { evaluateGraph } from '../../src/core/evaluate.js';
import { defineSubgraph } from '../../src/core/subgraph.js';
import { createCoreNodeRegistry } from '../../src/nodes/index.js';
import { buildBarkTextureSubgraph } from '../../src/editor/demos/texture-subgraphs.js';
import { synthesizeTiles } from '../../src/editor/preview-synth.js';
import { defaultLighting } from '../../src/core/resources.js';
import { createSceneRenderer } from '../../src/render/scene.js';

test('bark eval → synthesizeTiles → setScene: editing perlin.octaves does not allocate buffers on the second setScene', async () => {
  const device = createMockDevice();
  const registry = createCoreNodeRegistry();
  const bark = buildBarkTextureSubgraph();
  for (const def of defineSubgraph(bark, registry)) registry.register(def);

  const cache = createEvalCache();
  const renderer = createSceneRenderer(
    device as unknown as GPUDevice,
    'rgba8unorm',
  );

  // Find the bark wrapper's "fibers" perlin (the anisotropic one
  // driving the wood grain).
  const fibers = bark.graph.nodes.find(
    (n) =>
      n.kind === 'core/perlin' &&
      Array.isArray(n.inputValues?.scale) &&
      (n.inputValues!.scale as number[])[1] === 14,
  );
  if (!fibers) throw new Error('fibers perlin not found');

  // Look up the bark wrapper's NodeDef so we can hand its outputs list
  // to synthesizeTiles (matches how AssetThumbnail does it: `rootDef`
  // comes from the wrapper def registered above).
  const rootDef = registry.get(`subgraph/${bark.id}`);

  async function runOnePass(): Promise<void> {
    // We evaluate the BARK WRAPPER (not the inner graph) because that's
    // what AssetThumbnail does — it resolves the subgraph kind and
    // evaluates it as if a wrapper instance.
    //
    // Actually the asset thumbnail evaluates `bark.graph` directly with
    // `rootNodeId = bark.outputNodeId`. Match that here.
    const result = await evaluateGraph(bark.graph, registry, {
      rootNodeId: bark.outputNodeId,
      context: { device: device as unknown as GPUDevice, evalCache: cache },
      cache,
    });
    // Same synthesis path AssetThumbnail uses:
    //   tiles = synthesizeTiles(device, rootDef, result.outputs, lighting)
    //   scene = tiles.find(t => t.scene.entities.length > 0)?.scene
    const tiles = synthesizeTiles(
      device as unknown as GPUDevice,
      rootDef,
      result.outputs,
      defaultLighting(),
    );
    // Use the bark *subgraph's* output list as `rootDef.outputs`. The
    // wrapper NodeDef created by defineSubgraph mirrors the subgraph's
    // outputs (basecolor / normal / detail_basecolor / detail_normal),
    // so synthesizeTiles will produce one tile per output. We take the
    // first that actually has a value — matches what the bark thumbnail
    // would display.
    const scene = tiles.find((t) => t.scene.entities.length > 0)?.scene;
    if (!scene) throw new Error('no renderable scene synthesized from bark outputs');
    renderer.setScene(scene);
  }

  // Initial pass — populates the eval cache AND the renderer's
  // materialCache for whatever material the synthesized plane uses.
  await runOnePass();
  const base = {
    createdBuffers: device.stats.createdBuffers,
    createdBindGroups: device.stats.createdBindGroups,
    createdTextures: device.stats.createdTextures,
  };

  // Edit perlin.octaves and re-run. With everything reusable in the
  // chain, this should be ZERO new allocations.
  fibers.inputValues = { ...fibers.inputValues, octaves: 3 };
  await runOnePass();
  const after = {
    createdBuffers: device.stats.createdBuffers,
    createdBindGroups: device.stats.createdBindGroups,
    createdTextures: device.stats.createdTextures,
  };

  assert.equal(
    after.createdBuffers - base.createdBuffers,
    0,
    `edit should not allocate buffers (allocated ${after.createdBuffers - base.createdBuffers})`,
  );
  assert.equal(
    after.createdBindGroups - base.createdBindGroups,
    0,
    `edit should not allocate bind groups (allocated ${after.createdBindGroups - base.createdBindGroups})`,
  );
  assert.equal(
    after.createdTextures - base.createdTextures,
    0,
    `edit should not allocate textures (allocated ${after.createdTextures - base.createdTextures})`,
  );

  renderer.destroy();
});
