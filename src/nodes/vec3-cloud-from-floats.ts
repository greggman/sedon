import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { FloatCloudValue, Vec3CloudValue } from '../core/resources.js';

// Combine three FloatClouds (one per axis) into a Vec3Cloud, one
// Vec3 per index. The bridge between scalar random / scan / sample
// pipelines and Vec3Cloud consumers like `instance-scene-on-points`'s
// `per_point_scale` and `per_point_tint`. Without this node those
// consumers can only take Vec3Clouds that already came out of a
// dedicated Vec3 producer (random-vec3-cloud, point-cloud
// transformations); arithmetic results stayed locked in FloatCloud
// space.
//
// All three inputs are required and must agree on `count`. The
// alternative API (optional axes with scalar defaults) would silently
// accept mismatches; making this strict keeps the chain self-
// validating.
export const vec3CloudFromFloatsNode: NodeDef = {
  id: 'cloud/vec3-from-floats',
  category: 'Distribution/Attributes',
  inputs: [
    {
      name: 'x',
      type: 'FloatCloud',
      description: 'X component of each Vec3',
    },
    {
      name: 'y',
      type: 'FloatCloud',
      description: 'Y component of each Vec3. Must have the same `count` as `x`',
    },
    {
      name: 'z',
      type: 'FloatCloud',
      description: 'Z component of each Vec3. Must have the same `count` as `x` and `y`',
    },
  ],
  outputs: [
    {
      name: 'values',
      type: 'Vec3Cloud',
      description: 'one Vec3 per index, made by zipping (x[i], y[i], z[i]). Ready to drive `per_point_scale`, `per_point_tint`, or any other Vec3Cloud consumer',
    },
  ],
  doc: {
    summary: 'Zip three FloatClouds into a Vec3Cloud (per-axis variable scale / tint / offset).',
    description: `
The standard composition node from scalar-attribute pipelines to
vector-attribute consumers. Each output Vec3 is just
\`(x[i], y[i], z[i])\`. All three inputs must share \`count\`.

Canonical use — per-instance variable size:

\`\`\`
random-float-cloud(N, min=0.025, max=0.05)  → widths
random-float-cloud(N, min=0.18,  max=0.26)  → heights
random-float-cloud(N, min=0.13,  max=0.18)  → depths
vec3-cloud-from-floats(widths, heights, depths) → Vec3Cloud
                                            ↓
                             instance-scene-on-points.per_point_scale
\`\`\`

The same pattern (with hue / saturation / value clouds) is how you
build a per-instance tint that varies along three independent
authored axes instead of an isotropic RGB box.
`,
    sampleGraph: () => {
      const g = createGraph();
      const sizing = addNode(g, 'points/line', {
        id: 'sizing',
        position: { x: 0, y: 0 },
        inputValues: { start: [0, 0, 0], end: [1, 0, 0], count: 8 },
      });
      const x = addNode(g, 'cloud/random-float', {
        id: 'x',
        position: { x: 280, y: 0 },
        inputValues: { min: 0.5, max: 1.5, seed: 0.1 },
      });
      const y = addNode(g, 'cloud/random-float', {
        id: 'y',
        position: { x: 280, y: 180 },
        inputValues: { min: 0.5, max: 1.5, seed: 0.2 },
      });
      const z = addNode(g, 'cloud/random-float', {
        id: 'z',
        position: { x: 280, y: 360 },
        inputValues: { min: 0.5, max: 1.5, seed: 0.3 },
      });
      const zip = addNode(g, 'cloud/vec3-from-floats', {
        id: 'zip',
        position: { x: 560, y: 180 },
      });
      addEdge(g, { node: sizing.id, socket: 'points' }, { node: x.id, socket: 'points' });
      addEdge(g, { node: sizing.id, socket: 'points' }, { node: y.id, socket: 'points' });
      addEdge(g, { node: sizing.id, socket: 'points' }, { node: z.id, socket: 'points' });
      addEdge(g, { node: x.id, socket: 'values' }, { node: zip.id, socket: 'x' });
      addEdge(g, { node: y.id, socket: 'values' }, { node: zip.id, socket: 'y' });
      addEdge(g, { node: z.id, socket: 'values' }, { node: zip.id, socket: 'z' });
      return { graph: g, rootNodeId: 'zip' };
    },
  },
  evaluate(_ctx, inputs): { values: Vec3CloudValue } {
    const x = inputs.x as FloatCloudValue;
    const y = inputs.y as FloatCloudValue;
    const z = inputs.z as FloatCloudValue;
    if (x.count !== y.count || x.count !== z.count) {
      throw new Error(
        `cloud/vec3-from-floats: x (${x.count}), y (${y.count}), z (${z.count}) `
        + 'must share the same count',
      );
    }
    const n = x.count;
    const values = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      values[i * 3]     = x.values[i]!;
      values[i * 3 + 1] = y.values[i]!;
      values[i * 3 + 2] = z.values[i]!;
    }
    return { values: { values, count: n } };
  },
};
