import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue } from '../core/resources.js';

// N points fanned around an axis at evenly-spaced angles. The generalised
// "palm-frond fan" — useful as a source for any radially-symmetric
// arrangement that doesn't grow from a branch (daisy / dandelion petals,
// asterisks of grass, lily-pad lobes, halo of bracts around a flower
// center, …).
//
// All points sit at `center + radiusOffset * outward_direction`, where
// `outward_direction` is a unit vector lying in the plane perpendicular
// to `axis` at angle `baseAngle + i/count * 360°`. Each point's normal
// is that outward direction, optionally tilted toward `axis` by
// `tilt` degrees (with per-point jitter). Downstream
// `instance-geometry-on-points` with `align: true` will then orient
// each instance to face along the tilted normal.
//
// Combine with `core/single-point` + `instance-scene-on-points` to
// place a whole flower scene in the world, or feed this directly into
// `instance-geometry-on-points` with a single petal mesh.
export const radialPointsNode: NodeDef = {
  id: 'core/radial-points',
  category: 'Geometry/Distribution',
  inputs: [
    {
      name: 'center',
      type: 'Vec3',
      default: [0, 0, 0],
      description: 'flower / cluster center in world space',
    },
    {
      name: 'axis',
      type: 'Vec3',
      default: [0, 1, 0],
      description: "the cluster's local up axis; points fan around this in the perpendicular plane",
    },
    {
      name: 'count',
      type: 'Int',
      default: 5,
      min: 0,
      description: 'how many points to emit',
    },
    {
      name: 'radiusOffset',
      type: 'Float',
      default: 0,
      description:
        'distance from center along the in-plane direction. 0 = all points at the center (palm-frond style); >0 = points lifted to a ring (petals attached to a receptacle)',
    },
    {
      name: 'tilt',
      type: 'Float',
      default: 0,
      description:
        'degrees each point\'s normal is rotated toward `axis`. 0 = normals lie in the petal plane (flat flower); 90 = normals along axis (closed bud); negative tilts past the plane the other way',
    },
    {
      name: 'tiltJitter',
      type: 'Float',
      default: 0,
      description: 'per-point random tilt added on top of `tilt` (degrees)',
    },
    {
      name: 'baseAngle',
      type: 'Float',
      default: 0,
      description: 'rotation offset (degrees) for the first point. Use to stagger two rings into a double-row arrangement',
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0.37,
      description: 'jitter seed; same seed reproduces the same per-point tilt jitter',
    },
  ],
  outputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: '`count` points evenly spaced around the axis. Normals are the outward direction tilted by `tilt` toward the axis',
    },
  ],
  doc: {
    summary: 'Fan N points around an axis at evenly-spaced angles (palm fronds, daisy petals).',
    description: `
The generalised radial fan. All points sit at
\`center + radiusOffset · outward_direction\` where the outward
direction lies in the plane perpendicular to \`axis\` at angle
\`baseAngle + i/count · 360°\`.

Each point's normal is that outward direction, optionally tilted
toward \`axis\` by \`tilt\` degrees (with per-point random jitter).
A downstream
[core/instance-geometry-on-points](../../core/instance-geometry-on-points)
with \`align: true\` will orient each instance to face along the
tilted normal.

Use cases — anything radially-symmetric that doesn't grow from a
branch: palm fronds (radiusOffset = 0, tilt > 0), daisy / dandelion
petals (radiusOffset > 0, small tilt), halo of bracts around a flower
center, asterisks of grass. Combine with
[core/single-point](../../core/single-point) +
[core/instance-scene-on-points](../../core/instance-scene-on-points)
to place a whole flower scene at a point.
`,
    sampleGraph: () => {
      const g = createGraph();
      const points = addNode(g, 'core/radial-points', {
        id: 'points',
        position: { x: 0, y: 0 },
        inputValues: {
          center: [0, 0, 0], axis: [0, 1, 0],
          count: 8, radiusOffset: 1, tilt: 30, tiltJitter: 0,
          baseAngle: 0, seed: 0.37,
        },
      });
      const cube = addNode(g, 'core/cube', {
        id: 'cube',
        position: { x: 0, y: 200 },
        inputValues: { size: 1 },
      });
      const inst = addNode(g, 'core/instance-geometry-on-points', {
        id: 'inst',
        position: { x: 280, y: 100 },
        inputValues: { scale: 0.25, align: true },
      });
      addEdge(g, { node: points.id, socket: 'points' }, { node: inst.id, socket: 'points' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: inst.id, socket: 'instance' });
      return { graph: g, rootNodeId: 'inst' };
    },
  },
  evaluate(_ctx, inputs): { points: PointCloudValue } {
    const center = inputs.center as [number, number, number];
    const axisRaw = inputs.axis as [number, number, number];
    const count = Math.max(0, Math.floor(inputs.count as number));
    const radiusOffset = inputs.radiusOffset as number;
    const tiltDeg = inputs.tilt as number;
    const tiltJitterDeg = inputs.tiltJitter as number;
    const baseAngleDeg = inputs.baseAngle as number;
    const seed = inputs.seed as number;

    // Normalize the axis. A zero-length axis would produce NaN normals;
    // fall back to world-up so the node degrades to a flat-on-XZ flower
    // rather than emitting garbage.
    let [ax, ay, az] = axisRaw;
    let aLen = Math.hypot(ax, ay, az);
    if (aLen < 1e-8) {
      ax = 0; ay = 1; az = 0; aLen = 1;
    }
    ax /= aLen; ay /= aLen; az /= aLen;

    // Two unit basis vectors spanning the plane perpendicular to axis.
    // Reference vector is whichever world axis is least parallel to
    // `axis` — avoids a degenerate cross product near axis-parallel.
    const refX = Math.abs(ax) < 0.9 ? 1 : 0;
    const refY = Math.abs(ax) < 0.9 ? 0 : 1;
    const refZ = 0;
    // n1 = normalize(ref - (ref·axis)·axis)
    const refDotAxis = refX * ax + refY * ay + refZ * az;
    let n1x = refX - refDotAxis * ax;
    let n1y = refY - refDotAxis * ay;
    let n1z = refZ - refDotAxis * az;
    const n1len = Math.hypot(n1x, n1y, n1z) || 1;
    n1x /= n1len; n1y /= n1len; n1z /= n1len;
    // n2 = axis × n1 (orthogonal to both, completes the right-handed basis).
    const n2x = ay * n1z - az * n1y;
    const n2y = az * n1x - ax * n1z;
    const n2z = ax * n1y - ay * n1x;

    // Deterministic per-point jitter. Same seed → same jitter sequence.
    let rngState = (Math.floor(seed * 1_000_000) | 0) >>> 0 || 1;
    const rand = () => {
      rngState = (rngState + 0x6d2b79f5) >>> 0;
      let t = rngState;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const tiltRad = (tiltDeg * Math.PI) / 180;
    const tiltJitterRad = (tiltJitterDeg * Math.PI) / 180;
    const baseAngleRad = (baseAngleDeg * Math.PI) / 180;
    for (let i = 0; i < count; i++) {
      const phi = baseAngleRad + (i / Math.max(1, count)) * 2 * Math.PI;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      // Outward direction in the perpendicular plane.
      const ox = c * n1x + s * n2x;
      const oy = c * n1y + s * n2y;
      const oz = c * n1z + s * n2z;

      // Position: center plus a radial offset along the outward direction.
      positions[i * 3]     = center[0] + ox * radiusOffset;
      positions[i * 3 + 1] = center[1] + oy * radiusOffset;
      positions[i * 3 + 2] = center[2] + oz * radiusOffset;

      // Tilt the normal toward `axis`. Per-point jitter offsets the
      // effective tilt by ±tiltJitter/2 (uniform).
      const j = (rand() - 0.5) * tiltJitterRad;
      const effective = tiltRad + j;
      const cTilt = Math.cos(effective);
      const sTilt = Math.sin(effective);
      normals[i * 3]     = ox * cTilt + ax * sTilt;
      normals[i * 3 + 1] = oy * cTilt + ay * sTilt;
      normals[i * 3 + 2] = oz * cTilt + az * sTilt;
    }

    return { points: { positions, normals, count } };
  },
};
