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
const polyGridSubdivide = reg.get('core/polygon-grid-subdivide')!;
const polyListOffset = reg.get('core/polygon-list-offset')!;
const polySplitLines = reg.get('core/polygon-subdivide-by-lines')!;

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

// ── polygon-grid-subdivide ─────────────────────────────────────────

test('polygon-grid-subdivide: 4×3 grid on a 40×30 rect yields 12 cells of 10×10', () => {
  const aabb = polyAabb.evaluate(ctx, { center: [0, 0], size: [40, 30] }) as { polygon: PolygonValue };
  const r = polyGridSubdivide.evaluate(ctx, { polygon: aabb.polygon, cols: 4, rows: 3 }) as { polygons: { polygons: PolygonValue[] } };
  assert.equal(r.polygons.polygons.length, 12);
  // Each cell is 10×10. Spot-check the first (bottom-left, row-major
  // is X-fast so cell 0 is the (-X, -Z) corner) and the last.
  const eps = 1e-4;
  const first = r.polygons.polygons[0]!;
  assert.ok(Math.abs(first.outer[0]! - -20) < eps, `first cell minX ${first.outer[0]}`);
  assert.ok(Math.abs(first.outer[1]! - -15) < eps, `first cell minZ ${first.outer[1]}`);
  const last = r.polygons.polygons[11]!;
  // Last cell is at (+X, +Z); its outer[4] is the (+X,+Z) corner.
  assert.ok(Math.abs(last.outer[4]! - 20) < eps);
  assert.ok(Math.abs(last.outer[5]! - 15) < eps);
});

test('polygon-grid-subdivide: every cell is a CCW rectangle', () => {
  // Reuse the shoelace test from chunk-1 helpers (signed area > 0).
  function signedAreaXZ(outer: Float32Array): number {
    let sum = 0;
    const n = outer.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      sum += outer[i * 2]! * outer[j * 2 + 1]! - outer[j * 2]! * outer[i * 2 + 1]!;
    }
    return sum;
  }
  const aabb = polyAabb.evaluate(ctx, { center: [0, 0], size: [40, 40] }) as { polygon: PolygonValue };
  const r = polyGridSubdivide.evaluate(ctx, { polygon: aabb.polygon, cols: 5, rows: 5 }) as { polygons: { polygons: PolygonValue[] } };
  assert.equal(r.polygons.polygons.length, 25);
  for (const p of r.polygons.polygons) {
    assert.equal(p.outer.length, 8);
    assert.ok(signedAreaXZ(p.outer) > 0);
  }
});

// ── polygon-list-offset ────────────────────────────────────────────

test('polygon-list-offset: applies the same offset to every input polygon', () => {
  const aabb = polyAabb.evaluate(ctx, { center: [0, 0], size: [40, 40] }) as { polygon: PolygonValue };
  const grid = polyGridSubdivide.evaluate(ctx, { polygon: aabb.polygon, cols: 4, rows: 4 }) as { polygons: { polygons: PolygonValue[] } };
  // 10×10 cells, inset by 1 → each cell shrinks to 8×8.
  const r = polyListOffset.evaluate(ctx, { polygons: grid.polygons, offset: -1, miter_limit: 4 }) as { polygons: { polygons: PolygonValue[] } };
  assert.equal(r.polygons.polygons.length, 16);
  const eps = 1e-4;
  for (const p of r.polygons.polygons) {
    // Cell width / height after inset.
    const xs = [p.outer[0]!, p.outer[2]!, p.outer[4]!, p.outer[6]!];
    const zs = [p.outer[1]!, p.outer[3]!, p.outer[5]!, p.outer[7]!];
    assert.ok(Math.abs((Math.max(...xs) - Math.min(...xs)) - 8) < eps);
    assert.ok(Math.abs((Math.max(...zs) - Math.min(...zs)) - 8) < eps);
  }
});

test('polygon-list-offset: collapsed polygons become empty, list length preserved', () => {
  // Six 10×10 cells from a 60×10 strip; inset by 6 → every cell
  // collapses (inscribed radius is 5). The list should still have 6
  // entries, just all empty.
  const aabb = polyAabb.evaluate(ctx, { center: [0, 0], size: [60, 10] }) as { polygon: PolygonValue };
  const grid = polyGridSubdivide.evaluate(ctx, { polygon: aabb.polygon, cols: 6, rows: 1 }) as { polygons: { polygons: PolygonValue[] } };
  const r = polyListOffset.evaluate(ctx, { polygons: grid.polygons, offset: -6, miter_limit: 4 }) as { polygons: { polygons: PolygonValue[] } };
  assert.equal(r.polygons.polygons.length, 6);
  for (const p of r.polygons.polygons) {
    assert.equal(p.outer.length, 0, 'collapsed polygons emit empty outer');
  }
});

