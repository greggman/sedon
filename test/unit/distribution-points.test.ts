// Geometry invariants for the three new "point source" nodes —
// core/radial-points, core/phyllotaxis-points, core/stem-points. All
// three are pure CPU nodes (no device needed) producing PointCloud
// outputs, so we can drive them directly without the eval pipeline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cornerPointsNode } from '../../src/nodes/corner-points.js';
import { pointsLineNode } from '../../src/nodes/points-line.js';
import { radialPointsNode } from '../../src/nodes/radial-points.js';
import { phyllotaxisPointsNode } from '../../src/nodes/phyllotaxis-points.js';
import { stemPointsNode } from '../../src/nodes/stem-points.js';
import type { PointCloudValue } from '../../src/core/resources.js';

function pos(p: PointCloudValue, i: number): [number, number, number] {
  return [p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.positions[i * 3 + 2]!];
}
function nrm(p: PointCloudValue, i: number): [number, number, number] {
  return [p.normals![i * 3]!, p.normals![i * 3 + 1]!, p.normals![i * 3 + 2]!];
}
function near(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) < eps;
}

// ===== core/radial-points ===========================================

test('radial-points: count=5 around +Y axis with radiusOffset=2 places points on a circle of radius 2 in XZ plane', () => {
  const { points } = radialPointsNode.evaluate({}, {
    center: [0, 0, 0],
    axis: [0, 1, 0],
    count: 5,
    radiusOffset: 2,
    tilt: 0,
    tiltJitter: 0,
    baseAngle: 0,
    seed: 0,
  }) as { points: PointCloudValue };
  assert.equal(points.count, 5);
  for (let i = 0; i < 5; i++) {
    const [x, y, z] = pos(points, i);
    assert.ok(near(y, 0), `point ${i} should sit on XZ plane (y=0), got y=${y}`);
    assert.ok(near(Math.hypot(x, z), 2), `point ${i} should be radius 2 from origin, got ${Math.hypot(x, z)}`);
  }
});

test('radial-points: with tilt=0 normals lie in the perpendicular plane (no axis component)', () => {
  const { points } = radialPointsNode.evaluate({}, {
    center: [0, 0, 0],
    axis: [0, 1, 0],
    count: 4,
    radiusOffset: 1,
    tilt: 0,
    tiltJitter: 0,
    baseAngle: 0,
    seed: 0,
  }) as { points: PointCloudValue };
  for (let i = 0; i < 4; i++) {
    const [, ny] = nrm(points, i);
    assert.ok(near(ny, 0), `tilt=0 → normal y should be 0, got ${ny}`);
  }
});

test('radial-points: with tilt=90 normals align fully with the axis', () => {
  const { points } = radialPointsNode.evaluate({}, {
    center: [0, 0, 0],
    axis: [0, 1, 0],
    count: 3,
    radiusOffset: 0,
    tilt: 90,
    tiltJitter: 0,
    baseAngle: 0,
    seed: 0,
  }) as { points: PointCloudValue };
  for (let i = 0; i < 3; i++) {
    const [nx, ny, nz] = nrm(points, i);
    assert.ok(near(ny, 1), `tilt=90 → normal should be axis-aligned (+Y), got [${nx},${ny},${nz}]`);
    assert.ok(near(nx, 0));
    assert.ok(near(nz, 0));
  }
});

test('radial-points: center offset translates every point by the same amount', () => {
  const { points: a } = radialPointsNode.evaluate({}, {
    center: [0, 0, 0], axis: [0, 1, 0], count: 4, radiusOffset: 1,
    tilt: 0, tiltJitter: 0, baseAngle: 0, seed: 0,
  }) as { points: PointCloudValue };
  const { points: b } = radialPointsNode.evaluate({}, {
    center: [10, 20, 30], axis: [0, 1, 0], count: 4, radiusOffset: 1,
    tilt: 0, tiltJitter: 0, baseAngle: 0, seed: 0,
  }) as { points: PointCloudValue };
  for (let i = 0; i < 4; i++) {
    const [ax, ay, az] = pos(a, i);
    const [bx, by, bz] = pos(b, i);
    assert.ok(near(bx - ax, 10));
    assert.ok(near(by - ay, 20));
    assert.ok(near(bz - az, 30));
  }
});

// ===== core/phyllotaxis-points ======================================

test('phyllotaxis-points: count=N along axis with length=L places i along axis at i/(N-1) * L', () => {
  const { points } = phyllotaxisPointsNode.evaluate({}, {
    center: [0, 0, 0],
    axis: [0, 1, 0],
    length: 4,
    count: 5,
    angle: 137.508,
    radius: 0.5,
    radiusGrowth: 1,
    seed: 0,
  }) as { points: PointCloudValue };
  assert.equal(points.count, 5);
  for (let i = 0; i < 5; i++) {
    const [, y] = pos(points, i);
    assert.ok(near(y, (i / 4) * 4), `point ${i} y should be ${i / 4 * 4}, got ${y}`);
  }
});

