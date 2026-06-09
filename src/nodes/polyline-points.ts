import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue } from '../core/resources.js';

// Distribute points along a list of polylines at a fixed spacing,
// optionally offset perpendicular to the line direction. Pairs with
// `core/polyline-buffer-list` — same `lines` input format (flat
// Vec3[] of pairs, each pair = one infinite line) — so the same
// authored road network can drive both the asphalt mesh and the
// "lamp post every 25 m along the kerb" placements.
//
// Conventions match polygon-perimeter-points so downstream scatter
// orients cleanly:
//   • position  — on the polyline, offset perpendicular by `side_offset`
//   • normal    — (0, 1, 0) world up
//   • tangent   — line direction (a→b), so scatter `align: true` faces
//                 instances along the line. A consumer that wants
//                 them perpendicular (e.g. signal arms hanging across
//                 the road) can pre-rotate the source scene.
//
// `side_offset` is signed: positive = 90° CCW from the line direction
// in XZ (= left of travel a→b). Negative = right. Pass the node twice
// with ±offset and scene-merge for "both kerbs of every road" in one
// graph.

function len2(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

export const polylinePointsNode: NodeDef = {
  id: 'core/polyline-points',
  category: 'Polyline',
  inputs: [
    {
      name: 'lines',
      type: 'Vec3',
      description: 'flat array of Vec3 endpoints, two per line. Same format as `core/polyline-buffer-list` so one ROAD_LINES const drives both road meshes and per-line point placement',
    },
    {
      name: 'spacing',
      type: 'Float',
      default: 25,
      min: 0.01,
      description: 'distance between consecutive points along each line, in world units',
    },
    {
      name: 'end_clearance',
      type: 'Float',
      default: 0,
      min: 0,
      description: 'minimum distance from each line endpoint before a point is placed. Useful for "no lamp post right at the intersection corner" — set to the intersection\'s half-width so the first point sits beyond the cross-street curb',
    },
    {
      name: 'side_offset',
      type: 'Float',
      default: 0,
      description: 'signed perpendicular offset from the line. Positive = LEFT of travel direction (90° CCW in XZ); negative = right. Use two instances with ±offset to seed both kerbs',
    },
    {
      name: 'self_avoid_radius',
      type: 'Float',
      default: 0,
      min: 0,
      description: 'when > 0, compute every pairwise intersection of the input lines and drop any candidate point within this radius of any intersection. Use this for "no lamp post in the middle of a road intersection" — radius = half road width + a margin clears the asphalt cleanly. Set to 0 to disable',
    },
    {
      name: 'y',
      type: 'Float',
      default: 0,
      description: 'world Y the points sit at',
    },
  ],
  outputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: 'evenly-spaced points along each polyline. `normals` are world up; `tangents` are the line direction',
    },
  ],
  doc: {
    summary: 'Evenly-spaced points along a set of polylines, optionally offset perpendicular.',
    description: `
For each pair of points in \`lines\`, walk the line at a fixed
\`spacing\` and emit a point per step, offset perpendicular by
\`side_offset\`. Pair with [core/polyline-buffer-list](../../core/polyline-buffer-list)
so a single \`ROAD_LINES\` const drives both the asphalt mesh and the
furniture placements.

Output orientation matches [core/polygon-perimeter-points](../../core/polygon-perimeter-points):
\`normals\` are world-up so downstream \`align: true\` keeps instances
vertical, and \`tangents\` point along the line so the instance's
local +X axis lines up with the line direction.
`,
    sampleGraph: () => {
      const g = createGraph();
      const pts = addNode(g, 'core/polyline-points', {
        id: 'pts',
        position: { x: 0, y: 0 },
        inputValues: {
          lines: [
            [-30, 0, 0], [30, 0, 0],
            [0, 0, -20], [0, 0, 20],
          ],
          spacing: 5,
          side_offset: 1.5,
        },
      });
      return { graph: g, rootNodeId: pts.id };
    },
  },
  evaluate(_ctx, inputs): { points: PointCloudValue } {
    // Vec3 inputs arrive as a flat Float32Array OR an array of
    // [x,y,z] arrays depending on upstream. Normalise to a flat
    // [x0,y0,z0,x1,y1,z1,...] form so the per-segment walk below
    // can index uniformly.
    const empty: PointCloudValue = {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      tangents: new Float32Array(0),
      count: 0,
    };
    const rawLines = inputs.lines as unknown;
    const flat: number[] = [];
    if (Array.isArray(rawLines)) {
      for (const item of rawLines) {
        if (Array.isArray(item)) {
          // [x,y,z] form
          flat.push(item[0] as number, item[1] as number, item[2] as number);
        } else if (typeof item === 'number') {
          flat.push(item);
        }
      }
    } else if (rawLines instanceof Float32Array) {
      for (let i = 0; i < rawLines.length; i++) flat.push(rawLines[i]!);
    }
    if (flat.length < 6) return { points: empty };

    const spacing = Math.max(0.01, inputs.spacing as number);
    const endClearance = Math.max(0, (inputs.end_clearance as number) ?? 0);
    const sideOffset = (inputs.side_offset as number) ?? 0;
    const selfAvoidRadius = Math.max(0, (inputs.self_avoid_radius as number) ?? 0);
    const y = (inputs.y as number) ?? 0;
    const segCount = Math.floor(flat.length / 6);

    // Pre-compute pairwise intersection points (XZ only — Y is
    // ignored as lines all sit on the ground plane). Treat each pair
    // (a,b) as an INFINITE line and only keep intersections that
    // fall inside BOTH segments. n² in segCount but segCount is small
    // here (6 roads) so this stays cheap.
    const intersections: { x: number; z: number }[] = [];
    if (selfAvoidRadius > 0 && segCount >= 2) {
      for (let i = 0; i < segCount; i++) {
        const ax = flat[i * 6]!,     az = flat[i * 6 + 2]!;
        const bx = flat[i * 6 + 3]!, bz = flat[i * 6 + 5]!;
        const dx1 = bx - ax, dz1 = bz - az;
        for (let j = i + 1; j < segCount; j++) {
          const cx = flat[j * 6]!,     cz = flat[j * 6 + 2]!;
          const dx = flat[j * 6 + 3]!, dz = flat[j * 6 + 5]!;
          const dx2 = dx - cx, dz2 = dz - cz;
          // Solve a + t1·d1 = c + t2·d2 in XZ. Cramer's rule, where
          // denom = d1 × d2 (2D cross product).
          const denom = dx1 * dz2 - dz1 * dx2;
          if (Math.abs(denom) < 1e-9) continue;  // parallel
          const t1 = ((cx - ax) * dz2 - (cz - az) * dx2) / denom;
          const t2 = ((cx - ax) * dz1 - (cz - az) * dx1) / denom;
          if (t1 < 0 || t1 > 1 || t2 < 0 || t2 > 1) continue;  // outside segment
          intersections.push({ x: ax + dx1 * t1, z: az + dz1 * t1 });
        }
      }
    }
    const r2 = selfAvoidRadius * selfAvoidRadius;
    function tooCloseToIntersection(x: number, z: number): boolean {
      for (const ip of intersections) {
        const ddx = x - ip.x, ddz = z - ip.z;
        if (ddx * ddx + ddz * ddz < r2) return true;
      }
      return false;
    }

    // Two-pass: count first, then allocate exact-sized arrays.
    const segs: Array<{
      ax: number; az: number;
      dx: number; dz: number;
      px: number; pz: number;  // perpendicular = 90° CCW(dx, dz) in XZ = (-dz, dx)
      startArc: number;
      count: number;          // number of accept[] entries set to true
      accept: boolean[];      // length = numCandidates; per-candidate keep/skip
    }> = [];
    let total = 0;
    for (let s = 0; s < segCount; s++) {
      const ax = flat[s * 6]!;
      const az = flat[s * 6 + 2]!;
      const bx = flat[s * 6 + 3]!;
      const bz = flat[s * 6 + 5]!;
      const dxRaw = bx - ax;
      const dzRaw = bz - az;
      const segLen = len2(dxRaw, dzRaw);
      if (segLen < 1e-12) continue;
      const usable = segLen - 2 * endClearance;
      if (usable < 0) continue;
      // Same placement maths as polygon-perimeter-points so a
      // `polyline-points + corner_clearance` reads the same as a
      // `polygon-perimeter-points` on a single edge.
      const numCandidates = Math.max(1, Math.floor(usable / spacing) + 1);
      const totalSpan = (numCandidates - 1) * spacing;
      const startArc = endClearance + (usable - totalSpan) / 2;
      const dx = dxRaw / segLen;
      const dz = dzRaw / segLen;
      const px = -dz, pz = dx;
      // Cull placements that land at the segment's END (= shared
      // vertex with the next segment when polylines are chained) OR
      // within self_avoid_radius of a self-intersection.
      let actualCount = 0;
      const accept: boolean[] = [];
      for (let k = 0; k < numCandidates; k++) {
        const arc = startArc + k * spacing;
        if (arc >= segLen - 1e-9) { accept.push(false); continue; }
        const lineX = ax + dx * arc;
        const lineZ = az + dz * arc;
        const px2 = lineX + px * sideOffset;
        const pz2 = lineZ + pz * sideOffset;
        if (tooCloseToIntersection(px2, pz2)) { accept.push(false); continue; }
        accept.push(true);
        actualCount++;
      }
      if (actualCount === 0) continue;
      segs.push({
        ax, az,
        dx, dz,
        px, pz,  // 90° CCW perpendicular in XZ
        startArc,
        count: actualCount,
        accept,
      });
      total += actualCount;
    }
    if (total === 0) return { points: empty };

    const positions = new Float32Array(total * 3);
    const normals = new Float32Array(total * 3);
    const tangents = new Float32Array(total * 3);
    let p = 0;
    for (const s of segs) {
      for (let k = 0; k < s.accept.length; k++) {
        if (!s.accept[k]) continue;
        const arc = s.startArc + k * spacing;
        const lineX = s.ax + s.dx * arc;
        const lineZ = s.az + s.dz * arc;
        const x = lineX + s.px * sideOffset;
        const z = lineZ + s.pz * sideOffset;
        positions[p * 3]     = x;
        positions[p * 3 + 1] = y;
        positions[p * 3 + 2] = z;
        normals[p * 3]     = 0;
        normals[p * 3 + 1] = 1;
        normals[p * 3 + 2] = 0;
        tangents[p * 3]     = s.dx;
        tangents[p * 3 + 1] = 0;
        tangents[p * 3 + 2] = s.dz;
        p++;
      }
    }
    return { points: { positions, normals, tangents, count: total } };
  },
};
