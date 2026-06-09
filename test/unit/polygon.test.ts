// Polygon chunk-1 math: winding normalisation, AABB output, fan
// triangulation. These nodes are the foundation of the
// upcoming polygon-difference / polygon-offset / for-each-polygon
// chunks; pinning the invariants now means the rest of the city
// rebuild can rely on them without surprise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoreNodeRegistry } from '../../src/nodes/index.js';
import type { PointCloudValue, PolygonValue } from '../../src/core/resources.js';

const reg = createCoreNodeRegistry();
const polyFromPoints = reg.get('core/polygon-from-points')!;
const polyAabb = reg.get('core/polygon-aabb')!;
const polyOffset = reg.get('core/polygon-offset')!;
const polyPerim = reg.get('core/polygon-perimeter-points')!;

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

// ── polygon-offset ─────────────────────────────────────────────────

test('polygon-offset: inward inset on a square gives a smaller centred square', () => {
  // 40×40 square centred at origin, inset by 5 → expect a 30×30
  // square (each edge moved 5m inward).
  const aabb = polyAabb.evaluate(ctx, { center: [0, 0], size: [40, 40] }) as { polygon: PolygonValue };
  const r = polyOffset.evaluate(ctx, { polygon: aabb.polygon, offset: -5, miter_limit: 4 }) as { polygon: PolygonValue };
  assert.equal(r.polygon.outer.length, 8, '4 vertices preserved by the offset');
  const xs = [r.polygon.outer[0]!, r.polygon.outer[2]!, r.polygon.outer[4]!, r.polygon.outer[6]!];
  const zs = [r.polygon.outer[1]!, r.polygon.outer[3]!, r.polygon.outer[5]!, r.polygon.outer[7]!];
  const eps = 1e-4;
  assert.ok(Math.abs(Math.min(...xs) - (-15)) < eps, `minX=${Math.min(...xs)}`);
  assert.ok(Math.abs(Math.max(...xs) -  15)  < eps, `maxX=${Math.max(...xs)}`);
  assert.ok(Math.abs(Math.min(...zs) - (-15)) < eps);
  assert.ok(Math.abs(Math.max(...zs) -  15)  < eps);
});

test('polygon-offset: outward dilate on a square gives a larger centred square', () => {
  const aabb = polyAabb.evaluate(ctx, { center: [0, 0], size: [10, 10] }) as { polygon: PolygonValue };
  const r = polyOffset.evaluate(ctx, { polygon: aabb.polygon, offset: 3, miter_limit: 4 }) as { polygon: PolygonValue };
  const xs = [r.polygon.outer[0]!, r.polygon.outer[2]!, r.polygon.outer[4]!, r.polygon.outer[6]!];
  const eps = 1e-4;
  assert.ok(Math.abs(Math.min(...xs) - (-8)) < eps, 'edge moved 3m outward in -X');
  assert.ok(Math.abs(Math.max(...xs) -  8)  < eps);
});

test('polygon-offset: inset past the inscribed radius collapses to empty', () => {
  // 10×10 square: inscribed radius is 5. Inset by 6 should collapse.
  const aabb = polyAabb.evaluate(ctx, { center: [0, 0], size: [10, 10] }) as { polygon: PolygonValue };
  const r = polyOffset.evaluate(ctx, { polygon: aabb.polygon, offset: -6, miter_limit: 4 }) as { polygon: PolygonValue };
  assert.equal(r.polygon.outer.length, 0, 'collapsed polygon emits empty outer');
});

test('polygon-offset: degenerate input (<3 vertices) passes through as empty', () => {
  const r = polyOffset.evaluate(ctx, { polygon: { outer: new Float32Array(0) }, offset: -1, miter_limit: 4 }) as { polygon: PolygonValue };
  assert.equal(r.polygon.outer.length, 0);
});

// ── polygon-perimeter-points ───────────────────────────────────────

test('polygon-perimeter-points: count matches floor(perimeter / spacing)', () => {
  // 40×40 square: perimeter = 160. spacing=20 → 8 points.
  const aabb = polyAabb.evaluate(ctx, { center: [0, 0], size: [40, 40] }) as { polygon: PolygonValue };
  const r = polyPerim.evaluate(ctx, { polygon: aabb.polygon, spacing: 20, y: 0 }) as { points: PointCloudValue };
  assert.equal(r.points.count, 8);
  assert.equal(r.points.positions.length, 8 * 3);
});

