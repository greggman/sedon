import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue } from '../core/resources.js';

// Measure the world-space axis-aligned bounding box of a PointCloud.
// Outputs min / max / centre / size — all Vec3s — for downstream
// "fit to" and "centre on" flows.
//
// Cheap: single sweep over the positions Float32Array, no GPU work.
// Returns an empty AABB (all zeros) when the cloud has no points; the
// `centre` then degenerates to the origin and `size` to zero, which
// most consumers handle without a separate guard.

export const pointsAabbNode: NodeDef = {
  id: 'points/aabb',
  category: 'Points',
  inputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: 'cloud to measure',
    },
  ],
  outputs: [
    { name: 'min',    type: 'Vec3', description: 'component-wise minimum across every point' },
    { name: 'max',    type: 'Vec3', description: 'component-wise maximum across every point' },
    { name: 'centre', type: 'Vec3', description: '(min + max) / 2 — the AABB centre' },
    { name: 'size',   type: 'Vec3', description: 'max − min — the AABB extents per axis' },
  ],
  doc: {
    summary: 'Axis-aligned bounding box of a PointCloud.',
    description: `
Sweeps the cloud once to find the component-wise min and max, then
emits both plus their derived \`centre\` and \`size\`. \`centre\` is the
input most parametric "place at the middle of these points" flows
need; \`size\` is what "scale to fit" / "spread across the AABB"
flows need.

Empty cloud → all four outputs are the zero vector. Downstream
consumers should treat that as a no-op.

Pairs with [math/floats-from-vec3](../../math/floats-from-vec3) when
you need a single axis: e.g. \`size\` → split → take \`x\` →
scale relative to the cloud's footprint along world X.
`,
    sampleGraph: () => {
      const g = createGraph();
      const grid = addNode(g, 'points/grid', {
        id: 'grid',
        position: { x: 0, y: 0 },
        inputValues: { cols: 5, rows: 5, spacing: 0.6 },
      });
      const bb = addNode(g, 'points/aabb', {
        id: 'bb',
        position: { x: 280, y: 0 },
      });
      addEdge(g, { node: grid.id, socket: 'points' }, { node: bb.id, socket: 'points' });
      return { graph: g, rootNodeId: 'bb' };
    },
  },
  evaluate(_ctx, inputs): {
    min: [number, number, number];
    max: [number, number, number];
    centre: [number, number, number];
    size: [number, number, number];
  } {
    const cloud = inputs.points as PointCloudValue | undefined;
    return computeAabb(cloud?.positions, cloud?.count ?? 0);
  },
};

// Shared with geom/aabb and scene/aabb so the empty-input contract
// stays identical. Exported so the tests can pin the math directly.
export function computeAabb(positions: Float32Array | undefined, count: number): {
  min: [number, number, number];
  max: [number, number, number];
  centre: [number, number, number];
  size: [number, number, number];
} {
  if (!positions || count <= 0 || positions.length < 3) {
    return { min: [0, 0, 0], max: [0, 0, 0], centre: [0, 0, 0], size: [0, 0, 0] };
  }
  let minX = positions[0]!, minY = positions[1]!, minZ = positions[2]!;
  let maxX = minX, maxY = minY, maxZ = minZ;
  const len = Math.min(positions.length, count * 3);
  for (let i = 3; i < len; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    if (x < minX) minX = x; else if (x > maxX) maxX = x;
    if (y < minY) minY = y; else if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; else if (z > maxZ) maxZ = z;
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    centre: [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
  };
}
