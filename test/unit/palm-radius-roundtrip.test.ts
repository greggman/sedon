// Regression for the user's report: open Tree & Bush → Branch Palm,
// set the fronds-sample-points radiusMin 0 → 1 (palm disappears, as
// expected for that filter), then back to 0 → palm doesn't come back.
//
// The invariant under test is *determinism through the eval cache*:
// evaluating the same graph with the same inputs must produce a
// structurally-equivalent scene regardless of what was evaluated in
// between. Specifically, eval(radiusMin=0) followed by
// eval(radiusMin=1) followed by eval(radiusMin=0) must give the
// scene we got on the first round.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockDevice } from '../mock-gpu.js';
import { createEvalCache, sweepCache } from '../../src/core/eval-cache.js';
import { evaluateGraph } from '../../src/core/evaluate.js';
import { defineSubgraph } from '../../src/core/subgraph.js';
import { createCoreNodeRegistry } from '../../src/nodes/index.js';
import {
  buildBarkTextureSubgraph,
} from '../../src/editor/demos/texture-subgraphs.js';
import { buildBranchPalmSubgraph } from '../../src/editor/demos/tree-bush-subgraphs.js';
import type { GeometryValue, SceneEntity, SceneValue } from '../../src/core/resources.js';

function structuralSnapshot(scene: SceneValue): Array<{
  indexCount: number;
  positionByteLen: number;
}> {
  return scene.entities.map((e: SceneEntity) => {
    const g = e.geometry as GeometryValue;
    return {
      indexCount: g.indexCount,
      // Mocked GPUBuffer carries .size; this catches the "0-byte buffer"
      // bug where reusableBuffer hands back an invalid handle when the
      // mesh shrinks to zero vertices.
      positionByteLen: (g.positionBuffer as unknown as { size: number }).size,
    };
  });
}

test('Branch Palm: radiusMin 0 → 1 → 0 yields the same scene on round 3 as on round 1', async () => {
  const device = createMockDevice();
  const registry = createCoreNodeRegistry();
  // Palm uses the bark-texture subgraph for its trunk material; register both.
  const bark = buildBarkTextureSubgraph();
  for (const def of defineSubgraph(bark, registry)) registry.register(def);
  const palm = buildBranchPalmSubgraph();
  for (const def of defineSubgraph(palm, registry)) registry.register(def);

  const cache = createEvalCache();

  // The fronds-sample-points node is the one with tipCount=14 (palm
  // fronds fan out around the tip). The other sample-points-shaped
  // configs in this subgraph would be the wrong target.
  const frondPoints = palm.graph.nodes.find(
    (n) => n.kind === 'branch/sample-points' && n.inputValues?.tipCount === 14,
  );
  if (!frondPoints) throw new Error('frond sample-points node not found');
  const frondNode = frondPoints;

  async function evalOnce(radiusMin: number): Promise<{ scene: SceneValue; touched: Set<string> }> {
    frondNode.inputValues = { ...frondNode.inputValues, radiusMin };
    const touched = new Set<string>();
    const result = await evaluateGraph(palm.graph, registry, {
      rootNodeId: palm.outputNodeId,
      context: { device: device as unknown as GPUDevice, evalCache: cache },
      cache,
      touched,
    });
    const scene = result.outputs.scene as SceneValue;
    return { scene, touched };
  }

  // Round 1 — radiusMin = 0: palm fronds visible, trunk visible.
  const r1 = await evalOnce(0);
  // Mimic what the cache-coordinator does after a consumer reports its
  // touched set: sweep with the live=touched union. Single consumer,
  // so live is just r1.touched.
  sweepCache(cache, r1.touched);
  const snap1 = structuralSnapshot(r1.scene);
  assert.ok(snap1.length >= 1, 'round 1 produces at least one entity');
  assert.ok(
    snap1.some((e) => e.indexCount > 0 && e.positionByteLen > 0),
    `round 1 produces non-empty geometry, got ${JSON.stringify(snap1)}`,
  );

  // Round 2 — radiusMin = 1: filters out every tip (palm tips have
  // radius ~0.1). Fronds chain produces zero points → zero-vertex
  // mesh → reusableBuffer is asked to materialise a 0-byte buffer.
  // This is the round that triggers the bug.
  const r2 = await evalOnce(1);
  sweepCache(cache, r2.touched);

  // Round 3 — radiusMin = 0 again. Expected to produce a scene
  // structurally identical to round 1.
  const r3 = await evalOnce(0);
  sweepCache(cache, r3.touched);
  const snap3 = structuralSnapshot(r3.scene);

  assert.deepEqual(
    snap3,
    snap1,
    'going radiusMin 0 → 1 → 0 must come back to the original scene; ' +
      'a mismatch indicates the eval cache + reusableBuffer chain corrupted ' +
      'state during the empty-mesh round',
  );
});
