// Polygon chunk-1 math: winding normalisation, AABB output, fan
// triangulation. These nodes are the foundation of the
// upcoming polygon-difference / polygon-offset / for-each-polygon
// chunks; pinning the invariants now means the rest of the city
// rebuild can rely on them without surprise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoreNodeRegistry } from '../../src/nodes/index.js';
import type { PolygonValue } from '../../src/core/resources.js';

const reg = createCoreNodeRegistry();
const polyFromPoints = reg.get('core/polygon-from-points')!;
const polyAabb = reg.get('core/polygon-aabb')!;

// Shoelace 2×area. Positive ⇔ counter-clockwise winding in our XZ
// frame, exactly what polygon-from-points normalises to and what
// downstream consumers will assume.
function signedAreaXZ(outer: Float32Array): number {
  let sum = 0;
  const n = outer.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += outer[i * 2]! * outer[j * 2 + 1]! - outer[j * 2]! * outer[i * 2 + 1]!;
  }
  return sum;
}

const ctx = { nodeId: 'test', subgraphPath: [] };

test('polygon-aabb emits 4 vertices, counter-clockwise winding', () => {
  const r = polyAabb.evaluate(ctx, { center: [10, 20], size: [40, 60] }) as { polygon: PolygonValue };
  assert.equal(r.polygon.outer.length, 8, '4 vertices × 2 floats');
  assert.ok(signedAreaXZ(r.polygon.outer) > 0, 'output must be CCW');
  // Bbox should bracket the centre by half-extent.
  const xs = [r.polygon.outer[0]!, r.polygon.outer[2]!, r.polygon.outer[4]!, r.polygon.outer[6]!];
  const zs = [r.polygon.outer[1]!, r.polygon.outer[3]!, r.polygon.outer[5]!, r.polygon.outer[7]!];
  assert.equal(Math.min(...xs), -10);
  assert.equal(Math.max(...xs), 30);
  assert.equal(Math.min(...zs), -10);
  assert.equal(Math.max(...zs), 50);
});

test('polygon-from-points: CCW input is preserved', () => {
  // Square authored CCW (matches our +X right, +Z down convention).
  const points = [
    [-1, 0, -1],
    [ 1, 0, -1],
    [ 1, 0,  1],
    [-1, 0,  1],
  ];
  const r = polyFromPoints.evaluate(ctx, { points }) as { polygon: PolygonValue };
  assert.equal(r.polygon.outer.length, 8);
  assert.ok(signedAreaXZ(r.polygon.outer) > 0);
  // First vertex matches the input order.
  assert.equal(r.polygon.outer[0], -1);
  assert.equal(r.polygon.outer[1], -1);
});

test('polygon-from-points: CW input is flipped to CCW', () => {
  // Same square, reverse winding.
  const points = [
    [-1, 0, -1],
    [-1, 0,  1],
    [ 1, 0,  1],
    [ 1, 0, -1],
  ];
  const r = polyFromPoints.evaluate(ctx, { points }) as { polygon: PolygonValue };
  assert.ok(signedAreaXZ(r.polygon.outer) > 0, 'CW input must be flipped to CCW');
  // After the flip the first vertex is the last of the input
  // (we reverse in place; index 0 ↔ n-1, 1 ↔ n-2, …). Vertex set
  // is unchanged though — same 4 corners.
  const corners = new Set<string>();
  for (let i = 0; i < 4; i++) {
    corners.add(`${r.polygon.outer[i * 2]},${r.polygon.outer[i * 2 + 1]}`);
  }
  assert.equal(corners.size, 4);
  assert.ok(corners.has('-1,-1') && corners.has('1,-1') && corners.has('1,1') && corners.has('-1,1'));
});

test('polygon-from-points: <3 points yields an empty polygon (not a crash)', () => {
  const r0 = polyFromPoints.evaluate(ctx, { points: [] }) as { polygon: PolygonValue };
  const r1 = polyFromPoints.evaluate(ctx, { points: [[0, 0, 0]] }) as { polygon: PolygonValue };
  const r2 = polyFromPoints.evaluate(ctx, { points: [[0, 0, 0], [1, 0, 0]] }) as { polygon: PolygonValue };
  assert.equal(r0.polygon.outer.length, 0);
  assert.equal(r1.polygon.outer.length, 0);
  assert.equal(r2.polygon.outer.length, 0);
});

test('polygon-from-points: strips Y, keeps X and Z', () => {
  // Y components vary; output should ignore them.
  const points = [
    [-2, 999, -3],
    [ 4,  -1, -3],
    [ 4, 100,  5],
    [-2, -42,  5],
  ];
  const r = polyFromPoints.evaluate(ctx, { points }) as { polygon: PolygonValue };
  // Pack-pairs are (x, z); no Y values should show up anywhere.
  for (const yLeaked of [999, -1, 100, -42]) {
    for (let i = 0; i < r.polygon.outer.length; i++) {
      assert.notEqual(r.polygon.outer[i], yLeaked);
    }
  }
});
