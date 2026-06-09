// Integration tests for chunk-3 polygon dispatch:
//   • core/polygon-list — variadic combiner that gathers per-input
//     Polygons into a PolygonList in socket-index order.
//   • core/for-each-polygon — iterates a PolygonList, evaluates a
//     bridge subgraph once per polygon, merges Scene outputs.
//
// We register a synthetic `bridge-eval/b1` NodeDef that captures what
// the iteration handed it (matches the for-each-point test pattern).
// That keeps the test focused on the for-each-polygon logic without
// having to stand up a real SubgraphDef + boundary nodes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import { evaluateGraph } from '../../src/core/evaluate.js';
import {
  createNodeRegistry,
  type NodeDef,
  type NodeInputs,
  type NodeOutputs,
  type NodeRegistry,
} from '../../src/core/node-def.js';
import { forEachPolygonNode } from '../../src/nodes/for-each-polygon.js';
import { polygonAabbNode } from '../../src/nodes/polygon-aabb.js';
import { polygonListNode } from '../../src/nodes/polygon-list.js';
import type { PolygonValue, SceneValue } from '../../src/core/resources.js';

interface CallRecord {
  iterationIndex: number;
  receivedPolygon: PolygonValue;
}

function makeBridgeWithCapture(calls: CallRecord[], bridgeId = 'b1'): NodeDef {
  return {
    id: `bridge-eval/${bridgeId}`,
    category: '__internal__',
    inputs: [], // no broadcast inputs for this test
    outputs: [{ name: 'scene', type: 'Scene' }],
    evaluate(ctx, _inputs): NodeOutputs {
      const idx = ctx.iterationContext?.index as number;
      const poly = ctx.iterationContext?.polygon as PolygonValue;
      calls.push({ iterationIndex: idx, receivedPolygon: poly });
      // Each iteration contributes one synthetic entity tagged with
      // the iteration index — lets us verify the merger preserves
      // per-iteration output order.
      return {
        scene: { entities: [{ tag: idx } as unknown as never] } as SceneValue,
      };
    },
  };
}

function registry(): NodeRegistry {
  const r = createNodeRegistry();
  r.register(polygonAabbNode);
  r.register(polygonListNode);
  r.register(forEachPolygonNode);
  return r;
}

const ctx = { nodeId: 'test', subgraphPath: [] };

test('polygon-list: gathers connected polygons in socket-index order', () => {
  const polyA: PolygonValue = { outer: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]) };
  const polyB: PolygonValue = { outer: new Float32Array([10, 10, 11, 10, 11, 11, 10, 11]) };
  const r = polygonListNode.evaluate(ctx, {
    polygon_0: polyA,
    polygon_1: polyB,
  }) as { polygons: { polygons: PolygonValue[] } };
  assert.equal(r.polygons.polygons.length, 2);
  // First entry has A's coords; second has B's coords.
  assert.equal(r.polygons.polygons[0]!.outer[0], 0);
  assert.equal(r.polygons.polygons[1]!.outer[0], 10);
});

test('polygon-list: skips unwired (undefined) inputs silently', () => {
  const polyA: PolygonValue = { outer: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]) };
  const r = polygonListNode.evaluate(ctx, {
    polygon_0: polyA,
    polygon_1: undefined,
    polygon_2: polyA,
  }) as { polygons: { polygons: PolygonValue[] } };
  assert.equal(r.polygons.polygons.length, 2, 'undefined slot is skipped');
});

test('for-each-polygon: runs the bridge once per polygon, merges scenes in order', async () => {
  const calls: CallRecord[] = [];
  const reg = registry();
  reg.register(makeBridgeWithCapture(calls, 'b1'));

  const g = createGraph();
  // Two distinguishable aabb polygons.
  const a = addNode(g, 'core/polygon-aabb', {
    inputValues: { center: [-5, 0], size: [2, 2] },
  });
  const b = addNode(g, 'core/polygon-aabb', {
    inputValues: { center: [5, 0], size: [2, 2] },
  });
  const list = addNode(g, 'core/polygon-list', {
    extraInputs: [
      { name: 'polygon_0', type: 'Polygon', optional: true },
      { name: 'polygon_1', type: 'Polygon', optional: true },
    ],
  });
  addEdge(g, { node: a.id, socket: 'polygon' }, { node: list.id, socket: 'polygon_0' });
  addEdge(g, { node: b.id, socket: 'polygon' }, { node: list.id, socket: 'polygon_1' });
  const fep = addNode(g, 'core/for-each-polygon', {
    inputValues: { __bridgeId: 'b1' },
    extraOutputs: [{ name: 'scene', type: 'Scene' }],
  });
  addEdge(g, { node: list.id, socket: 'polygons' }, { node: fep.id, socket: 'polygons' });

  const result = await evaluateGraph(g, reg, { rootNodeId: fep.id });

  // Iteration count = number of polygons.
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.iterationIndex, 0);
  assert.equal(calls[1]!.iterationIndex, 1);
  // Each iteration received the corresponding polygon (by AABB centre
  // X — A is at -5, B at +5; outer[0] is the first vertex's X).
  const xA = calls[0]!.receivedPolygon.outer[0];
  const xB = calls[1]!.receivedPolygon.outer[0];
  assert.notEqual(xA, xB, 'two iterations must see distinct polygons');
  // Merged scene contains one entity per iteration, in order.
  const scene = result.outputs.scene as SceneValue;
  assert.equal(scene.entities.length, 2);
  assert.equal((scene.entities[0] as unknown as { tag: number }).tag, 0);
  assert.equal((scene.entities[1] as unknown as { tag: number }).tag, 1);
});

