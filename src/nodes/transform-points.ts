import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue } from '../core/resources.js';
import { multiply, rotationX, rotationY, rotationZ, translation } from '../render/mat4.js';

// PointCloud counterpart of `geom/transform`. Same translate/rotate/
// scale API, same scale → rotate → translate order, same normal
// handling (inverse-transpose of the diagonal scale before rotation,
// then renormalize). Tangents transform exactly like normals — they
// stay perpendicular to the rotated normal because they're a direction
// vector in the same basis.
//
// Why this exists rather than `iter/for-each-point` for translates:
//   - Pure CPU math, no per-point evaluator overhead.
//   - Output is still a PointCloud — downstream consumers (scatter,
//     attribute generators, instance-*-on-points) keep working without
//     a Scene materialisation step.

export const transformPointsNode: NodeDef = {
  id: 'points/transform',
  category: 'Points/Modifiers',
  inputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: 'input cloud whose positions, normals and tangents will be transformed',
    },
    {
      name: 'translate',
      type: 'Vec3',
      default: [0, 0, 0],
      description: 'world-space offset added to every position. Does not affect normals or tangents (direction vectors)',
    },
    {
      name: 'rotate',
      type: 'Vec3',
      default: [0, 0, 0],
      description: 'Euler rotation in radians (X, Y, Z order). Applied around the origin BEFORE the translation. Rotates positions, normals, and tangents alike',
    },
    {
      name: 'scale',
      type: 'Vec3',
      default: [1, 1, 1],
      description: 'per-axis scale factor. Applied first (before rotation). Non-uniform values change normal/tangent direction; the node renormalises afterwards',
    },
  ],
  outputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: 'the input cloud with scale → rotate → translate applied to every position. Normals + tangents (if present) get the matching inverse-transpose rotation and are renormalised',
    },
  ],
  doc: {
    summary: 'Translate / rotate / scale a PointCloud in world space.',
    description: `
PointCloud counterpart to [geom/transform](../../geom/transform). Same
TRS convention (scale, then XYZ-Euler rotate, then translate), same
normal handling. Use to position a generated cloud before scatter, to
rotate a [points/grid](../../points/grid) so it aligns with a wall,
or to mirror/scale a pattern without baking it into Geometry first.

If you need PER-POINT transforms (every point gets a different offset),
use [iter/for-each-point](../../iter/for-each-point) instead — this
node applies ONE matrix to the whole cloud.
`,
    sampleGraph: () => {
      const g = createGraph();
      const grid = addNode(g, 'points/grid', {
        id: 'grid',
        position: { x: 0, y: 0 },
        inputValues: { cols: 6, rows: 6, spacing: 0.5 },
      });
      const tx = addNode(g, 'points/transform', {
        id: 'transform-points',
        position: { x: 280, y: 0 },
        inputValues: { translate: [0, 1, 0], rotate: [0, 0.4, 0], scale: [1, 1, 1] },
      });
      addEdge(g, { node: grid.id, socket: 'points' }, { node: tx.id, socket: 'points' });
      return { graph: g, rootNodeId: 'transform-points' };
    },
  },
  evaluate(_ctx, inputs): { points: PointCloudValue } {
    const input = inputs.points as PointCloudValue;
    const T = translation(
      (inputs.translate as [number, number, number])[0],
      (inputs.translate as [number, number, number])[1],
      (inputs.translate as [number, number, number])[2],
    );
    const r = inputs.rotate as [number, number, number];
    const Rx = rotationX(r[0]);
    const Ry = rotationY(r[1]);
    const Rz = rotationZ(r[2]);
    const M = multiply(multiply(multiply(T, Rx), Ry), Rz);
    const scale = inputs.scale as [number, number, number];
    // Guard against zero-scale-divides for the normal inverse-transpose
    // — matches geom/transform's treatment.
    const sx = scale[0] !== 0 ? scale[0] : 1e-9;
    const sy = scale[1] !== 0 ? scale[1] : 1e-9;
    const sz = scale[2] !== 0 ? scale[2] : 1e-9;

    // Column-major: M[col*4 + row].
    const m00 = M[0]!, m10 = M[1]!, m20 = M[2]!;
    const m01 = M[4]!, m11 = M[5]!, m21 = M[6]!;
    const m02 = M[8]!, m12 = M[9]!, m22 = M[10]!;
    const m03 = M[12]!, m13 = M[13]!, m23 = M[14]!;

    const positions = new Float32Array(input.positions.length);
    for (let i = 0; i < input.positions.length; i += 3) {
      const px = input.positions[i]! * scale[0];
      const py = input.positions[i + 1]! * scale[1];
      const pz = input.positions[i + 2]! * scale[2];
      positions[i] = m00 * px + m01 * py + m02 * pz + m03;
      positions[i + 1] = m10 * px + m11 * py + m12 * pz + m13;
      positions[i + 2] = m20 * px + m21 * py + m22 * pz + m23;
    }

    // Direction-vector transform shared by normals AND tangents:
    // divide by per-axis scale (diagonal inverse-transpose), apply the
    // rotation part of M (the upper 3×3, which here is purely the
    // Euler product — translation lives in the last column we don't
    // touch), renormalise. Returns a fresh Float32Array, or undefined
    // when the input didn't carry that channel.
    function transformDirections(src: Float32Array | undefined): Float32Array | undefined {
      if (!src) return undefined;
      const out = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        const nx = src[i]! / sx;
        const ny = src[i + 1]! / sy;
        const nz = src[i + 2]! / sz;
        const rx = m00 * nx + m01 * ny + m02 * nz;
        const ry = m10 * nx + m11 * ny + m12 * nz;
        const rz = m20 * nx + m21 * ny + m22 * nz;
        const len = Math.hypot(rx, ry, rz) || 1;
        out[i] = rx / len;
        out[i + 1] = ry / len;
        out[i + 2] = rz / len;
      }
      return out;
    }

    const next: PointCloudValue = {
      positions,
      count: input.count,
    };
    const normals = transformDirections(input.normals);
    if (normals) next.normals = normals;
    const tangents = transformDirections(input.tangents);
    if (tangents) next.tangents = tangents;
    return { points: next };
  },
};
