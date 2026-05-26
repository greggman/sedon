import type { NodeDef } from '../core/node-def.js';
import type { PathValue } from '../core/resources.js';

// Author a polyline through world space from a list of control points.
//
// Variadic inputs follow the `core/scene-merge` pattern: declare
// `point_0`, `point_1`, … extra inputs on the node instance (the
// demo, or the +Add input button in the canvas) and wire each to a
// Vec3 source. The first two are the minimum; one isolated point is
// degenerate, zero points produces an empty path that downstream
// consumers will treat as a no-op.
//
// For v1 the curve is a piecewise-linear interpolation between
// consecutive control points, then resampled at `samples_per_segment`
// per segment so a downstream distance-to-curve query reads as smooth
// (no faceting at original control vertices). Catmull-Rom / B-spline
// can come later by replacing the inner loop here — the PathValue
// shape (an XYZ polyline) stays the same.
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
      description: 'resample resolution between consecutive control points; higher = smoother distance queries downstream',
    },
  ],
  outputs: [{ name: 'path', type: 'Path' }],
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

    // Linear resample. Each segment contributes `samplesPerSegment`
    // samples, plus the very last control point as the polyline's
    // final vertex — so a 2-control-point path with N samples per
    // segment yields N + 1 polyline vertices.
    const segments = controlPoints.length - 1;
    const total = segments * samplesPerSegment + 1;
    const samples = new Float32Array(total * 3);
    let out = 0;
    for (let s = 0; s < segments; s++) {
      const a = controlPoints[s]!;
      const b = controlPoints[s + 1]!;
      for (let i = 0; i < samplesPerSegment; i++) {
        const t = i / samplesPerSegment;
        samples[out + 0] = a[0] + (b[0] - a[0]) * t;
        samples[out + 1] = a[1] + (b[1] - a[1]) * t;
        samples[out + 2] = a[2] + (b[2] - a[2]) * t;
        out += 3;
      }
    }
    const last = controlPoints[controlPoints.length - 1]!;
    samples[out + 0] = last[0];
    samples[out + 1] = last[1];
    samples[out + 2] = last[2];

    return { path: { samples, count: total, width } };
  },
};
