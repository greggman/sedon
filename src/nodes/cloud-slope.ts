import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { FloatCloudValue, PointCloudValue } from '../core/resources.js';

// Slope angle (radians) at each point: angle between the point normal and
// world up. 0 = flat, π/2 ≈ vertical wall.
export const cloudSlopeNode: NodeDef = {
  id: 'cloud/slope',
  category: 'Distribution/Attributes',
  inputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: 'source point cloud — must have normals (the slope angle is acos(normal · world_up))',
    },
  ],
  outputs: [
    {
      name: 'values',
      type: 'FloatCloud',
      description: 'one Float per point: angle in RADIANS between the point\'s normal and world up. 0 = flat, π/2 ≈ 1.57 = vertical (cliff face), π ≈ 3.14 = upside-down (cave roof)',
    },
  ],
  doc: {
    summary: 'Per-point slope angle (radians) — drives grass-on-flats / rock-on-steeps masks.',
    description: `
For each point, computes the angle between the point's normal and
world up: \`acos(normal.y)\`. Output values:
- 0 — flat (normal points straight up)
- ~0.5 rad ≈ 28° — gentle slope
- π/2 ≈ 1.57 rad — vertical (cliff face)
- π ≈ 3.14 rad — completely upside-down (overhanging cave roof)

Pair with [cloud/step](../../cloud/step) (typically with
\`invert: true\` since you usually want LOW slope, i.e. flat ground)
to produce a flat-area mask, then feed into the \`per_point_active\`
input of an instancer. Compose with
[cloud/altitude](../../cloud/altitude) via
[cloud/multiply](../../cloud/multiply) for the
"grass on flats above sea level" pattern.

Throws if the source point cloud lacks normals. Distributors like
[points/on-faces](../../points/on-faces) and
[points/grid](../../points/grid) always emit
normals; some hand-built clouds may not.
`,
    sampleGraph: () => {
      const g = createGraph();
      // Sphere → distribute → slope → cloud-step(0.7, invert=true) →
      // per_point_active. Only the top cap (slope < 0.7 rad ≈ 40°)
      // gets cubes, so the result is a hat of cubes on the sphere top.
      const sphere = addNode(g, 'geom/sphere', {
        id: 'sphere',
        position: { x: 0, y: 0 },
        inputValues: { radius: 1, segments: 32, rings: 16 },
      });
      const points = addNode(g, 'points/on-faces', {
        id: 'points',
        position: { x: 280, y: 0 },
        inputValues: { density: 30, seed: 0 },
      });
      const slope = addNode(g, 'cloud/slope', {
        id: 'slope',
        position: { x: 560, y: 0 },
        inputValues: {},
      });
      const flatMask = addNode(g, 'cloud/step', {
        id: 'flatMask',
        position: { x: 840, y: 0 },
        inputValues: { threshold: 0.7, invert: true },
      });
      const cube = addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 0, y: 200 },
        inputValues: { size: 1 },
      });
      const inst = addNode(g, 'geom/instance-on-points', {
        id: 'inst',
        position: { x: 1120, y: 100 },
        inputValues: { scale: 0.05, align: true, seed: 0 },
      });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: points.id, socket: 'geometry' });
      addEdge(g, { node: points.id, socket: 'points' }, { node: slope.id, socket: 'points' });
      addEdge(g, { node: slope.id, socket: 'values' }, { node: flatMask.id, socket: 'values' });
      addEdge(g, { node: points.id, socket: 'points' }, { node: inst.id, socket: 'points' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: inst.id, socket: 'instance' });
      addEdge(g, { node: flatMask.id, socket: 'mask' }, { node: inst.id, socket: 'per_point_active' });
      return { graph: g, rootNodeId: 'inst' };
    },
  },
  evaluate(_ctx, inputs): { values: FloatCloudValue } {
    const points = inputs.points as PointCloudValue;
    if (!points.normals) {
      throw new Error('cloud/slope requires the input PointCloud to have normals');
    }
    const count = points.count;
    const values = new Float32Array(count);
    const n = points.normals;
    for (let i = 0; i < count; i++) {
      const ny = n[i * 3 + 1]!;
      // Clamp before acos to avoid NaN from float drift on near-up normals.
      values[i] = Math.acos(Math.max(-1, Math.min(1, ny)));
    }
    return { values: { count, values } };
  },
};
