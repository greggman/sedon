import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { insetMesh } from '../render/inset.js';
import { uploadMeshToGpu } from '../render/mesh.js';

export const insetNode: NodeDef = {
  id: 'core/inset',
  category: 'Geometry/Modifiers',
  inputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description:
        'mesh to inset. Must carry a CPU-side mesh AND a face selection mask (typically produced by `core/select-by-normal`). If the mask is missing or all-zero, the geometry passes through unchanged.',
    },
    {
      name: 'width',
      type: 'Float',
      default: 0.1,
      min: 0,
      description:
        'inset distance into the selected cluster, measured along each boundary corner\'s angle bisector. For a 90° corner (the common cube case) this equals the perpendicular distance from each adjacent boundary edge. Larger widths shrink the inner face further; values past half the shortest boundary segment will produce self-intersecting geometry — no overlap detection.',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description:
        'inset mesh. The INNER face is the SELECTED region in the output: `selection.faces` marks the shrunk inner cluster tris (so the natural chain is `inset → extrude` for "recess this region"), and `selection.edges` marks the rim where the inner face meets the frame ring. Other selection masks are dropped.',
    },
  ],
  doc: {
    summary:
      'Shrink a selected face cluster inward, leaving a frame ring of new quads between the original boundary and the shrunk inner face — the canonical "frame and panel" op.',
    description: `
Takes a Geometry carrying a face-selection mask and, for each
connected cluster, walks the cluster's boundary and emits:

  • A FRAME RING of quads (one per boundary corner segment) between
    the original boundary corners and their inset positions.
  • An INNER FACE: the original cluster triangulation with each
    boundary vertex remapped to its inset position.

The chain pattern is \`select-by-normal → inset → extrude\`:
shrink the face, then push the inner face in (recess) or out
(raise). Paneled cabinet doors, raised panels, recessed trays,
sunken drawer handles — they're all this composition.

Inset position: at each boundary corner V with previous + next
corners P and N (CCW around the cluster from outside), the inset
sits at \`V + width · (unit(V→P) + unit(V→N))\`. For a 90° corner
this is the perpendicular distance \`width\` from each adjacent
boundary edge — the intuitive "inset by W". At non-90° corners
it's a smooth approximation.

Cluster handling: adjacent selected tris with a shared edge merge
into one logical face (same union-find as bevel/extrude). The
shared edge is interior to the cluster and gets no frame quad.

Limitations of this MVP:
- Interior vertices of a richer cluster (e.g. selected 3×3 grid
  with a middle vertex) stay at their original position instead of
  shrinking proportionally. The inset face's topology is correct
  but the shape is distorted near the interior. Cube faces have no
  interior verts and aren't affected.
- No self-intersection detection if \`width\` exceeds half the
  shortest boundary segment — the inset geometry can fold over.
`,
    sampleGraph: () => {
      // Cube → select-by-normal(+Z) → inset(0.1) → extrude(-0.05):
      // the canonical "recessed panel on a slab" demo. After this
      // pipeline you'd typically chain `select-by-angle → bevel`
      // to round the resulting inside corner.
      const g = createGraph();
      const cube = addNode(g, 'core/cube', {
        id: 'cube',
        position: { x: 0, y: 0 },
        inputValues: { size: 1 },
      });
      const sel = addNode(g, 'core/select-by-normal', {
        id: 'select',
        position: { x: 280, y: 0 },
        inputValues: { direction: [0, 0, 1], threshold: 30 },
      });
      const ins = addNode(g, 'core/inset', {
        id: 'inset',
        position: { x: 560, y: 0 },
        inputValues: { width: 0.1 },
      });
      const ext = addNode(g, 'core/extrude', {
        id: 'extrude',
        position: { x: 840, y: 0 },
        inputValues: { offset: -0.05 },
      });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: sel.id, socket: 'geometry' });
      addEdge(g, { node: sel.id, socket: 'geometry' }, { node: ins.id, socket: 'geometry' });
      addEdge(g, { node: ins.id, socket: 'geometry' }, { node: ext.id, socket: 'geometry' });
      return { graph: g, rootNodeId: 'extrude' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const input = inputs.geometry as GeometryValue;
    if (!input.mesh) {
      throw new Error(
        'core/inset requires a CPU-side mesh on the input geometry; '
        + 'this source produced GPU-only data.',
      );
    }
    const width = inputs.width as number;
    const out = insetMesh(input.mesh, { width });
    return {
      geometry: uploadMeshToGpu(device, out, ctx.previousOutput?.geometry as GeometryValue | undefined),
    };
  },
};
