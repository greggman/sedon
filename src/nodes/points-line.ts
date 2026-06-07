import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue } from '../core/resources.js';

// N points evenly spaced from `start` to `end`. The linear-repeat
// distributor — feeds for-each-point / instance-geometry-on-points to
// produce the classic furniture-grade "row of N things" (chair
// spindles along the top rail, drawer pulls across a drawer front,
// picket fence posts, balusters on a stair). Pairs with the existing
// `core/grid-distribute` for 2D repeats.
//
// Spacing rule: with count >= 2, the first point sits at `start` and
// the last at `end` (endpoints inclusive — what you almost always
// want for "place 5 spindles between these two posts"). With count
// == 1 the single point sits at the midpoint, so a slider sweep from
// count=1→2→3 reads as "split the middle, then split each half"
// instead of jumping. count == 0 emits an empty cloud.
//
// Normals are world-up (0,1,0). Downstream `align: true` keeps
// instances upright — the common case for furniture verticals.
// For instances aligned to the LINE direction, transform-on-instance
// is the right tool; we don't bake it in because the line's tangent
// is shared by every point and a single uniform rotation downstream
// is cleaner than per-point tangents here.
export const pointsLineNode: NodeDef = {
  id: 'core/points-line',
  category: 'Geometry/Distribution',
  inputs: [
    {
      name: 'start',
      type: 'Vec3',
      default: [-1, 0, 0],
      description: 'first point when count >= 2; ignored direction when count == 1 (midpoint is used)',
    },
    {
      name: 'end',
      type: 'Vec3',
      default: [1, 0, 0],
      description: 'last point when count >= 2',
    },
    {
      name: 'count',
      type: 'Int',
      default: 5,
      min: 0,
      description: 'how many points to emit. 0 = empty cloud; 1 = midpoint of start-end; >=2 = endpoints inclusive, evenly spaced',
    },
  ],
  outputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: '`count` points lerped from `start` to `end`. Normals are world-up (0,1,0) so downstream align-to-normal keeps instances upright',
    },
  ],
  doc: {
    summary: 'N points evenly spaced from `start` to `end` (chair spindles, drawer pulls, picket posts).',
    description: `
The simplest linear distributor. \`count\` points are placed at
\`lerp(start, end, i / (count - 1))\` for i in 0..count-1, so the
first point lands on \`start\` and the last on \`end\`. \`count == 1\`
collapses to the midpoint so slider sweeps don't jump; \`count == 0\`
emits an empty cloud.

Normals are world-up so a downstream
[core/instance-geometry-on-points](../../core/instance-geometry-on-points)
with \`align: true\` keeps the instances upright — the right default
for chair spindles, drawer pulls, balusters, fence posts, etc. If
you want the instances to lean along the line direction instead,
apply a uniform rotation on the line's tangent downstream (the
tangent is just \`normalize(end - start)\`, shared by every point).

Pair with [core/grid-distribute](../../core/grid-distribute) when
you need a 2D repeat (tiles, drawer grids, button-tufting).
`,
    sampleGraph: () => {
      const g = createGraph();
      const points = addNode(g, 'core/points-line', {
        id: 'points',
        position: { x: 0, y: 0 },
        inputValues: { start: [-1.5, 0, 0], end: [1.5, 0, 0], count: 6 },
      });
      const cube = addNode(g, 'core/cube', {
        id: 'cube',
        position: { x: 0, y: 200 },
        inputValues: { size: 1 },
      });
      const inst = addNode(g, 'core/instance-geometry-on-points', {
        id: 'inst',
        position: { x: 280, y: 100 },
        inputValues: { scale: 0.2, align: true },
      });
      addEdge(g, { node: points.id, socket: 'points' }, { node: inst.id, socket: 'points' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: inst.id, socket: 'instance' });
      return { graph: g, rootNodeId: 'inst' };
    },
  },
  evaluate(_ctx, inputs): { points: PointCloudValue } {
    const start = inputs.start as [number, number, number];
    const end = inputs.end as [number, number, number];
    const count = Math.max(0, Math.floor(inputs.count as number));

    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);

    if (count === 1) {
      // Midpoint — keeps a count slider monotonic as it sweeps
      // through 1.
      positions[0] = (start[0] + end[0]) * 0.5;
      positions[1] = (start[1] + end[1]) * 0.5;
      positions[2] = (start[2] + end[2]) * 0.5;
      normals[1] = 1;
    } else if (count >= 2) {
      const denom = count - 1;
      const dx = (end[0] - start[0]) / denom;
      const dy = (end[1] - start[1]) / denom;
      const dz = (end[2] - start[2]) / denom;
      for (let i = 0; i < count; i++) {
        positions[i * 3]     = start[0] + dx * i;
        positions[i * 3 + 1] = start[1] + dy * i;
        positions[i * 3 + 2] = start[2] + dz * i;
        normals[i * 3 + 1] = 1;
      }
    }

    return { points: { positions, normals, count } };
  },
};
