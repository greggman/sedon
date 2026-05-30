import { addNode, createGraph } from '../core/graph.js';
import type { InputDef, NodeDef } from '../core/node-def.js';
import type { PathValue } from '../core/resources.js';

// Author a Catmull-Rom spline through world space from a list of
// control points.
//
// Variadic inputs follow the `core/scene-merge` pattern: declare
// `point_0`, `point_1`, … extra inputs on the node instance (the
// demo, or the +Add input button in the canvas) and wire each to a
// Vec3 source. The first two are the minimum; one isolated point is
// degenerate, zero points produces an empty path that downstream
// consumers will treat as a no-op.
//
// Uniform Catmull-Rom: the curve passes through every control point
// (which is what you usually want for road/river authoring — you
// can SEE where you placed the points) with smooth tangents at each
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
  // Variadic. Two implicit control-point inputs are declared so a
  // fresh node has the minimum to make a path; more come via
  // extraInputs (demos pre-populate; users add via +).
  inputs: [
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
  extraInputsSpec: {
    type: 'Vec3',
    namePrefix: 'point',
    addLabel: '+ Add point',
  },
  doc: {
    summary: 'Author a Catmull-Rom spline through world space from a list of control points.',
    description: `
Variadic: the node carries \`point_0\`, \`point_1\`, … inputs (add more via
the "+ Add point" button on the node). Each wired control point is a Vec3
in world space; consecutive points get smoothly interpolated by a uniform
Catmull-Rom spline and resampled at \`samples_per_segment\` per segment.

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
      // Variadic node: declare three control-point extraInputs at
      // construction time so the sample graph has a useful S-shape
      // without needing to click "+" three times.
      const extras: InputDef[] = [
        { name: 'point_0', type: 'Vec3' },
        { name: 'point_1', type: 'Vec3' },
        { name: 'point_2', type: 'Vec3' },
      ];
      addNode(g, 'path/spline', {
        id: 'spline',
        position: { x: 0, y: 0 },
        extraInputs: extras,
        inputValues: {
          width: 4,
          samples_per_segment: 16,
          point_0: [-4, 0, -3],
          point_1: [0, 0, 1],
          point_2: [4, 0, -3],
        },
      });
      return { graph: g, rootNodeId: 'spline' };
    },
  },
  evaluate(_ctx, inputs): { path: PathValue } {
    const width = inputs.width as number;
    const samplesPerSegment = Math.max(1, Math.round(inputs.samples_per_segment as number));

    // Collect wired control points in order: point_0, point_1, ...
    // Stops at the first gap so an unwired point_2 between wired
    // point_1 and point_3 produces a 2-point path, not a broken 4.
    const controlPoints: [number, number, number][] = [];
    for (let i = 0; ; i++) {
      const v = inputs[`point_${i}`] as [number, number, number] | undefined;
      if (!v) break;
      controlPoints.push(v);
    }

    if (controlPoints.length < 2) {
      // Nothing to interpolate. Empty polyline is a valid no-op for
      // consumers (carve = identity, extrude = empty geometry).
      return { path: { samples: new Float32Array(0), count: 0, width } };
    }

    // Catmull-Rom resample. Each segment runs between p1 and p2, with
    // p0 and p3 as the outer-neighbour controls feeding the tangent
    // calc. At the endpoints we reflect: phantom_prev = 2·first − second
    // (and symmetrically at the tail), which gives the first/last
    // segment a sensible tangent without the user having to author
    // dummy points outside the route.
    const n = controlPoints.length;
    const at = (i: number): [number, number, number] => {
      if (i < 0) {
        const p0 = controlPoints[0]!;
        const p1 = controlPoints[1]!;
        return [2 * p0[0] - p1[0], 2 * p0[1] - p1[1], 2 * p0[2] - p1[2]];
      }
      if (i >= n) {
        const pn1 = controlPoints[n - 1]!;
        const pn2 = controlPoints[n - 2]!;
        return [2 * pn1[0] - pn2[0], 2 * pn1[1] - pn2[1], 2 * pn1[2] - pn2[2]];
      }
      return controlPoints[i]!;
    };

    // Uniform Catmull-Rom basis. q(t) = 0.5·((2·p1) + (−p0 + p2)·t +
    // (2·p0 − 5·p1 + 4·p2 − p3)·t² + (−p0 + 3·p1 − 3·p2 + p3)·t³).
    // Inlined per-axis below for one allocation-free pass per sample.
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
        // x
        samples[out + 0] = 0.5 * (
          (2 * p1[0]) +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3
        );
        // y
        samples[out + 1] = 0.5 * (
          (2 * p1[1]) +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3
        );
        // z
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
    const last = controlPoints[n - 1]!;
    samples[out + 0] = last[0];
    samples[out + 1] = last[1];
    samples[out + 2] = last[2];

    return { path: { samples, count: total, width } };
  },
};
