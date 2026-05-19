import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue } from '../core/resources.js';

// Botanically-flavoured point placement along a stem. The three modes
// match the three textbook leaf-arrangement patterns:
//
//   mode=0  alternate — one leaf per node, rotated `nodeRotation`
//          degrees from the previous (default 137.5° = golden angle =
//          spiral phyllotaxis; pass 180 for strict left/right alternate)
//   mode=1  opposite  — two leaves per node, 180° apart, with each
//          successive pair rotated `nodeRotation` from the previous
//          (default 90° = decussate; consecutive pairs perpendicular,
//          which is what mints, maples, and most opposite-leaved
//          plants look like from above)
//   mode=2  whorled   — `whorlCount` leaves per node, evenly spaced
//          around the stem; each successive whorl rotated
//          `nodeRotation` from the previous (default 0 = aligned;
//          set to 60° for the staggered look of bedstraw)
//
// `tilt` controls how far each leaf's normal is rotated toward the
// stem tip vs. the perpendicular-to-stem direction. 0 = leaves stick
// straight out; 60-ish gives the natural "leaves slope upward" look.
//
// Produces a PointCloud whose normals are the leaf attachment
// directions. Pair with `core/instance-geometry-on-points` +
// `align: true` to actually place leaves; the leaf mesh's local +Y
// will align to each normal.
export const stemPointsNode: NodeDef = {
  id: 'core/stem-points',
  category: 'Geometry/Distribution',
  inputs: [
    {
      name: 'start',
      type: 'Vec3',
      default: [0, 0, 0],
      description: 'base of the stem (first node sits at start + nodeSpacing * axis)',
    },
    {
      name: 'axis',
      type: 'Vec3',
      default: [0, 1, 0],
      description: 'stem direction (unit-normalised internally)',
    },
    {
      name: 'length',
      type: 'Float',
      default: 1,
      description: 'total stem length along axis. Nodes are evenly spaced over this distance',
    },
    {
      name: 'nodes',
      type: 'Int',
      default: 5,
      description: 'number of attachment levels along the stem',
    },
    {
      name: 'mode',
      type: 'Int',
      default: 0,
      description: '0=alternate (1 leaf/node), 1=opposite (2/node), 2=whorled (whorlCount/node)',
    },
    {
      name: 'whorlCount',
      type: 'Int',
      default: 3,
      description: 'leaves per node when mode=whorled. Ignored otherwise',
    },
    {
      name: 'nodeRotation',
      type: 'Float',
      default: 137.508,
      description:
        'degrees of rotation between successive nodes around the stem. Defaults: 137.5° golden-angle spiral for alternate, 90° decussate for opposite (set explicitly), 0° aligned for whorled',
    },
    {
      name: 'startAngle',
      type: 'Float',
      default: 0,
      description: 'rotation in degrees applied to the first node',
    },
    {
      name: 'tilt',
      type: 'Float',
      default: 60,
      description:
        'angle in degrees between leaf normals and the perpendicular-to-stem direction. 0 = leaves stick straight out; 90 = aligned with the stem tip',
    },
    {
      name: 'startOffset',
      type: 'Float',
      default: 0.1,
      description:
        'distance from `start` to the first node, as a fraction of `length`. Lets you keep the base of the stem bare',
    },
    { name: 'seed', type: 'Float', default: 0.5 },
  ],
  outputs: [{ name: 'points', type: 'PointCloud' }],
  evaluate(_ctx, inputs): { points: PointCloudValue } {
    const start = inputs.start as [number, number, number];
    const axisRaw = inputs.axis as [number, number, number];
    const length = inputs.length as number;
    const nodes = Math.max(0, Math.floor(inputs.nodes as number));
    const mode = Math.max(0, Math.min(2, Math.floor(inputs.mode as number)));
    const whorlCount = Math.max(1, Math.floor(inputs.whorlCount as number));
    const nodeRotationDeg = inputs.nodeRotation as number;
    const startAngleDeg = inputs.startAngle as number;
    const tiltDeg = inputs.tilt as number;
    const startOffset = inputs.startOffset as number;
    void inputs.seed;

    let [ax, ay, az] = axisRaw;
    let aLen = Math.hypot(ax, ay, az);
    if (aLen < 1e-8) {
      ax = 0; ay = 1; az = 0; aLen = 1;
    }
    ax /= aLen; ay /= aLen; az /= aLen;

    // Perpendicular-plane basis (same construction as radial / phyllotaxis).
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

    // How many points per node, and what's the in-node angular offset?
    const perNode = mode === 0 ? 1 : mode === 1 ? 2 : whorlCount;
    const inNodeStep = (2 * Math.PI) / perNode;
    const nodeRotationRad = (nodeRotationDeg * Math.PI) / 180;
    const startAngleRad = (startAngleDeg * Math.PI) / 180;
    const tiltRad = (tiltDeg * Math.PI) / 180;
    const cTilt = Math.cos(tiltRad);
    const sTilt = Math.sin(tiltRad);

    const total = nodes * perNode;
    const positions = new Float32Array(total * 3);
    const normals = new Float32Array(total * 3);

    // First node sits at startOffset along the stem, last at length.
    // Linearly interpolate between the two.
    const nodesDenom = Math.max(1, nodes - 1);
    let outIdx = 0;
    for (let n = 0; n < nodes; n++) {
      const t = nodes === 1 ? startOffset : startOffset + (1 - startOffset) * (n / nodesDenom);
      const along = length * t;
      const px = start[0] + ax * along;
      const py = start[1] + ay * along;
      const pz = start[2] + az * along;
      const nodeAngle = startAngleRad + n * nodeRotationRad;
      for (let k = 0; k < perNode; k++) {
        const phi = nodeAngle + k * inNodeStep;
        const c = Math.cos(phi);
        const s = Math.sin(phi);
        // In-plane outward direction at this leaf's slot.
        const ox = c * n1x + s * n2x;
        const oy = c * n1y + s * n2y;
        const oz = c * n1z + s * n2z;
        positions[outIdx * 3]     = px;
        positions[outIdx * 3 + 1] = py;
        positions[outIdx * 3 + 2] = pz;
        // Tilted normal: outward × cos(tilt) + axis × sin(tilt).
        normals[outIdx * 3]     = ox * cTilt + ax * sTilt;
        normals[outIdx * 3 + 1] = oy * cTilt + ay * sTilt;
        normals[outIdx * 3 + 2] = oz * cTilt + az * sTilt;
        outIdx++;
      }
    }

    return { points: { positions, normals, count: total } };
  },
};
