import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { FloatCloudValue } from '../core/resources.js';

// Convert per-point analog values to a binary 0/1 mask via a threshold. With
// `invert`, the comparison flips so you can pick either side of the threshold.
export const cloudStepNode: NodeDef = {
  id: 'cloud/step',
  category: 'Distribution/Attributes',
  inputs: [
    {
      name: 'values',
      type: 'FloatCloud',
      description: 'analog per-point values (from [cloud/altitude](../../cloud/altitude), [cloud/slope](../../cloud/slope), [cloud/random-float](../../cloud/random-float), etc.)',
    },
    {
      name: 'threshold',
      type: 'Float',
      default: 0.5,
      description: 'cut-off value. Points with `values[i] >= threshold` become 1 (unless inverted)',
    },
    {
      name: 'invert',
      type: 'Bool',
      default: false,
      description: 'flip the comparison — when true, points BELOW the threshold become 1',
    },
  ],
  outputs: [
    {
      name: 'mask',
      type: 'FloatCloud',
      description: 'binary 0/1 mask per point. Feed into the `per_point_active` input of an instancer to keep only the points whose values cleared the threshold',
    },
  ],
  doc: {
    summary: 'Threshold an analog FloatCloud into a binary 0/1 mask.',
    description: `
The bridge between analog cloud values (altitude in metres, slope in
radians, random in [0, 1]) and the binary masks that
[scene/instance-on-points](../../scene/instance-on-points)
and [geom/instance-on-points](../../geom/instance-on-points)
expect on \`per_point_active\`.

With \`invert: false\` (the default), the rule is
\`mask[i] = (values[i] >= threshold) ? 1 : 0\` — pick the high side.
Set \`invert: true\` for the low side, useful when the source value is
"badness" (slope = steepness) and you want "goodness" (flatness)
through the mask.

Compose with [cloud/multiply](../../cloud/multiply) to AND
two masks together for compound conditions ("high altitude AND flat
ground").
`,
    sampleGraph: () => {
      const g = createGraph();
      // Sphere → distribute → random-float-cloud → cloud-step(0.6) →
      // per_point_active. ~40% of the sphere's surface points show
      // (where random > 0.6).
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
      const randomFloat = addNode(g, 'cloud/random-float', {
        id: 'randomFloat',
        position: { x: 560, y: 0 },
        inputValues: { min: 0, max: 1, seed: 0.31 },
      });
      const step = addNode(g, 'cloud/step', {
        id: 'step',
        position: { x: 840, y: 0 },
        inputValues: { threshold: 0.6, invert: false },
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
      addEdge(g, { node: points.id, socket: 'points' }, { node: randomFloat.id, socket: 'points' });
      addEdge(g, { node: randomFloat.id, socket: 'values' }, { node: step.id, socket: 'values' });
      addEdge(g, { node: points.id, socket: 'points' }, { node: inst.id, socket: 'points' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: inst.id, socket: 'instance' });
      addEdge(g, { node: step.id, socket: 'mask' }, { node: inst.id, socket: 'per_point_active' });
      return { graph: g, rootNodeId: 'inst' };
    },
  },
  evaluate(_ctx, inputs): { mask: FloatCloudValue } {
    const cloud = inputs.values as FloatCloudValue;
    const threshold = inputs.threshold as number;
    const invert = inputs.invert as boolean;
    const count = cloud.count;
    const mask = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const above = cloud.values[i]! >= threshold;
      mask[i] = (above !== invert) ? 1 : 0;
    }
    return { mask: { count, values: mask } };
  },
};
