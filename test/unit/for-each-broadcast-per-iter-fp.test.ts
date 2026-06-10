// Regression: wiring a Vec3Cloud (or FloatCloud) into a for-each-point's
// broadcast extra input must vary the per-iteration value seen by the
// bridge's INNER GRAPH, not just the value passed to bridgeEval.
//
// Bug: the bridge's `subgraph-input/<bridgeId>` boundary node mixes
// `ctx.subgraphInputFingerprints` (which the bridgeEval forwards from
// `ctx.inputFingerprints`) into its own fingerprint. For-each-point
// used to forward its OUTER `inputFingerprints` — the fingerprint of
// the WHOLE Vec3Cloud — unchanged across every iteration. The boundary
// then had the same fp every iteration, so the eval-cache returned
// iteration 0's `size` output forever. Visible symptom: a 4×4 grid of
// spheres scaled by a random-vec3-cloud all came out the same size.
//
// Fix: for-each-point overrides `iterCtx.inputFingerprints` with a
// per-iteration map keyed by picked-value fingerprints, so the
// boundary's fp moves per iteration and the cache returns distinct
// outputs.
//
// This test goes through a real bridge (defineBridgeSubgraph) instead
// of the synthetic `bridge-eval/<id>` NodeDef the rest of the
// for-each-point tests use — the bug is INSIDE the bridge's inner
// eval (cache-hit on the subgraph-input boundary), so a synthetic
// bridge that bypasses inner eval can't catch it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import { evaluateGraph } from '../../src/core/evaluate.js';
import { createNodeRegistry } from '../../src/core/node-def.js';
import { defineSubgraph, type SubgraphDef } from '../../src/core/subgraph.js';
import { forEachPointNode } from '../../src/nodes/for-each-point.js';
import type {
  PointCloudValue,
  Vec3CloudValue,
} from '../../src/core/resources.js';

// Bridge with one broadcast Vec3 input `size`. Inside the bridge, the
// subgraph-input.size wire goes straight to the iteration-output.scaleVec3
// socket — so the bridge's per-iteration `scaleVec3` output IS the
// picked-for-iteration value.
function buildEchoBridge(bridgeId: string): SubgraphDef {
  const g = createGraph();
  const inputBoundary = addNode(g, `subgraph-input/${bridgeId}`);
  addNode(g, `iteration-input/${bridgeId}`);
  const iterOutputBoundary = addNode(g, `iteration-output/${bridgeId}`);
  addEdge(g,
    { node: inputBoundary.id, socket: 'size' },
    { node: iterOutputBoundary.id, socket: 'scaleVec3' });
  return {
    id: bridgeId,
    label: 'echo bridge',
    category: 'Subgraphs',
    inputs: [{ name: 'size', type: 'Vec3', optional: true }],
    // Vec3 output lifts to Vec3Cloud on the for-each-point's outer
    // surface — exactly one cloud entry per iteration.
    outputs: [{ name: 'scaleVec3', type: 'Vec3' }],
    graph: g,
    inputNodeId: inputBoundary.id,
    outputNodeId: iterOutputBoundary.id,
    owner: { kind: 'iteration-bridge', nodeId: 'fep' },
    iterationKind: 'iter/for-each-point',
  };
}

function makePointCloud(points: [number, number, number][]): PointCloudValue {
  const positions = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    positions[i * 3] = points[i]![0];
    positions[i * 3 + 1] = points[i]![1];
    positions[i * 3 + 2] = points[i]![2];
  }
  return { positions, count: points.length };
}

test('Vec3Cloud broadcast varies inside the bridge per iteration (real bridge, no synthetic shortcut)', async () => {
  const bridgeId = 'b-echo';
  const bridge = buildEchoBridge(bridgeId);

  const registry = createNodeRegistry();
  registry.register(forEachPointNode);
  for (const def of defineSubgraph(bridge, registry)) registry.register(def);

  // 3 points; one Vec3 per cell — each distinct enough that any
  // cache collision would surface as repeated values.
  const sizes: Vec3CloudValue = {
    count: 3,
    values: new Float32Array([
      0.1, 0.2, 0.3,
      0.4, 0.5, 0.6,
      0.7, 0.8, 0.9,
    ]),
  };

  const g = createGraph();
  const pts = addNode(g, 'iter/for-each-point', {
    id: 'fep',
    extraInputs: [{ name: 'size', type: 'Vec3Cloud', optional: true }],
    extraOutputs: [{ name: 'scaleVec3', type: 'Vec3Cloud' }],
    inputValues: {
      points: makePointCloud([[0, 0, 0], [1, 0, 0], [2, 0, 0]]),
      __bridgeId: bridgeId,
      size: sizes,
    },
  });

  const result = await evaluateGraph(g, registry, { rootNodeId: pts.id });
  const cloud = result.outputs.scaleVec3 as Vec3CloudValue;

  assert.equal(cloud.count, 3, 'one Vec3 per iteration');
  // Each iteration's scaleVec3 == that iteration's picked-from-cloud
  // size. Pre-fix: every entry == iteration 0's [0.1, 0.2, 0.3].
  // f32 round-trip means we compare with a tolerance.
  const expected = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  for (let i = 0; i < expected.length; i++) {
    assert.ok(
      Math.abs(cloud.values[i]! - expected[i]!) < 1e-5,
      `index ${i}: got ${cloud.values[i]}, expected ~${expected[i]}`,
    );
  }
  // Sanity: iteration 0 and iteration 1 must NOT be the same triple
  // (the exact-equality form of the regression assertion).
  assert.notEqual(cloud.values[0], cloud.values[3], 'iter 0 vs iter 1 differ');
  assert.notEqual(cloud.values[3], cloud.values[6], 'iter 1 vs iter 2 differ');
});
