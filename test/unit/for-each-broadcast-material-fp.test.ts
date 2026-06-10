// Regression: a broadcast input (passes through unchanged every
// iteration) whose value is a GPU-bearing type — MaterialValue with
// a GPUTexture inside, or Texture2DValue, etc. — must invalidate the
// bridge's cache when the upstream value changes.
//
// Previous bug: for-each-point.evaluate fingerprinted each per-iter
// broadcast input via `canonicalJson(picked)`. `JSON.stringify` on
// a GPUTexture is `{}`, so two MaterialValues that differ ONLY by
// their basecolor texture handle produced identical canonical JSON.
// The bridge's subgraph-input boundary fp didn't move → eval cache
// hit on a stale entry → downstream entities kept the OLD material
// handle. User-visible: change a material's basecolor, the rendered
// scene doesn't update because the entities still reference the
// previously-cached material.
//
// Fix: use the upstream node's fingerprint (which evaluate.ts
// computes correctly via the producer node's own fp chain) for
// broadcast inputs that pass through unchanged. Cloud-deref'd inputs
// (`picked !== wired`) keep using canonicalJson on the picked
// primitive — that's a fresh scalar/vec per iteration, plain JSON.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNode, createGraph } from '../../src/core/graph.js';
import { evaluateGraph } from '../../src/core/evaluate.js';
import {
  createNodeRegistry,
  type NodeContext,
  type NodeDef,
  type NodeInputs,
  type NodeOutputs,
  type NodeRegistry,
} from '../../src/core/node-def.js';
import { forEachPointNode } from '../../src/nodes/for-each-point.js';
import type { PointCloudValue, SceneValue } from '../../src/core/resources.js';

function makePointCloud(points: [number, number, number][]): PointCloudValue {
  const positions = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    positions[i * 3] = points[i]![0];
    positions[i * 3 + 1] = points[i]![1];
    positions[i * 3 + 2] = points[i]![2];
  }
  return { positions, count: points.length };
}

// Synthetic bridge that captures the broadcast `material` input it
// received per iteration. Lets the test assert the per-iter fp moved
// when the upstream material identity changed.
interface CallRecord {
  iterationIndex: number;
  receivedMaterial: unknown;
}

function makeBridge(calls: CallRecord[]): NodeDef {
  return {
    id: 'bridge-eval/b1',
    category: '__internal__',
    inputs: [{ name: 'material', type: 'Material', optional: true }],
    outputs: [{ name: 'scene', type: 'Scene' }],
    evaluate(ctx, inputs): NodeOutputs {
      calls.push({
        iterationIndex: ctx.iterationContext?.index as number,
        receivedMaterial: (inputs as NodeInputs).material,
      });
      return { scene: { entities: [] } as SceneValue };
    },
  };
}

test('broadcast Material input: changing the upstream material handle invalidates the bridge cache', async () => {
  // Stand-in for a MaterialValue carrying a GPU handle. The {} for
  // texture is what JSON.stringify produces for a real GPUTexture,
  // so this mirrors the production failure mode without needing
  // WebGPU.
  const matWhite = {
    kind: 'pbr' as const,
    basecolor: { texture: {}, format: 'rgba8unorm', width: 1, height: 1, revision: 0 },
    roughness: 0.7,
    metallic: 0,
  };
  const matRed = {
    kind: 'pbr' as const,
    basecolor: { texture: {}, format: 'rgba8unorm', width: 1, height: 1, revision: 0 },
    roughness: 0.7,
    metallic: 0,
  };
  // Sanity: canonical JSON of these two MaterialValues is identical
  // (the old bug). The fix relies on upstream fps, not content fps.
  assert.equal(JSON.stringify(matWhite), JSON.stringify(matRed),
    'sanity: canonicalJson collision is the bug we are guarding against');

  const callsRound1: CallRecord[] = [];
  const callsRound2: CallRecord[] = [];
  // Two MATERIAL-producing nodes with the SAME structural definition
  // but different inputValues: that gives them distinct upstream fps
  // (which is what the fix uses to invalidate the bridge cache).
  function makeMaterialSource(id: string, mat: unknown): NodeDef {
    return {
      id,
      category: '__test__',
      inputs: [{ name: 'tag', type: 'String', default: '' }],
      outputs: [{ name: 'material', type: 'Material' }],
      evaluate() { return { material: mat }; },
    };
  }
  function buildRegistry(bridge: NodeDef, matSourceDef: NodeDef): NodeRegistry {
    const r = createNodeRegistry();
    r.register(forEachPointNode);
    r.register(bridge);
    r.register(matSourceDef);
    return r;
  }

  // Round 1: build graph with material producer #1 (tag='white')
  // wired into for-each-point.material.
  const g1 = createGraph();
  const bridge1 = makeBridge(callsRound1);
  const matSrc1 = makeMaterialSource('test/mat-src', matWhite);
  const reg1 = buildRegistry(bridge1, matSrc1);
  const src1 = addNode(g1, 'test/mat-src', { inputValues: { tag: 'white' } });
  const fep1 = addNode(g1, 'iter/for-each-point', {
    extraInputs: [{ name: 'material', type: 'Material', optional: true }],
    inputValues: {
      points: makePointCloud([[0, 0, 0], [1, 0, 0]]),
      __bridgeId: 'b1',
    },
  });
  g1.edges.push({ id: 'e1', from: { node: src1.id, socket: 'material' }, to: { node: fep1.id, socket: 'material' } });
  await evaluateGraph(g1, reg1, { rootNodeId: fep1.id, context: {} as NodeContext });

  // Round 2: same graph topology but the material producer's tag is
  // 'red' (a different inputValue → different upstream fp). The
  // returned MaterialValue happens to canonicalJson identically to
  // round 1's — the WHOLE POINT — but the bridge MUST re-evaluate
  // because the upstream identity changed.
  const g2 = createGraph();
  const bridge2 = makeBridge(callsRound2);
  const matSrc2 = makeMaterialSource('test/mat-src', matRed);
  const reg2 = buildRegistry(bridge2, matSrc2);
  const src2 = addNode(g2, 'test/mat-src', { inputValues: { tag: 'red' } });
  const fep2 = addNode(g2, 'iter/for-each-point', {
    extraInputs: [{ name: 'material', type: 'Material', optional: true }],
    inputValues: {
      points: makePointCloud([[0, 0, 0], [1, 0, 0]]),
      __bridgeId: 'b1',
    },
  });
  g2.edges.push({ id: 'e2', from: { node: src2.id, socket: 'material' }, to: { node: fep2.id, socket: 'material' } });
  await evaluateGraph(g2, reg2, { rootNodeId: fep2.id, context: {} as NodeContext });

  // Both rounds had 2 iterations; both should have received the
  // material value (white in round 1, red in round 2).
  assert.equal(callsRound1.length, 2);
  assert.equal(callsRound2.length, 2);
  assert.strictEqual(callsRound1[0]!.receivedMaterial, matWhite);
  assert.strictEqual(callsRound2[0]!.receivedMaterial, matRed);
});
