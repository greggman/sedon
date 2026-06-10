import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue } from '../core/resources.js';

// Spiral arrangement of points — what real plants use for seed heads
// (sunflower disc), cone scales, succulent rosettes, hop cones. Each
// successive point is rotated by `angle` degrees around `axis` and
// stepped forward along the stem; with `angle = 137.5°` (the golden
// angle) the spiral packs into the visually-familiar Fibonacci pattern
// because consecutive points never share a rational fraction of the
// circle.
//
// The point at index i sits at:
//   center + (i / (count - 1)) * length * axis_unit
//          + radius_at_i * (cos(i * angle) * n1 + sin(i * angle) * n2)
//
// where n1, n2 span the plane perpendicular to axis. `radius_at_i`
// is `radius * lerp(1, radiusGrowth, i/(count-1))`, so:
//   • radiusGrowth = 1: cylindrical (constant radius). Stem-rosette.
//   • radiusGrowth = 0: tapers to a point. Pinecone or grass-tip cluster.
//   • radiusGrowth > 1: opens up. Sunflower head, fern unfurling.
export const phyllotaxisPointsNode: NodeDef = {
  id: 'points/phyllotaxis',
  category: 'Geometry/Distribution',
  inputs: [
    {
      name: 'center',
      type: 'Vec3',
      default: [0, 0, 0],
      description: 'starting position of the spiral (point i=0 sits here, in the perpendicular plane)',
    },
    {
      name: 'axis',
      type: 'Vec3',
      default: [0, 1, 0],
      description: 'spiral axis; points advance along this direction by `length` total',
    },
    {
      name: 'length',
      type: 'Float',
      default: 0,
      description: 'distance along axis from i=0 to i=count-1. 0 = flat disc (sunflower head)',
    },
    {
      name: 'count',
      type: 'Int',
      default: 50,
      min: 0,
      description: 'how many points to emit',
    },
    {
      name: 'angle',
      type: 'Float',
      default: 137.508,
      description:
        'rotation in degrees between successive points. 137.508° is the golden angle (real-plant phyllotaxis); other useful values: 180 (alternate), 90 (cruciate), 144 (5-fold whorls)',
    },
    {
      name: 'radius',
      type: 'Float',
      default: 0.5,
      description: 'radial distance from axis for point i=0',
    },
    {
      name: 'radiusGrowth',
      type: 'Float',
      default: 1,
      description:
        'radius multiplier at the last point. 1 = constant radius; 0 = tapers to the axis (pinecone); >1 = opens outward (sunflower head fills as i grows)',
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0.5,
      description: 'small per-point jitter seed; does not affect the spiral structure',
    },
  ],
  outputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: '`count` points arranged in a phyllotactic spiral. Normals point outward from the axis at each point',
    },
  ],
  doc: {
    summary: 'Spiral arrangement of points — sunflower seeds, pinecones, succulent rosettes.',
    description: `
What real plants use for tight seed packing. Each successive point is
rotated by \`angle\` degrees around \`axis\` and stepped forward along
the stem. With \`angle = 137.508°\` (the **golden angle**) the spiral
packs into the visually-familiar Fibonacci pattern — consecutive
points never share a rational fraction of the circle, so they tile
the disc densely without lining up into visible spokes.

The point at index i sits at:
\`\`\`
center + (i / (count-1)) · length · axis_unit
       + radius_at_i · (cos(i·angle) · n1 + sin(i·angle) · n2)
\`\`\`

where n1, n2 span the plane perpendicular to \`axis\`. \`radius_at_i\`
lerps from \`radius\` toward \`radius · radiusGrowth\`:

- \`radiusGrowth = 1\`: cylindrical (constant radius) — stem rosette.
- \`radiusGrowth = 0\`: tapers to a point — pinecone or grass-tip cluster.
- \`radiusGrowth > 1\`: opens outward — sunflower head, fern unfurling.

For a flat sunflower-disc layout set \`length = 0\` and \`radiusGrowth > 1\`.
Other \`angle\` values are useful too: 180 = alternate leaves, 90 =
cruciate (cabbage), 144 = 5-fold whorls.
`,
    sampleGraph: () => {
      const g = createGraph();
      const points = addNode(g, 'points/phyllotaxis', {
        id: 'points',
        position: { x: 0, y: 0 },
        inputValues: {
          center: [0, 0, 0], axis: [0, 1, 0], length: 0,
          count: 80, angle: 137.508, radius: 0.08, radiusGrowth: 6,
          seed: 0.5,
        },
      });
      const cube = addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 0, y: 200 },
        inputValues: { size: 1 },
      });
      const inst = addNode(g, 'geom/instance-on-points', {
        id: 'inst',
        position: { x: 280, y: 100 },
        inputValues: { scale: 0.06, align: true },
      });
      addEdge(g, { node: points.id, socket: 'points' }, { node: inst.id, socket: 'points' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: inst.id, socket: 'instance' });
      return { graph: g, rootNodeId: 'inst' };
    },
  },
  evaluate(_ctx, inputs): { points: PointCloudValue } {
    const center = inputs.center as [number, number, number];
    const axisRaw = inputs.axis as [number, number, number];
    const length = inputs.length as number;
    const count = Math.max(0, Math.floor(inputs.count as number));
    const angleDeg = inputs.angle as number;
    const radius = inputs.radius as number;
    const radiusGrowth = inputs.radiusGrowth as number;
    // seed currently unused (placement is deterministic from index +
    // angle), but accepted so a future variant can add a per-point
    // perturbation without breaking saved graphs.
    void inputs.seed;

    let [ax, ay, az] = axisRaw;
    let aLen = Math.hypot(ax, ay, az);
    if (aLen < 1e-8) {
      ax = 0; ay = 1; az = 0; aLen = 1;
    }
    ax /= aLen; ay /= aLen; az /= aLen;

    // Perpendicular-plane basis. Same construction as points/radial.
    const refX = Math.abs(ax) < 0.9 ? 1 : 0;
    const refY = Math.abs(ax) < 0.9 ? 0 : 1;
    const refDotAxis = refX * ax + refY * ay;
    let n1x = refX - refDotAxis * ax;
    let n1y = refY - refDotAxis * ay;
    let n1z = -refDotAxis * az;
    const n1len = Math.hypot(n1x, n1y, n1z) || 1;
    n1x /= n1len; n1y /= n1len; n1z /= n1len;
    const n2x = ay * n1z - az * n1y;
    const n2y = az * n1x - ax * n1z;
    const n2z = ax * n1y - ay * n1x;

    const angleRad = (angleDeg * Math.PI) / 180;

    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const denom = Math.max(1, count - 1);
    for (let i = 0; i < count; i++) {
      const t = i / denom; // 0..1
      const rScale = 1 + (radiusGrowth - 1) * t;
      const r = radius * rScale;
      const phi = i * angleRad;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      // Outward direction at this index.
      const ox = c * n1x + s * n2x;
      const oy = c * n1y + s * n2y;
      const oz = c * n1z + s * n2z;
      // Position: center + offset along axis + radial offset.
      const along = length * t;
      positions[i * 3]     = center[0] + ax * along + ox * r;
      positions[i * 3 + 1] = center[1] + ay * along + oy * r;
      positions[i * 3 + 2] = center[2] + az * along + oz * r;
      // Normals point radially outward (perpendicular to axis). This
      // matches what a seed/scale facing-out wants. Consumers that
      // need axis-aligned normals can transform downstream.
      normals[i * 3]     = ox;
      normals[i * 3 + 1] = oy;
      normals[i * 3 + 2] = oz;
    }

    return { points: { positions, normals, count } };
  },
};