test('for-each-polygon: empty polygon list → empty scene, no bridge calls', async () => {
  const calls: CallRecord[] = [];
  const reg = registry();
  reg.register(makeBridgeWithCapture(calls, 'b1'));

  const g = createGraph();
  const list = addNode(g, 'core/polygon-list', { extraInputs: [] });
  const fep = addNode(g, 'core/for-each-polygon', {
    inputValues: { __bridgeId: 'b1' },
    extraOutputs: [{ name: 'scene', type: 'Scene' }],
  });
  addEdge(g, { node: list.id, socket: 'polygons' }, { node: fep.id, socket: 'polygons' });

  const result = await evaluateGraph(g, reg, { rootNodeId: fep.id });

  assert.equal(calls.length, 0, 'empty list ⇒ no iterations');
  const scene = result.outputs.scene as SceneValue;
  assert.equal(scene.entities.length, 0);
});

test('for-each-polygon: missing bridge id → empty scene fallback', async () => {
  const reg = registry();
  // No bridge registered.
  const g = createGraph();
  const a = addNode(g, 'core/polygon-aabb', {
    inputValues: { center: [0, 0], size: [2, 2] },
  });
  const list = addNode(g, 'core/polygon-list', {
    extraInputs: [{ name: 'polygon_0', type: 'Polygon', optional: true }],
  });
  addEdge(g, { node: a.id, socket: 'polygon' }, { node: list.id, socket: 'polygon_0' });
  const fep = addNode(g, 'core/for-each-polygon', {
    inputValues: { __bridgeId: '' }, // unattached
    extraOutputs: [{ name: 'scene', type: 'Scene' }],
  });
  addEdge(g, { node: list.id, socket: 'polygons' }, { node: fep.id, socket: 'polygons' });

  const result = await evaluateGraph(g, reg, { rootNodeId: fep.id });
  const scene = result.outputs.scene as SceneValue;
  assert.equal(scene.entities.length, 0, 'graceful fallback when no body attached');
});

test('for-each-polygon: PolygonList wired to a Polygon broadcast input pickForIteration-derefs per iteration', async () => {
  // A bridge with a `polygon` BROADCAST input (not iteration-context).
  // PolygonList wired in should deref per iteration so each call sees
  // the i-th polygon. Otherwise the body would see the whole list,
  // which doesn't match the type signature it declared.
  const calls: { received: unknown }[] = [];
  const reg = registry();
  reg.register({
    id: 'bridge-eval/b2',
    category: '__internal__',
    inputs: [{ name: 'polygon', type: 'Polygon', optional: true }],
    outputs: [{ name: 'scene', type: 'Scene' }],
    evaluate(_c, inputs): NodeOutputs {
      calls.push({ received: (inputs as NodeInputs).polygon });
      return { scene: { entities: [] } as SceneValue };
    },
  });
  // Hack: simulate the editor having mirrored the bridge's `polygon`
  // broadcast input onto the for-each-polygon as an extraInput. The
  // mirrored type is PolygonList (from `liftForEachInputType`'s
  // pass-through for non-Float/Vec3 types — Polygon doesn't have a
  // cloud variant, so it stays Polygon, but in PRACTICE the wiring
  // path that's interesting is "wire a PolygonList into the polygon
  // broadcast slot". Override the type so we can wire a list-source.
  const g = createGraph();
  const a = addNode(g, 'core/polygon-aabb', { inputValues: { center: [-5, 0], size: [2, 2] } });
  const b = addNode(g, 'core/polygon-aabb', { inputValues: { center: [5, 0], size: [2, 2] } });
  const list = addNode(g, 'core/polygon-list', {
    extraInputs: [
      { name: 'polygon_0', type: 'Polygon', optional: true },
      { name: 'polygon_1', type: 'Polygon', optional: true },
    ],
  });
  addEdge(g, { node: a.id, socket: 'polygon' }, { node: list.id, socket: 'polygon_0' });
  addEdge(g, { node: b.id, socket: 'polygon' }, { node: list.id, socket: 'polygon_1' });
  const fep = addNode(g, 'core/for-each-polygon', {
    inputValues: { __bridgeId: 'b2' },
    extraInputs: [{ name: 'polygon', type: 'PolygonList', optional: true }],
    extraOutputs: [{ name: 'scene', type: 'Scene' }],
  });
  addEdge(g, { node: list.id, socket: 'polygons' }, { node: fep.id, socket: 'polygons' });
  addEdge(g, { node: list.id, socket: 'polygons' }, { node: fep.id, socket: 'polygon' });

  await evaluateGraph(g, reg, { rootNodeId: fep.id });

  assert.equal(calls.length, 2);
  // Each call's `received` is one of the two polygons, by index.
  const r0 = calls[0]!.received as PolygonValue;
  const r1 = calls[1]!.received as PolygonValue;
  assert.ok(r0.outer instanceof Float32Array);
  assert.ok(r1.outer instanceof Float32Array);
  // distinct polygons by first-vertex X (-5±half vs +5±half)
  assert.notEqual(r0.outer[0], r1.outer[0]);
});