test('phyllotaxis-points: golden angle never repeats angular positions across reasonable counts', () => {
  const { points } = phyllotaxisPointsNode.evaluate({}, {
    center: [0, 0, 0], axis: [0, 1, 0], length: 0,
    count: 30, angle: 137.508, radius: 1, radiusGrowth: 1, seed: 0,
  }) as { points: PointCloudValue };
  // No two points should land at the same (x,z) — the golden angle's
  // irrationality guarantees this. With 30 points and 137.508° we
  // expect a packed spiral, not stripes.
  const seen: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < 30; i++) {
    const [x, , z] = pos(points, i);
    for (const s of seen) {
      assert.ok(Math.hypot(s.x - x, s.z - z) > 0.05, `points ${i} and earlier collided at (${x}, ${z})`);
    }
    seen.push({ x, z });
  }
});

test('phyllotaxis-points: radiusGrowth=0 collapses last point to the axis', () => {
  const { points } = phyllotaxisPointsNode.evaluate({}, {
    center: [0, 0, 0], axis: [0, 1, 0], length: 1,
    count: 10, angle: 137.508, radius: 0.5, radiusGrowth: 0, seed: 0,
  }) as { points: PointCloudValue };
  const last = pos(points, 9);
  assert.ok(near(last[0], 0, 1e-6), `last point x=${last[0]} should collapse to axis`);
  assert.ok(near(last[2], 0, 1e-6), `last point z=${last[2]} should collapse to axis`);
});

// ===== core/stem-points =============================================

test('stem-points: mode=alternate emits 1 point per node', () => {
  const { points } = stemPointsNode.evaluate({}, {
    start: [0, 0, 0], axis: [0, 1, 0], length: 1, nodes: 6,
    mode: 0, whorlCount: 99, nodeRotation: 137.508, startAngle: 0, tilt: 0, startOffset: 0, seed: 0,
  }) as { points: PointCloudValue };
  assert.equal(points.count, 6, 'alternate ⇒ 1 leaf per node');
});

test('stem-points: mode=opposite emits 2 points per node, 180° apart', () => {
  const { points } = stemPointsNode.evaluate({}, {
    start: [0, 0, 0], axis: [0, 1, 0], length: 0, nodes: 1,
    mode: 1, whorlCount: 99, nodeRotation: 0, startAngle: 0, tilt: 0, startOffset: 0, seed: 0,
  }) as { points: PointCloudValue };
  assert.equal(points.count, 2);
  const a = nrm(points, 0);
  const b = nrm(points, 1);
  // Opposite leaves: their outward normals should sum to (≈0, ≈0, ≈0).
  assert.ok(near(a[0] + b[0], 0, 1e-5));
  assert.ok(near(a[2] + b[2], 0, 1e-5));
});

test('stem-points: mode=whorled with whorlCount=3 emits 3 points per node evenly spaced', () => {
  const { points } = stemPointsNode.evaluate({}, {
    start: [0, 0, 0], axis: [0, 1, 0], length: 0, nodes: 1,
    mode: 2, whorlCount: 3, nodeRotation: 0, startAngle: 0, tilt: 0, startOffset: 0, seed: 0,
  }) as { points: PointCloudValue };
  assert.equal(points.count, 3);
  // Three whorl leaves: outward normals should sum to ≈0 (perfectly
  // balanced around the axis).
  let sx = 0, sz = 0;
  for (let i = 0; i < 3; i++) {
    const [nx, , nz] = nrm(points, i);
    sx += nx; sz += nz;
  }
  assert.ok(near(sx, 0, 1e-5));
  assert.ok(near(sz, 0, 1e-5));
});

test('stem-points: positions advance monotonically along the axis with each node', () => {
  const { points } = stemPointsNode.evaluate({}, {
    start: [0, 0, 0], axis: [0, 1, 0], length: 5, nodes: 4,
    mode: 0, whorlCount: 1, nodeRotation: 137.508, startAngle: 0, tilt: 0, startOffset: 0, seed: 0,
  }) as { points: PointCloudValue };
  let prevY = -Infinity;
  for (let i = 0; i < points.count; i++) {
    const [, y] = pos(points, i);
    assert.ok(y > prevY, `node ${i} y=${y} should advance past previous ${prevY}`);
    prevY = y;
  }
});

test('stem-points: tilt=90 with axis +Y produces +Y-aligned normals', () => {
  const { points } = stemPointsNode.evaluate({}, {
    start: [0, 0, 0], axis: [0, 1, 0], length: 1, nodes: 3,
    mode: 0, whorlCount: 1, nodeRotation: 137.508, startAngle: 0, tilt: 90, startOffset: 0, seed: 0,
  }) as { points: PointCloudValue };
  for (let i = 0; i < points.count; i++) {
    const [nx, ny, nz] = nrm(points, i);
    assert.ok(near(ny, 1, 1e-5), `tilt=90 → normal Y should be 1, got [${nx},${ny},${nz}]`);
  }
});

// ===== core/points-line =============================================

