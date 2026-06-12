import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { FloatCloudValue } from '../core/resources.js';

// Element-wise multiply two FloatClouds. For binary masks (0/1 values) this
// is logical AND. Useful when several filters need to compose: e.g. "trees
// only where slope is gentle AND altitude is below 1.0" stacks two cloud-step
// outputs through a cloud-multiply.
export const cloudMultiplyNode: NodeDef = {
  id: 'cloud/multiply',
  category: 'Distribution/Attributes',
  inputs: [
    {
      name: 'a',
      type: 'FloatCloud',
      description: 'first input. For mask composition this is one filter\'s output',
    },
    {
      name: 'b',
      type: 'FloatCloud',
      description: 'second input. Must have the same `count` as `a`',
    },
  ],
  outputs: [
    {
      name: 'values',
      type: 'FloatCloud',
      description: 'element-wise product `a[i] * b[i]`. For binary masks (0/1 values) this is logical AND',
    },
  ],
  doc: {
    summary: 'Element-wise multiply two FloatClouds — logical AND of binary masks.',
    description: `
The composition node for per-point filters. With analog values this
is plain multiplication; with binary 0/1 masks (from
[cloud/step](../../cloud/step)) it's a logical AND — a
point is active in the output only if it's active in BOTH inputs.

The canonical use is compound terrain conditions:

- **trees** on flat-ish ground above sea level →
  \`step(slope, 0.7, invert=true) × step(altitude, 0.0)\`
- **snow** on flat ground at high altitude →
  \`step(slope, 0.5, invert=true) × step(altitude, 1.5)\`
- **rocks** on steep faces →
  \`step(slope, 0.7) × step(altitude, 0.5, invert=true)\`

The two inputs must share the same \`count\` (both clouds derived from
the same source PointCloud). The node throws on mismatch — useful
guard against accidentally crossing two different point sets.
`,
    sampleGraph: () => {
      const g = createGraph();
      // The compound condition: "flat AND high" on a sphere.
      // Sphere → distribute → (slope→step invert, altitude→step) →
      // multiply → per_point_active. Result: cubes only on the top
      // cap where the surface is ALSO flat enough.
      const sphere = addNode(g, 'geom/sphere', {
        id: 'sphere',
        position: { x: 0, y: 0 },
        inputValues: { radius: 1, segments: 32, rings: 16 },
      });
      const points = addNode(g, 'points/on-faces', {
        id: 'points',
        position: { x: 280, y: 0 },
        inputValues: { density: 40, seed: 0 },
      });
      const slope = addNode(g, 'cloud/slope', {
        id: 'slope',
        position: { x: 560, y: 0 },
        inputValues: {},
      });
      const flatMask = addNode(g, 'cloud/step', {
        id: 'flatMask',
        position: { x: 840, y: 0 },
        inputValues: { threshold: 1.0, invert: true },
      });
      const altitude = addNode(g, 'cloud/altitude', {
        id: 'altitude',
        position: { x: 560, y: 200 },
        inputValues: {},
      });
      const highMask = addNode(g, 'cloud/step', {
        id: 'highMask',
        position: { x: 840, y: 200 },
        inputValues: { threshold: 0.0, invert: false },
      });
      const combined = addNode(g, 'cloud/multiply', {
        id: 'combined',
        position: { x: 1120, y: 100 },
        inputValues: {},
      });
      const cube = addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 0, y: 200 },
        inputValues: { size: 1 },
      });
      const inst = addNode(g, 'geom/instance-on-points', {
        id: 'inst',
        position: { x: 1400, y: 200 },
        inputValues: { scale: 0.05, align: true, seed: 0 },
      });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: points.id, socket: 'geometry' });
      addEdge(g, { node: points.id, socket: 'points' }, { node: slope.id, socket: 'points' });
      addEdge(g, { node: slope.id, socket: 'values' }, { node: flatMask.id, socket: 'values' });
      addEdge(g, { node: points.id, socket: 'points' }, { node: altitude.id, socket: 'points' });
      addEdge(g, { node: altitude.id, socket: 'values' }, { node: highMask.id, socket: 'values' });
      addEdge(g, { node: flatMask.id, socket: 'mask' }, { node: combined.id, socket: 'a' });
      addEdge(g, { node: highMask.id, socket: 'mask' }, { node: combined.id, socket: 'b' });
      addEdge(g, { node: points.id, socket: 'points' }, { node: inst.id, socket: 'points' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: inst.id, socket: 'instance' });
      addEdge(g, { node: combined.id, socket: 'values' }, { node: inst.id, socket: 'per_point_active' });
      return { graph: g, rootNodeId: 'inst' };
    },
  },
  evaluate(_ctx, inputs): { values: FloatCloudValue } {
    const a = inputs.a as FloatCloudValue;
    const b = inputs.b as FloatCloudValue;
    if (a.count !== b.count) {
      throw new Error(
        `cloud/multiply count mismatch: a=${a.count}, b=${b.count}`,
      );
    }
    const count = a.count;
    const values = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      values[i] = a.values[i]! * b.values[i]!;
    }
    return { values: { count, values } };
  },
};
