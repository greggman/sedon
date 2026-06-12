import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { FloatCloudValue, PointCloudValue } from '../core/resources.js';

function hash1(i: number, seed: number): number {
  const a = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453123;
  return a - Math.floor(a);
}

export const randomFloatCloudNode: NodeDef = {
  id: 'cloud/random-float',
  category: 'Distribution/Attributes',
  inputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: 'source point cloud — only its `count` is used',
    },
    {
      name: 'min',
      type: 'Float',
      default: 0,
      description: 'lower bound for the random value (inclusive)',
    },
    {
      name: 'max',
      type: 'Float',
      default: 1,
      description: 'upper bound for the random value (exclusive)',
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0,
      description: 'PRNG seed; same seed reproduces the same values',
    },
  ],
  outputs: [
    {
      name: 'values',
      type: 'FloatCloud',
      description: 'one random Float per source point. Feed into `per_point_yaw` (radians) or `per_point_active` (mask, ≥0.5 active) on an instancer, or through [cloud/step](../../cloud/step) to threshold first',
    },
  ],
  doc: {
    summary: 'One random Float per source point — drives per-instance yaw or activation mask.',
    description: `
The scalar attribute generator. Reads the source PointCloud only for
its \`count\`, then emits one uniformly-random Float per point inside
[min, max], seeded reproducibly.

Common uses:
- \`per_point_yaw\` (radians) on an instancer — set range [0, 2π] for
  fully randomised rotations around each point's normal. Breaks the
  uniform-grid look on scattered forests / debris fields.
- \`per_point_active\` (mask, ≥ 0.5 = realised) — set range [0, 1]
  and ~half the points show. Combine with
  [cloud/step](../../cloud/step) for an explicit threshold,
  or [cloud/multiply](../../cloud/multiply) to AND with
  another mask.
- A bias seed for a downstream consumer that wants per-point
  randomness derived elsewhere.

For per-axis variation (xy scale, RGB tint) use
[cloud/random-vec3](../../cloud/random-vec3) instead.
`,
    sampleGraph: () => {
      const g = createGraph();
      // 6×6 grid → ~half show via per_point_active mask (random ≥ 0.5).
      const points = addNode(g, 'points/grid', {
        id: 'points',
        position: { x: 0, y: 0 },
        inputValues: { cols: 6, rows: 6, spacing: 0.8, jitter: 0, seed: 0 },
      });
      const mask = addNode(g, 'cloud/random-float', {
        id: 'mask',
        position: { x: 280, y: 0 },
        inputValues: { min: 0, max: 1, seed: 0.31 },
      });
      const cube = addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 0, y: 200 },
        inputValues: { size: 1 },
      });
      const inst = addNode(g, 'geom/instance-on-points', {
        id: 'inst',
        position: { x: 840, y: 100 },
        inputValues: { scale: 0.2, align: true, seed: 0 },
      });
      addEdge(g, { node: points.id, socket: 'points' }, { node: mask.id, socket: 'points' });
      addEdge(g, { node: points.id, socket: 'points' }, { node: inst.id, socket: 'points' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: inst.id, socket: 'instance' });
      addEdge(g, { node: mask.id, socket: 'values' }, { node: inst.id, socket: 'per_point_active' });
      return { graph: g, rootNodeId: 'inst' };
    },
  },
  evaluate(_ctx, inputs): { values: FloatCloudValue } {
    const points = inputs.points as PointCloudValue;
    const min = inputs.min as number;
    const max = inputs.max as number;
    const seed = inputs.seed as number;

    const count = points.count;
    const values = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      values[i] = min + hash1(i, seed) * (max - min);
    }

    return { values: { count, values } };
  },
};