test('points-line: count=5 from start to end places first at start, last at end, evenly spaced', () => {
  const { points } = pointsLineNode.evaluate({}, {
    start: [0, 0, 0],
    end: [4, 0, 0],
    count: 5,
  }) as { points: PointCloudValue };
  assert.equal(points.count, 5);
  for (let i = 0; i < 5; i++) {
    const [x, y, z] = pos(points, i);
    assert.ok(near(x, i), `point ${i}.x expected ${i}, got ${x}`);
    assert.ok(near(y, 0));
    assert.ok(near(z, 0));
  }
});

test('points-line: count=1 sits at the midpoint of start and end', () => {
  const { points } = pointsLineNode.evaluate({}, {
    start: [-2, 0, 0],
    end: [4, 6, 2],
    count: 1,
  }) as { points: PointCloudValue };
  assert.equal(points.count, 1);
  const [x, y, z] = pos(points, 0);
  assert.ok(near(x, 1));
  assert.ok(near(y, 3));
  assert.ok(near(z, 1));
});

test('points-line: count=0 emits an empty cloud', () => {
  const { points } = pointsLineNode.evaluate({}, {
    start: [0, 0, 0],
    end: [1, 0, 0],
    count: 0,
  }) as { points: PointCloudValue };
  assert.equal(points.count, 0);
  assert.equal(points.positions.length, 0);
});

test('points-line: normals are world-up so align-on-points keeps instances upright', () => {
  const { points } = pointsLineNode.evaluate({}, {
    start: [0, 0, 0],
    // Slanted line (rises 1 in Y over X span of 3) — normals should
    // still be (0,1,0), NOT perpendicular to the line.
    end: [3, 1, 0],
    count: 4,
  }) as { points: PointCloudValue };
  for (let i = 0; i < points.count; i++) {
    const [nx, ny, nz] = nrm(points, i);
    assert.ok(near(nx, 0) && near(ny, 1) && near(nz, 0),
      `normal ${i} expected (0,1,0), got (${nx},${ny},${nz})`);
  }
});

test('points-line: count=2 places one point at start and one at end', () => {
  const { points } = pointsLineNode.evaluate({}, {
    start: [1, 2, 3],
    end: [7, 5, -1],
    count: 2,
  }) as { points: PointCloudValue };
  assert.equal(points.count, 2);
  const [x0, y0, z0] = pos(points, 0);
  const [x1, y1, z1] = pos(points, 1);
  assert.ok(near(x0, 1) && near(y0, 2) && near(z0, 3));
  assert.ok(near(x1, 7) && near(y1, 5) && near(z1, -1));
});

// ===== core/corner-points ===========================================

test('corner-points: 4 points at the corners of width×depth rectangle, y=0, CCW from back-left', () => {
  const { points } = cornerPointsNode.evaluate({}, {
    width: 2,
    depth: 4,
    inset: 0,
  }) as { points: PointCloudValue };
  assert.equal(points.count, 4);
  const expected: Array<[number, number]> = [
    [-1, -2],
    [+1, -2],
    [+1, +2],
    [-1, +2],
  ];
  for (let i = 0; i < 4; i++) {
    const [x, y, z] = pos(points, i);
    assert.ok(near(x, expected[i]![0]), `corner ${i}.x expected ${expected[i]![0]}, got ${x}`);
    assert.ok(near(y, 0), `corner ${i}.y expected 0, got ${y}`);
    assert.ok(near(z, expected[i]![1]), `corner ${i}.z expected ${expected[i]![1]}, got ${z}`);
  }
});

test('corner-points: inset shrinks the rectangle inward on all sides', () => {
  const { points } = cornerPointsNode.evaluate({}, {
    width: 2,
    depth: 2,
    inset: 0.25,
  }) as { points: PointCloudValue };
  // With width=depth=2 the no-inset corners would be at ±1; inset=0.25
  // brings them to ±(1 - 0.25) = ±0.75.
  for (let i = 0; i < 4; i++) {
    const [x, , z] = pos(points, i);
    assert.ok(near(Math.abs(x), 0.75), `inset corner ${i}.|x| expected 0.75, got ${Math.abs(x)}`);
    assert.ok(near(Math.abs(z), 0.75), `inset corner ${i}.|z| expected 0.75, got ${Math.abs(z)}`);
  }
});

test('corner-points: inset >= half-extent collapses to the centre rather than going negative', () => {
  const { points } = cornerPointsNode.evaluate({}, {
    width: 1,
    depth: 1,
    inset: 5,
  }) as { points: PointCloudValue };
  for (let i = 0; i < 4; i++) {
    const [x, , z] = pos(points, i);
    assert.ok(near(x, 0), `over-inset corner ${i}.x expected 0, got ${x}`);
    assert.ok(near(z, 0), `over-inset corner ${i}.z expected 0, got ${z}`);
  }
});

test('corner-points: normals are world-up so align-on-points keeps legs vertical', () => {
  const { points } = cornerPointsNode.evaluate({}, {
    width: 1, depth: 1, inset: 0,
  }) as { points: PointCloudValue };
  for (let i = 0; i < 4; i++) {
    const [nx, ny, nz] = nrm(points, i);
    assert.ok(near(nx, 0) && near(ny, 1) && near(nz, 0),
      `normal ${i} expected (0,1,0), got (${nx},${ny},${nz})`);
  }
});
