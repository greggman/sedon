import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PathValue, PointCloudValue } from '../core/resources.js';

// Author a Catmull-Rom spline through world space from a list of
// control points carried by a PointCloud input. The canonical
// authoring path:
//
//   points/list (drawn in the 2D editor)
//     → path/spline (this node, smooth the polyline)
//     → path/carve-heightfield (cut into terrain)
//
// Any other PointCloud source works just as well — phyllotaxis-points
// for spiral garden walls, grid-distribute for a rectilinear maze, a
// procedurally generated cloud for game-of-life-style river systems.
//
// Uniform Catmull-Rom: the curve passes through every control point
// (which is what you usually want for road/river authoring — you can
// SEE where you placed the points) with smooth tangents at each
// one. The two-point degenerate case collapses to a straight line.
//
// Endpoint handling: phantom control points are extrapolated by
// reflecting the second point through the first (and symmetrically
// at the tail), so the first and last segments have well-defined
// tangents without the user having to author dummy points outside
// the desired range.
export const pathSplineNode: NodeDef = {
  id: 'path/spline',
  category: 'Path',
  inputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description:
        'control points for the spline, in the order they should be visited. Typically wired from [points/list](../../points/list) (drawn in its 2D editor) but any PointCloud-producing node works',
    },
    {
      name: 'width',
      type: 'Float',
      default: 4,
      description: 'full width of the path in world units; the carve / extrude consumers use width/2 as the inner half-width',
    },
    {
      name: 'samples_per_segment',
      type: 'Int',
      default: 16,
      min: 1,
      description: 'resample resolution between consecutive control points; higher = smoother distance queries downstream',
    },
  ],
  outputs: [
    {
      name: 'path',
      type: 'Path',
      description: 'resampled polyline (XYZ samples) plus the authored width. Consume with [path/mask](../../path/mask) or [path/carve-heightfield](../../path/carve-heightfield)',
    },
  ],
  doc: {
    summary: 'Smooth a PointCloud of control points into a resampled Catmull-Rom spline.',
    description: `
Takes a PointCloud (typically authored in [points/list](../../points/list)\'s
2D editor) and tessellates a uniform Catmull-Rom curve through every
point, resampled at \`samples_per_segment\` per segment.

The curve passes through every control point (which is what you usually
want for road/river authoring — the points mark the corners of the
route) with smooth tangents at each one. Two control points collapse to
a straight line; three or more start to curve.

The output \`Path\` is the resampled polyline plus a width. Feed it
into [path/mask](../../path/mask) to rasterise a "where the path goes"
mask, or [path/carve-heightfield](../../path/carve-heightfield) to lower
the terrain along its route (roads / riverbeds).

Endpoint behaviour: phantom controls are extrapolated by reflecting the
second point through the first (symmetrically at the tail), so the first
and last segments curve sensibly without the user having to author
sacrificial dummy points outside the desired route.
`,
    sampleGraph: () => {
      const g = createGraph();
      // Sample: a point-list with a small S-curve feeding the spline.
      const pts = addNode(g, 'points/list', {
        id: 'pts',
        position: { x: 0, y: 0 },
        inputValues: {
          points: [[-4, 0, -3], [0, 0, 1], [4, 0, -3]],
        },
      });
      const spline = addNode(g, 'path/spline', {
        id: 'spline',
        position: { x: 240, y: 0 },
        inputValues: { width: 4, samples_per_segment: 16 },
      });
      addEdge(g, { node: pts.id, socket: 'points' }, { node: spline.id, socket: 'points' });
      return { graph: g, rootNodeId: 'spline' };
    },
  },
  evaluate(_ctx, inputs): { path: PathValue } {
    const width = inputs.width as number;
    const samplesPerSegment = inputs.samples_per_segment as number;
    const pc = inputs.points as PointCloudValue | undefined;

    const n = pc?.count ?? 0;
    if (!pc || n < 2) {
      // Nothing to interpolate. Empty polyline is a valid no-op for
      // consumers (carve = identity, extrude = empty geometry).
      return { path: { samples: new Float32Array(0), count: 0, width } };
    }

    // Extract control points by index. Reading from the typed array
    // directly avoids the per-segment four lookups via an `at(i)`
    // function; bounds-check + reflection is folded into `at` below.
    const pos = pc.positions;
    const at = (i: number): [number, number, number] => {
      if (i < 0) {
        return [
          2 * pos[0]! - pos[3]!,
          2 * pos[1]! - pos[4]!,
          2 * pos[2]! - pos[5]!,
        ];
      }
      if (i >= n) {
        const a = (n - 1) * 3;
        const b = (n - 2) * 3;
        return [
          2 * pos[a]! - pos[b]!,
          2 * pos[a + 1]! - pos[b + 1]!,
          2 * pos[a + 2]! - pos[b + 2]!,
        ];
      }
      const o = i * 3;
      return [pos[o]!, pos[o + 1]!, pos[o + 2]!];
    };

    // Uniform Catmull-Rom basis. q(t) = 0.5·((2·p1) + (−p0 + p2)·t +
    // (2·p0 − 5·p1 + 4·p2 − p3)·t² + (−p0 + 3·p1 − 3·p2 + p3)·t³).
    const segments = n - 1;
    const total = segments * samplesPerSegment + 1;
    const samples = new Float32Array(total * 3);
    let out = 0;
    for (let s = 0; s < segments; s++) {
      const p0 = at(s - 1);
      const p1 = at(s);
      const p2 = at(s + 1);
      const p3 = at(s + 2);
      for (let i = 0; i < samplesPerSegment; i++) {
        const t = i / samplesPerSegment;
        const t2 = t * t;
        const t3 = t2 * t;
        samples[out + 0] = 0.5 * (
          (2 * p1[0]) +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3
        );
        samples[out + 1] = 0.5 * (
          (2 * p1[1]) +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3
        );
        samples[out + 2] = 0.5 * (
          (2 * p1[2]) +
          (-p0[2] + p2[2]) * t +
          (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t2 +
          (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t3
        );
        out += 3;
      }
    }
    // Pin the very last sample to the final control point exactly.
    // (At t=1 of the last segment the formula evaluates to p2, which is
    // the last control point — so this is mostly a fp-cleanup.)
    const last = (n - 1) * 3;
    samples[out + 0] = pos[last]!;
    samples[out + 1] = pos[last + 1]!;
    samples[out + 2] = pos[last + 2]!;

    return { path: { samples, count: total, width } };
  },
};
