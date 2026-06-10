import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue, PathValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import {
  generateExtrudeOnPath,
  type ExtrudeProfilePoint,
} from '../render/extrude-on-path.js';
import { uploadMeshToGpu } from '../render/mesh.js';

function readPathAsSection(path: PathValue | undefined): ExtrudeProfilePoint[] {
  if (!path || path.count < 2) return [];
  const out: ExtrudeProfilePoint[] = [];
  const s = path.samples;
  for (let i = 0; i < path.count; i++) {
    out.push({ x: s[i * 3]!, y: s[i * 3 + 1]! });
  }
  return out;
}

export const extrudeOnPathNode: NodeDef = {
  id: 'geom/extrude-on-path',
  category: 'Geometry/Modifiers',
  inputs: [
    {
      name: 'path',
      type: 'Path',
      description:
        'world-space polyline to sweep along. Pair with [path/spline](../../path/spline) for a smooth curved rail',
    },
    {
      name: 'section',
      type: 'Path',
      description:
        '2D cross-section as a Path — X / Y in the plane perpendicular to the rail (Z is ignored). Wire from [path/curve-2d](../../path/curve-2d) with `closed = true` for a sealed cross-section (moulding, cable, drawer pull)',
    },
    {
      name: 'closed_section',
      type: 'Bool',
      default: true,
      description:
        'when on, the last cross-section vertex wraps back to the first (a closed tube — moulding / baseboard / cable). When off, the sweep is an open ribbon (a belt, a strap)',
    },
    {
      name: 'cap_start',
      type: 'Bool',
      default: true,
      description:
        'close the cross-section at the path start (only meaningful when `closed_section` is on)',
    },
    {
      name: 'cap_end',
      type: 'Bool',
      default: true,
      description:
        'close the cross-section at the path end (only meaningful when `closed_section` is on)',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description:
        'swept tube — cross-section translated along the path with the cross-section\'s plane held perpendicular to the local tangent',
    },
  ],
  doc: {
    summary: 'Sweep a 2D cross-section along a 3D path — mouldings, baseboards, cables, trim.',
    description: `
Take a 2D cross-section (a small closed polygon — quarter-round
moulding, baseboard L-profile, oval cable cross-section) and sweep
it along a 3D path. Each path sample becomes a "ring" of the swept
tube; adjacent rings are stitched into quads. The cross-section's
plane stays perpendicular to the local path tangent, so the sweep
follows curves cleanly.

Both inputs are \`Path\`-typed for compositional uniformity. The
**rail** typically comes from [path/spline](../../path/spline) (a
smoothed 3D curve through control points). The **cross-section**
typically comes from [path/curve-2d](../../path/curve-2d) (a 2D
Bezier with per-point handle types) — its X / Y components are
used; Z is ignored.

Typical furniture uses:
- **Baseboard / crown moulding** — author the moulding's profile
  once, feed a path that traces the room perimeter, get continuous
  trim around corners.
- **Drawer pulls / handles** — small section swept along a short
  bent path makes a metal pull with no per-corner modelling.
- **Cables, rope, pipes** — circular or oval section + the path the
  cable should follow.
- **Belts, straps** — set \`closed_section\` off for a single-sided
  ribbon.

End caps fan-triangulate from the section centroid; the cap is
visually correct for any **convex** cross-section. For non-convex
shapes (a "C" channel) disable caps and emit them separately.
`,
    sampleGraph: () => {
      const g = createGraph();
      const pts = addNode(g, 'points/list', {
        id: 'pts',
        position: { x: 0, y: 0 },
        inputValues: {
          points: [
            [-1, 0, -0.5],
            [ 1, 0, -0.5],
            [ 1, 0,  0.5],
            [-1, 0,  0.5],
            [-1, 0, -0.5],
          ],
          world_size: [4, 4],
        },
      });
      const spline = addNode(g, 'path/spline', {
        id: 'spline',
        position: { x: 280, y: 0 },
        inputValues: { samples_per_segment: 8 },
      });
      // Closed square cross-section authored as a curve-2d. Tuple
      // order is `[x, handleType, y]` — handle type in index 1
      // (matches the editor's "y elevation is index 1, screen-vert
      // is index 2" convention). 1 = corner so the square has hard
      // 90° edges instead of a rounded chamfer.
      const section = addNode(g, 'path/curve-2d', {
        id: 'section',
        position: { x: 0, y: 220 },
        inputValues: {
          points: [
            [-0.01, 1, 0],
            [ 0.01, 1, 0],
            [ 0.01, 1, 0.02],
            [-0.01, 1, 0.02],
          ],
          samples_per_segment: 1,
          closed: true,
        },
      });
      const ext = addNode(g, 'geom/extrude-on-path', {
        id: 'extrude',
        position: { x: 560, y: 0 },
        inputValues: {
          closed_section: true,
          cap_start: true,
          cap_end: true,
        },
      });
      const mat = addNode(g, 'material/pbr', {
        id: 'material',
        position: { x: 280, y: 440 },
        inputValues: { basecolor: [0.6, 0.45, 0.3, 1], roughness: 0.6, metallic: 0 },
      });
      const entity = addNode(g, 'scene/entity', {
        id: 'entity',
        position: { x: 840, y: 100 },
      });
      addEdge(g, { node: pts.id, socket: 'points' }, { node: spline.id, socket: 'points' });
      addEdge(g, { node: spline.id, socket: 'path' }, { node: ext.id, socket: 'path' });
      addEdge(g, { node: section.id, socket: 'path' }, { node: ext.id, socket: 'section' });
      addEdge(g, { node: ext.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
      addEdge(g, { node: mat.id, socket: 'material' }, { node: entity.id, socket: 'material' });
      return { graph: g, rootNodeId: 'entity' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const path = inputs.path as PathValue | undefined;
    const section = readPathAsSection(inputs.section as PathValue | undefined);
    if (!path || path.count < 2 || section.length < 2) {
      const mesh = generateExtrudeOnPath(new Float32Array(0), 0, [], {});
      return {
        geometry: uploadMeshToGpu(
          device,
          mesh,
          ctx.previousOutput?.geometry as GeometryValue | undefined,
        ),
      };
    }
    const mesh = generateExtrudeOnPath(path.samples, path.count, section, {
      closedSection: inputs.closed_section as boolean,
      capStart: inputs.cap_start as boolean,
      capEnd: inputs.cap_end as boolean,
    });
    return {
      geometry: uploadMeshToGpu(
        device,
        mesh,
        ctx.previousOutput?.geometry as GeometryValue | undefined,
      ),
    };
  },
};
