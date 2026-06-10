import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PathValue } from '../core/resources.js';
import { readCurve2DPoints, sampleCurve2D } from '../render/curve-2d.js';

// Default profile: a small candlestick-style silhouette with three
// distinct sections. Tuple shape is `[x, handleType, y]` to match
// the existing `point-list` editor's axis convention (see
// curve-2d.ts comment). All points default to SMOOTH (handleType=0)
// for now; the per-point handle-type UI is a queued follow-up.
const DEFAULT_POINTS: [number, number, number][] = [
  [0.04, 0, 0.00],
  [0.10, 0, 0.04],
  [0.10, 0, 0.10],
  [0.04, 0, 0.16],
  [0.05, 0, 0.55],
  [0.08, 0, 0.62],
  [0.05, 0, 0.68],
  [0.06, 0, 0.95],
  [0.10, 0, 1.00],
];

export const curve2dNode: NodeDef = {
  id: 'path/curve-2d',
  category: 'Geometry/Primitives',
  inputs: [
    {
      name: 'points',
      type: 'Vec3',
      widget: 'point-list',
      hideSocket: true,
      // Y is "up" in the curve-2d profile (matches the lathe's world
      // Y axis after revolution). Without this flip the editor would
      // render the silhouette upside-down relative to how it appears
      // in the 3D preview.
      flipY: true,
      // Opt the editor into the Bezier-handle UI: draggable tangent
      // dots on selected anchors, ctrl-click cycles handle type.
      bezierHandles: true,
      default: DEFAULT_POINTS,
      description:
        'control points in the XY plane. X / Y are the position; the third tuple component encodes the handle type (0 = smooth, 1 = corner). The 2D editor only authors X and Y today — per-point handle-type UI is a follow-up; until then, all points are smooth',
    },
    {
      // The `point-list` widget reads `world_size` to scale the editor
      // canvas to author coordinates. Default 1.2×1.2m suits typical
      // furniture-profile scale (chair legs, candlesticks, vases under
      // ~1m tall). Without this, the editor defaults to 40×40m and
      // sub-metre profiles collapse to a dot at canvas centre.
      name: 'world_size',
      type: 'Vec2',
      default: [1.2, 1.2],
      description:
        'extent of the 2D editor canvas (metres). Pick a size that frames the profile comfortably — too small clips the curve at the edges, too large makes the curve a dot in the middle',
    },
    {
      name: 'samples_per_segment',
      type: 'Int',
      default: 16,
      min: 1,
      description:
        'resampling density between consecutive control points. Higher = smoother curve but more downstream geometry; 8-16 is the sweet spot for lathe / extrude profiles',
    },
    {
      name: 'closed',
      type: 'Bool',
      default: false,
      description:
        'when on, the last control point connects back to the first as a closed loop. Off (default) for lathe / extrude profiles where the endpoints matter; on for cross-sections that form a tube',
    },
  ],
  outputs: [
    {
      name: 'path',
      type: 'Path',
      description:
        'sampled polyline in the XY plane (Z = 0 on every sample). Feed into [geom/lathe](../../geom/lathe), [geom/extrude-on-path](../../geom/extrude-on-path), or any other Path consumer',
    },
  ],
  doc: {
    summary:
      '2D Bezier curve authored with per-point handle types — smooth bulges and sharp corners on the same silhouette.',
    description: `
Authors a 2D curve in the XY plane with per-point handle types
(\`smooth\` vs \`corner\`) and samples it into a polyline. The output
is a \`Path\` consumable by [geom/lathe](../../geom/lathe) for surfaces
of revolution (turned legs, candlesticks, vases), by
[geom/extrude-on-path](../../geom/extrude-on-path) for sweep
cross-sections (mouldings, cables), and by anything else that takes
the \`Path\` type.

Smooth points get auto-computed Catmull-Rom-style tangents — the
curve flows continuously through them. Corner points get
zero-length tangents — the cubic Bezier degenerates into a straight
line into the corner, producing a visible kink in the resulting
geometry. The two handle types let one silhouette mix bulges and
sharp transitions on the same curve (a turned leg with rounded
bulges separated by sharp necks).

The data shape per control point is \`[x, y, handleTypeCode]\` —
the third component is 0 (smooth) or 1 (corner). The 2D editor
authors X and Y today; the per-point handle-type UI is a queued
follow-up, so for now you'd hand-edit a JSON inputValue if you want
non-smooth points. The default profile is a smooth candlestick
silhouette.
`,
    sampleGraph: () => {
      const g = createGraph();
      const curve = addNode(g, 'path/curve-2d', {
        id: 'curve',
        position: { x: 0, y: 0 },
        inputValues: { points: DEFAULT_POINTS, samples_per_segment: 16 },
      });
      const lathe = addNode(g, 'geom/lathe', {
        id: 'lathe',
        position: { x: 280, y: 0 },
        inputValues: { segments: 32 },
      });
      const material = addNode(g, 'material/pbr', {
        id: 'material',
        position: { x: 280, y: 240 },
        inputValues: { basecolor: [0.55, 0.36, 0.20, 1], roughness: 0.6, metallic: 0 },
      });
      const entity = addNode(g, 'scene/entity', {
        id: 'entity',
        position: { x: 560, y: 120 },
      });
      addEdge(g, { node: curve.id, socket: 'path' }, { node: lathe.id, socket: 'profile' });
      addEdge(g, { node: lathe.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
      addEdge(g, { node: material.id, socket: 'material' }, { node: entity.id, socket: 'material' });
      return { graph: g, rootNodeId: 'entity' };
    },
  },
  evaluate(_ctx, inputs): { path: PathValue } {
    const points = readCurve2DPoints(inputs.points);
    const samplesPerSegment = inputs.samples_per_segment as number;
    const closed = inputs.closed as boolean;
    const samples = sampleCurve2D(points, { samplesPerSegment, closed });
    return {
      path: {
        samples,
        count: samples.length / 3,
        // Width has no meaning for a 2D profile — lathe / extrude
        // never read it. 0 is the inert value (path-mask + carve
        // would also no-op on width-0, which matches the "this is a
        // profile, not a world-space path" intent).
        width: 0,
      },
    };
  },
};
