import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue } from '../core/resources.js';

// Four points at the corners of an axis-aligned rectangle in the XZ
// plane, centred on the origin. The "place a leg / foot at each
// corner" affordance — chairs, tables, beds, plinths, towers all
// share this pattern, and doing it with two perpendicular
// `points-line`s or four hand-wired transforms is a lot of nodes for
// a four-element output. y is fixed at 0; lift via downstream
// transform if you want feet sitting under a tabletop at y=height.
//
// Normals are world-up so downstream `align: true` keeps legs
// upright.
export const cornerPointsNode: NodeDef = {
  id: 'core/corner-points',
  category: 'Geometry/Distribution',
  inputs: [
    {
      name: 'width',
      type: 'Float',
      default: 1,
      min: 0,
      description: 'X extent of the rectangle. Corners sit at ±width/2',
    },
    {
      name: 'depth',
      type: 'Float',
      default: 1,
      min: 0,
      description: 'Z extent of the rectangle. Corners sit at ±depth/2',
    },
    {
      name: 'inset',
      type: 'Float',
      default: 0,
      min: 0,
      description: 'shrinks the rectangle inward by this amount on all sides — useful for placing legs slightly INSIDE the tabletop edge so the leg silhouette doesn\'t hang over the surface. 0 = corners flush with width/depth',
    },
  ],
  outputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: '4 points at (±width/2, 0, ±depth/2), shrunk by `inset`. Order is (-X,-Z), (+X,-Z), (+X,+Z), (-X,+Z) — counterclockwise from the back-left when viewed from above. World-up normals',
    },
  ],
  doc: {
    summary: '4 points at the corners of a rectangle (chair legs, table feet, bed posts).',
    description: `
The dedicated distributor for "one thing at each corner" — chairs,
tables, beds, plinths. Outputs 4 points at \`(±width/2, 0, ±depth/2)\`,
optionally shrunk inward by \`inset\` on all sides.

Order is counterclockwise viewed from above starting at the
back-left: (-x,-z), (+x,-z), (+x,+z), (-x,+z). This is intentional —
if you ever want to fan a per-corner attribute (different colour per
leg for debug, varying heights), the index order is the natural one
to reason about.

Pair with [core/instance-geometry-on-points](../../core/instance-geometry-on-points)
feeding a leg geometry. Normals are world-up so \`align: true\` keeps
the legs vertical — apply a downstream rotation if you want them
canted outward (the "tapered toward the body" look).

Equivalent to \`core/points-line\` × 2 + merge, or 4 hand-wired
\`core/transform\` nodes — but one node instead of 5+.
`,
    sampleGraph: () => {
      const g = createGraph();
      const corners = addNode(g, 'core/corner-points', {
        id: 'corners',
        position: { x: 0, y: 0 },
        inputValues: { width: 1.6, depth: 1, inset: 0.1 },
      });
      const leg = addNode(g, 'core/cylinder', {
        id: 'leg',
        position: { x: 0, y: 200 },
        inputValues: { radius: 0.05, height: 0.7, segments: 16 },
      });
      const inst = addNode(g, 'core/instance-geometry-on-points', {
        id: 'inst',
        position: { x: 280, y: 100 },
        inputValues: { scale: 1, align: true },
      });
      addEdge(g, { node: corners.id, socket: 'points' }, { node: inst.id, socket: 'points' });
      addEdge(g, { node: leg.id, socket: 'geometry' }, { node: inst.id, socket: 'instance' });
      return { graph: g, rootNodeId: 'inst' };
    },
  },
  evaluate(_ctx, inputs): { points: PointCloudValue } {
    const width = inputs.width as number;
    const depth = inputs.depth as number;
    const inset = inputs.inset as number;
    const hx = Math.max(0, width / 2 - inset);
    const hz = Math.max(0, depth / 2 - inset);
    // CCW from the back-left when looking down +Y (i.e. -Z is "back").
    const corners: Array<[number, number]> = [
      [-hx, -hz],
      [+hx, -hz],
      [+hx, +hz],
      [-hx, +hz],
    ];
    const positions = new Float32Array(4 * 3);
    const normals = new Float32Array(4 * 3);
    for (let i = 0; i < 4; i++) {
      positions[i * 3]     = corners[i]![0];
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = corners[i]![1];
      normals[i * 3 + 1] = 1;
    }
    return { points: { positions, normals, count: 4 } };
  },
};
