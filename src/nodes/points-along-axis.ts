import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { FloatCloudValue, PointCloudValue } from '../core/resources.js';

// Generate a PointCloud whose Nth point sits at `origin + axis *
// offsets[N]`. The bridge between FloatCloud arithmetic (random
// widths, accumulated sums, sampled values) and the instance-on-
// points pipeline.
//
// Why this exists vs. `points/line`: points-line is N evenly-
// spaced points along start→end. points-along-axis is N points
// spaced by EXPLICIT per-point offsets. The two cover the
// "evenly spaced" and "variably spaced" cases without one of them
// growing optional inputs that confuse what it's for.
//
// Normals are world-up so a downstream `align: false` keeps instances
// in their author orientation. (Pass align: true if you want the
// instance Y-axis pinned to world-up — same convention as points-
// line.)
export const pointsAlongAxisNode: NodeDef = {
  id: 'points/along-axis',
  category: 'Geometry/Distribution',
  inputs: [
    {
      name: 'origin',
      type: 'Vec3',
      default: [0, 0, 0],
      description: 'point 0 lives at `origin + axis * offsets[0]` — i.e. this is the "base position" the offsets stack onto',
    },
    {
      name: 'axis',
      type: 'Vec3',
      default: [1, 0, 0],
      description: 'direction along which offsets accumulate. Non-unit axes scale the offsets too — to walk in metres along world X use [1, 0, 0]. To walk diagonally use a normalised diagonal vector',
    },
    {
      name: 'offsets',
      type: 'FloatCloud',
      description: 'per-point scalar offsets along `axis`. Typically the output of [cloud/accumulate](../../cloud/accumulate)',
    },
  ],
  outputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: 'one point per offset, at `origin + axis * offsets[i]`. Normals are world-up so downstream `align: false` leaves instances in their author orientation',
    },
  ],
  doc: {
    summary: 'PointCloud from explicit per-point offsets along an axis (variable-spacing distributor).',
    description: `
Generate a PointCloud whose Nth point sits at
\`origin + axis * offsets[N]\`. The general "variable-spacing"
distributor — the complement of [points/line](../../points/line)
(which is evenly-spaced).

Most common use: cumulative packing. Pair with
[cloud/accumulate](../../cloud/accumulate) in
\`centres\` mode and a random-width source:

\`\`\`
random-float-cloud(count=N, min=0.025, max=0.05)  → widths
accumulate-float-cloud(widths, mode='centers')    → centres
points-along-axis(origin, axis=[1,0,0], offsets=centres) → points
\`\`\`

Other uses: hand-authored irregular spacing via point-list →
float-cloud, projection of a 1D function (height samples) into 3D
positions, conversion of a sorted scan to per-point world positions.
`,
    sampleGraph: () => {
      // The points themselves aren't directly previewable (PointCloud
      // isn't a render target), so we instance small cubes on them and
      // return the merged geometry — the wireframe preview reads as
      // "irregular row of dots along +X" which is what this node
      // actually produces.
      const g = createGraph();
      const r = addNode(g, 'cloud/random-float', {
        id: 'r',
        position: { x: 0, y: 0 },
        inputValues: { count: 10, min: 0.05, max: 0.15, seed: 0.4 },
      });
      const a = addNode(g, 'cloud/accumulate', {
        id: 'a',
        position: { x: 280, y: 0 },
        inputValues: { mode: 2 },
      });
      const p = addNode(g, 'points/along-axis', {
        id: 'p',
        position: { x: 560, y: 0 },
        inputValues: { origin: [0, 0, 0], axis: [1, 0, 0] },
      });
      const cube = addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 560, y: 220 },
        inputValues: { size: 0.05 },
      });
      const inst = addNode(g, 'geom/instance-on-points', {
        id: 'inst',
        position: { x: 840, y: 0 },
      });
      addEdge(g, { node: r.id, socket: 'values' }, { node: a.id, socket: 'values' });
      addEdge(g, { node: a.id, socket: 'values' }, { node: p.id, socket: 'offsets' });
      addEdge(g, { node: p.id, socket: 'points' }, { node: inst.id, socket: 'points' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: inst.id, socket: 'instance' });
      return { graph: g, rootNodeId: 'inst' };
    },
  },
  evaluate(_ctx, inputs): { points: PointCloudValue } {
    const origin = inputs.origin as [number, number, number];
    const axis = inputs.axis as [number, number, number];
    const offsets = inputs.offsets as FloatCloudValue;
    const n = offsets.count;
    const positions = new Float32Array(n * 3);
    const normals = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const t = offsets.values[i]!;
      positions[i * 3]     = origin[0] + axis[0] * t;
      positions[i * 3 + 1] = origin[1] + axis[1] * t;
      positions[i * 3 + 2] = origin[2] + axis[2] * t;
      normals[i * 3 + 1] = 1;
    }
    return { points: { positions, normals, count: n } };
  },
};
