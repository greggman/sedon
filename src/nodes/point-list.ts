import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue } from '../core/resources.js';

// core/point-list — user-authored point list edited in a 2D top-down
// canvas (XZ plane). The canvas takes an optional Texture2D backdrop
// (heightfield, slope mask, satellite-photo, …) and a world_size
// calibration; the user lays out points on top, the node emits them
// as a PointCloud whose positions are world-space (X, 0, Z) in the
// order the user drew them.
//
// Companion to path-spline / path-carve-heightfield: the canonical
// "lay out a road on terrain" chain is
//   heightfield → point-list (drawn over the heightfield) → path-spline → carve.
//
// Y stays implicit at 0 in the editor; downstream nodes that want
// terrain-following Y use a "snap to heightfield" pass (not yet
// written; tracked separately).

export type Point = [number, number, number];

const DEFAULT_POINTS: Point[] = [
  [-5, 0, 0],
  [5, 0, 0],
];

export function normalisePoints(raw: unknown): Point[] {
  if (!Array.isArray(raw)) return [];
  const out: Point[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 3) continue;
    const x = typeof p[0] === 'number' && Number.isFinite(p[0]) ? p[0] : 0;
    const y = typeof p[1] === 'number' && Number.isFinite(p[1]) ? p[1] : 0;
    const z = typeof p[2] === 'number' && Number.isFinite(p[2]) ? p[2] : 0;
    out.push([x, y, z]);
  }
  return out;
}

export const pointListNode: NodeDef = {
  id: 'core/point-list',
  category: 'Geometry/Distribution',
  inputs: [
    {
      // Authored-only storage of the point list. Hidden socket + custom
      // 'point-list' widget — same pattern as ramp's gradient stops.
      // The placeholder `type` is never used (hideSocket prevents
      // connections); 'Vec3' is the closest single-value cousin.
      name: 'points',
      type: 'Vec3',
      widget: 'point-list',
      hideSocket: true,
      default: DEFAULT_POINTS,
      description:
        'list of world-space points. Click the swatch to open the 2D editor — click empty space to add a point, drag a point to move, right-click to delete',
    },
    {
      name: 'preview_texture',
      type: 'Texture2D',
      optional: true,
      description:
        'optional backdrop drawn under the editor canvas: heightfield, slope mask, satellite photo, anything you want to lay points relative to. The texture\'s aspect is stretched to match `world_size`',
    },
    {
      name: 'world_size',
      type: 'Vec2',
      default: [40, 40],
      description:
        'world XZ extent the editor canvas maps to (metres). Match the terrain renderer\'s worldSize so coords line up with the heightfield',
    },
  ],
  outputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description:
        'authored points as a PointCloud — positions are `(X, 0, Z)` in world space, in the order they were drawn. Order is preserved for downstream consumers that care (path-spline)',
    },
  ],
  doc: {
    summary: 'User-authored point list edited in a 2D top-down canvas with an optional reference-texture backdrop.',
    description: `
The author-side counterpart to procedural point generators
([core/grid-distribute](../../core/grid-distribute),
[core/phyllotaxis-points](../../core/phyllotaxis-points), …). Where
those nodes \`generate\` points from rules, this one stores points
the user drew with the mouse and emits them as a \`PointCloud\` in
draw order.

**Workflow for roads / rivers on terrain**: wire the heightfield (or
a slope mask, or any 2D scalar) into \`preview_texture\`, set
\`world_size\` to match the terrain extent, open the editor, click to
add control points along the route, drag to refine. Pipe the output
into [path/spline](../../path/spline) for a smooth curve, then into
[core/path-carve-heightfield](../../core/path-carve-heightfield) to
cut the route into the terrain.

The Y component stays at 0 from the editor — for "follow the
heightfield" Y, a downstream snap-to-heightfield node is the right
place; baking Y into the authored points would lock you to a specific
heightfield revision.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'core/point-list', {
        id: 'pts',
        position: { x: 0, y: 0 },
      });
      return { graph: g, rootNodeId: 'pts' };
    },
  },
  evaluate(_ctx, inputs): { points: PointCloudValue } {
    const points = normalisePoints(inputs.points);
    const count = points.length;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const p = points[i]!;
      positions[i * 3] = p[0];
      positions[i * 3 + 1] = p[1];
      positions[i * 3 + 2] = p[2];
    }
    return { points: { positions, count } };
  },
};