test('polygon-perimeter-points: all positions land ON the polygon perimeter', () => {
  // For an axis-aligned rectangle, every point's X or Z should match
  // a side's extremum (within float-tolerance).
  const aabb = polyAabb.evaluate(ctx, { center: [0, 0], size: [40, 40] }) as { polygon: PolygonValue };
  const r = polyPerim.evaluate(ctx, { polygon: aabb.polygon, spacing: 5, y: 0 }) as { points: PointCloudValue };
  const eps = 1e-4;
  for (let i = 0; i < r.points.count; i++) {
    const x = r.points.positions[i * 3]!;
    const z = r.points.positions[i * 3 + 2]!;
    const onAxisX = Math.abs(Math.abs(x) - 20) < eps;
    const onAxisZ = Math.abs(Math.abs(z) - 20) < eps;
    assert.ok(onAxisX || onAxisZ, `point ${i} at (${x}, ${z}) not on a rect edge`);
  }
});

test('polygon-perimeter-points: normals are world up, tangents point inward', () => {
  const aabb = polyAabb.evaluate(ctx, { center: [0, 0], size: [40, 40] }) as { polygon: PolygonValue };
  const r = polyPerim.evaluate(ctx, { polygon: aabb.polygon, spacing: 5, y: 0 }) as { points: PointCloudValue };
  const eps = 1e-4;
  for (let i = 0; i < r.points.count; i++) {
    // Normal = +Y.
    assert.ok(Math.abs(r.points.normals![i * 3]!     - 0) < eps);
    assert.ok(Math.abs(r.points.normals![i * 3 + 1]! - 1) < eps);
    assert.ok(Math.abs(r.points.normals![i * 3 + 2]! - 0) < eps);
    // Tangent is unit, in the XZ plane (no Y component), and points
    // INWARD — for a centred rectangle, "inward from (x,z)" means
    // pointing toward (0, 0), i.e. dot(tangent, (-x, -z)) > 0.
    const tx = r.points.tangents![i * 3]!;
    const ty = r.points.tangents![i * 3 + 1]!;
    const tz = r.points.tangents![i * 3 + 2]!;
    assert.ok(Math.abs(ty) < eps, 'tangent stays in XZ');
    assert.ok(Math.abs(tx * tx + tz * tz - 1) < 1e-3, 'tangent is unit length');
    const x = r.points.positions[i * 3]!;
    const z = r.points.positions[i * 3 + 2]!;
    assert.ok(tx * -x + tz * -z > 0, `tangent at (${x},${z}) does not point inward`);
  }
});

test('polygon-perimeter-points: y input lifts all points to that altitude', () => {
  const aabb = polyAabb.evaluate(ctx, { center: [0, 0], size: [10, 10] }) as { polygon: PolygonValue };
  const r = polyPerim.evaluate(ctx, { polygon: aabb.polygon, spacing: 2, y: 7.5 }) as { points: PointCloudValue };
  for (let i = 0; i < r.points.count; i++) {
    assert.equal(r.points.positions[i * 3 + 1], 7.5);
  }
});

// ── chunk-2 end-to-end ─────────────────────────────────────────────
// The pipeline that chunk 3's for-each-polygon will lean on:
//   polygon-aabb → polygon-offset (sidewalk inset)
//                → polygon-perimeter-points (building slots)
// Each stage's output type must connect to the next, and the
// resulting points must land on the INSET polygon's edge (not the
// original). If we ever break that invariant — e.g. polygon-offset
// stops emitting Polygon, or perimeter-points stops respecting the
// outer ring — chunk 3 falls apart. Pin it.
test('chunk-2 pipeline: aabb → offset → perimeter-points lands on the inset edge', () => {
  const aabb = polyAabb.evaluate(ctx, { center: [0, 0], size: [40, 40] }) as { polygon: PolygonValue };
  const inset = polyOffset.evaluate(ctx, { polygon: aabb.polygon, offset: -3, miter_limit: 4 }) as { polygon: PolygonValue };
  // The inset polygon's edges sit at ±17 (40/2 - 3).
  const r = polyPerim.evaluate(ctx, { polygon: inset.polygon, spacing: 8, y: 0 }) as { points: PointCloudValue };
  assert.ok(r.points.count > 0);
  const eps = 1e-3;
  for (let i = 0; i < r.points.count; i++) {
    const x = r.points.positions[i * 3]!;
    const z = r.points.positions[i * 3 + 2]!;
    const onAxisX = Math.abs(Math.abs(x) - 17) < eps;
    const onAxisZ = Math.abs(Math.abs(z) - 17) < eps;
    assert.ok(onAxisX || onAxisZ, `point ${i} at (${x.toFixed(3)}, ${z.toFixed(3)}) not on the inset edge (expected |x|=17 or |z|=17)`);
  }
});
