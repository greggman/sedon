import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue, PathValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { generateLathe, type LatheProfilePoint } from '../render/lathe.js';
import { uploadMeshToGpu } from '../render/mesh.js';

function readPathAsProfile(path: PathValue | undefined): LatheProfilePoint[] {
  if (!path || path.count < 2) return [];
  const out: LatheProfilePoint[] = [];
  const s = path.samples;
  for (let i = 0; i < path.count; i++) {
    out.push({ x: s[i * 3]!, y: s[i * 3 + 1]! });
  }
  return out;
}

export const latheNode: NodeDef = {
  id: 'geom/lathe',
  category: 'Geometry/Modifiers',
  inputs: [
    {
      // 2D profile to revolve. Take a `Path` because `path/curve-2d`
      // and `path/spline` both emit Paths and the lathe doesn't care
      // which authoring node produced it. Only X / Y are used —
      // Z gets ignored, since the lathe revolves the profile in the
      // XY plane around the Y axis.
      name: 'profile',
      type: 'Path',
      description:
        'silhouette to revolve around the Y axis. X = radius from axis, Y = height. Z is ignored (the lathe treats the path as a 2D shape). Wire from [path/curve-2d](../../path/curve-2d) for Bezier authoring with per-point handle types',
    },
    {
      name: 'segments',
      type: 'Int',
      default: 24,
      min: 3,
      description:
        'number of radial subdivisions around the revolution. 8 reads octagonal, 16-24 smooth, 32+ for very close-up renders',
    },
    {
      name: 'cap_start',
      type: 'Bool',
      default: true,
      description:
        'close the disc at the first profile point if it sits off-axis. Disable to leave an open mouth — useful for hollow vase shapes',
    },
    {
      name: 'cap_end',
      type: 'Bool',
      default: true,
      description:
        'close the disc at the last profile point if it sits off-axis',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description:
        'the revolved surface as a mesh, oriented along Y with origin at the base',
    },
  ],
  doc: {
    summary: 'Revolve a 2D profile around the Y axis — turned legs, balusters, knobs, vases.',
    description: `
Procedural lathe. Takes a 2D profile (the X / Y components of a
\`Path\`) and revolves it around the Y axis to produce a surface of
revolution. Pair with [path/curve-2d](../../path/curve-2d) for the
profile authoring — that node authors Bezier control points with
per-point handle types (smooth bulges + sharp corners on the same
silhouette), which is exactly what most furniture parts want.

Typical furniture uses:
- **Turned table / chair legs** — wide foot, slim shaft, flared cap.
- **Balusters / spindles** — alternating bulges and necks.
- **Knobs, drawer pulls, finials** — short profiles with a distinctive
  silhouette.
- **Vases, lamp bases** — open profiles with \`cap_start = false\` to
  leave a hollow top.

End caps are added automatically when the profile's terminal point
sits off-axis (radius > 0); they're omitted for points that meet the
axis (radius == 0), because the geometry naturally closes itself
into a pole there. Toggle \`cap_start\` / \`cap_end\` off to make
open-ended profiles (lamps, drinking-glass shapes).
`,
    sampleGraph: () => {
      const g = createGraph();
      const curve = addNode(g, 'path/curve-2d', {
        id: 'curve',
        position: { x: 0, y: 0 },
        inputValues: { samples_per_segment: 16 },
      });
      const lathe = addNode(g, 'geom/lathe', {
        id: 'lathe',
        position: { x: 280, y: 0 },
        inputValues: { segments: 32 },
      });
      addEdge(g, { node: curve.id, socket: 'path' }, { node: lathe.id, socket: 'profile' });
      return { graph: g, rootNodeId: 'lathe' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const profile = readPathAsProfile(inputs.profile as PathValue | undefined);
    const segments = inputs.segments as number;
    const capStart = inputs.cap_start as boolean;
    const capEnd = inputs.cap_end as boolean;
    const mesh = generateLathe(profile, { segments, capStart, capEnd });
    return {
      geometry: uploadMeshToGpu(
        device,
        mesh,
        ctx.previousOutput?.geometry as GeometryValue | undefined,
      ),
    };
  },
};