// ── polygon-subdivide-by-lines ─────────────────────────────────────

test('polygon-subdivide-by-lines: no lines ⇒ list of [input polygon]', () => {
  const aabb = polyAabb.evaluate(ctx, { center: [0, 0], size: [40, 40] }) as { polygon: PolygonValue };
  const r = polySplitLines.evaluate(ctx, { polygon: aabb.polygon, lines: [] }) as { polygons: { polygons: PolygonValue[] } };
  assert.equal(r.polygons.polygons.length, 1);
  assert.equal(r.polygons.polygons[0]!.outer.length, aabb.polygon.outer.length);
});

test('polygon-subdivide-by-lines: one centred vertical line splits a square into 2 halves', () => {
  const aabb = polyAabb.evaluate(ctx, { center: [0, 0], size: [40, 40] }) as { polygon: PolygonValue };
  const r = polySplitLines.evaluate(ctx, {
    polygon: aabb.polygon,
    // Vertical line x=0 through (0,-100) and (0,100).
    lines: [[0, 0, -100], [0, 0, 100]],
  }) as { polygons: { polygons: PolygonValue[] } };
  assert.equal(r.polygons.polygons.length, 2);
  // Each half spans [-20, 0] x [-20, 20] or [0, 20] x [-20, 20].
  // Total area should equal the input area (40×40 = 1600).
  function signedAreaXZ(outer: Float32Array): number {
    let sum = 0; const n = outer.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      sum += outer[i * 2]! * outer[j * 2 + 1]! - outer[j * 2]! * outer[i * 2 + 1]!;
    }
    return Math.abs(sum) / 2;
  }
  const a0 = signedAreaXZ(r.polygons.polygons[0]!.outer);
  const a1 = signedAreaXZ(r.polygons.polygons[1]!.outer);
  assert.ok(Math.abs(a0 + a1 - 1600) < 1e-3, `areas sum to ${a0 + a1} (expected 1600)`);
  assert.ok(Math.abs(a0 - 800) < 1e-3);
  assert.ok(Math.abs(a1 - 800) < 1e-3);
});

test('polygon-subdivide-by-lines: two crossing centred lines split a square into 4 quadrants', () => {
  const aabb = polyAabb.evaluate(ctx, { center: [0, 0], size: [40, 40] }) as { polygon: PolygonValue };
  const r = polySplitLines.evaluate(ctx, {
    polygon: aabb.polygon,
    lines: [
      [0, 0, -100], [0, 0, 100],  // vertical x=0
      [-100, 0, 0], [100, 0, 0],  // horizontal z=0
    ],
  }) as { polygons: { polygons: PolygonValue[] } };
  assert.equal(r.polygons.polygons.length, 4);
});

test('polygon-subdivide-by-lines: a line entirely outside the polygon leaves it unchanged', () => {
  const aabb = polyAabb.evaluate(ctx, { center: [0, 0], size: [40, 40] }) as { polygon: PolygonValue };
  const r = polySplitLines.evaluate(ctx, {
    polygon: aabb.polygon,
    // Vertical line at x=100, way outside the polygon.
    lines: [[100, 0, -100], [100, 0, 100]],
  }) as { polygons: { polygons: PolygonValue[] } };
  assert.equal(r.polygons.polygons.length, 1);
});

test('polygon-subdivide-by-lines: odd trailing point is ignored, not crash', () => {
  const aabb = polyAabb.evaluate(ctx, { center: [0, 0], size: [40, 40] }) as { polygon: PolygonValue };
  // 3 points = 1.5 lines. Algorithm takes pairs (0+1) as a line, drops the trailing one.
  const r = polySplitLines.evaluate(ctx, {
    polygon: aabb.polygon,
    lines: [[0, 0, -100], [0, 0, 100], [10, 0, 0]],
  }) as { polygons: { polygons: PolygonValue[] } };
  assert.equal(r.polygons.polygons.length, 2);
});

test('polygon-subdivide-by-lines: degenerate line (same point twice) is skipped', () => {
  const aabb = polyAabb.evaluate(ctx, { center: [0, 0], size: [40, 40] }) as { polygon: PolygonValue };
  const r = polySplitLines.evaluate(ctx, {
    polygon: aabb.polygon,
    lines: [[5, 0, 5], [5, 0, 5]],
  }) as { polygons: { polygons: PolygonValue[] } };
  assert.equal(r.polygons.polygons.length, 1);
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
