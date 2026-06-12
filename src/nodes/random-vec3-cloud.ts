import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue, Vec3CloudValue } from '../core/resources.js';

// Sin-based hash. Cheap; deterministic from (i, seed); good enough for
// "per-instance variation" purposes.
function hash3(i: number, seed: number): [number, number, number] {
  const a = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453123;
  const b = Math.sin(i * 39.346 + seed * 11.135) * 24634.6345;
  const c = Math.sin(i * 17.371 + seed * 51.853) * 31987.4321;
  return [a - Math.floor(a), b - Math.floor(b), c - Math.floor(c)];
}

export const randomVec3CloudNode: NodeDef = {
  id: 'cloud/random-vec3',
  category: 'Distribution/Attributes',
  inputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: 'source point cloud — only its `count` is used; the values are generated independently from the seed',
    },
    {
      name: 'min',
      type: 'Vec3',
      default: [0, 0, 0],
      description: 'lower bound for each per-axis random value (inclusive)',
    },
    {
      name: 'max',
      type: 'Vec3',
      default: [1, 1, 1],
      description: 'upper bound for each per-axis random value (exclusive)',
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
      type: 'Vec3Cloud',
      description: 'one random Vec3 per source point. Feed into the `per_point_scale` or `per_point_tint` input of [scene/instance-on-points](../../scene/instance-on-points) / [geom/instance-on-points](../../geom/instance-on-points)',
    },
  ],
  doc: {
    summary: 'One random Vec3 per source point — drives per-instance scale or tint variation.',
    description: `
The attribute generator side of point distribution. Reads the source
PointCloud only for its \`count\`, then emits one uniformly-random
Vec3 per point inside the [min, max] box, seeded by \`seed\` so the
result is reproducible.

The output Vec3Cloud is the right shape for the optional
\`per_point_scale\` and \`per_point_tint\` inputs on
[scene/instance-on-points](../../scene/instance-on-points)
and [geom/instance-on-points](../../geom/instance-on-points).
Wire it in and every scattered copy gets its own per-axis scale
multiplier (or tint), modulating the base value on the instancer.

For scalar variation (per-point yaw, mask threshold, generic 0..1
factor) reach for [cloud/random-float](../../cloud/random-float).
For non-random per-point attributes derived from point position or
normal, see [cloud/altitude](../../cloud/altitude) and
[cloud/slope](../../cloud/slope).
`,
    sampleGraph: () => {
      const g = createGraph();
      // Grid of cubes whose per-axis scale is randomised: each cube
      // becomes a tiny rectangular box with its own height/width
      // proportions. Visible per-instance scale variation = the point.
      const points = addNode(g, 'points/grid', {
        id: 'points',
        position: { x: 0, y: 0 },
        inputValues: { cols: 6, rows: 6, spacing: 0.8, jitter: 0, seed: 0 },
      });
      const scales = addNode(g, 'cloud/random-vec3', {
        id: 'scales',
        position: { x: 280, y: 0 },
        inputValues: { min: [0.4, 0.4, 0.4], max: [1.6, 1.6, 1.6], seed: 0.31 },
      });
      const cube = addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 0, y: 200 },
        inputValues: { size: 1 },
      });
      const inst = addNode(g, 'geom/instance-on-points', {
        id: 'inst',
        position: { x: 840, y: 100 },
        inputValues: { scale: 0.15, align: true, seed: 0 },
      });
      addEdge(g, { node: points.id, socket: 'points' }, { node: scales.id, socket: 'points' });
      addEdge(g, { node: points.id, socket: 'points' }, { node: inst.id, socket: 'points' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: inst.id, socket: 'instance' });
      addEdge(g, { node: scales.id, socket: 'values' }, { node: inst.id, socket: 'per_point_scale' });
      return { graph: g, rootNodeId: 'inst' };
    },
  },
  evaluate(_ctx, inputs): { values: Vec3CloudValue } {
    const points = inputs.points as PointCloudValue;
    const min = inputs.min as [number, number, number];
    const max = inputs.max as [number, number, number];
    const seed = inputs.seed as number;

    const count = points.count;
    const values = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const [rx, ry, rz] = hash3(i, seed);
      values[i * 3]     = min[0] + rx * (max[0] - min[0]);
      values[i * 3 + 1] = min[1] + ry * (max[1] - min[1]);
      values[i * 3 + 2] = min[2] + rz * (max[2] - min[2]);
    }

    return { values: { count, values } };
  },
};
