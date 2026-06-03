import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { extrudeMesh } from '../render/extrude.js';
import { uploadMeshToGpu } from '../render/mesh.js';

export const extrudeNode: NodeDef = {
  id: 'core/extrude',
  category: 'Geometry/Modifiers',
  inputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description:
        'mesh to extrude. Must carry a CPU-side mesh AND a face selection mask (typically produced by a future `core/select-by-normal`, or any node that populates `selection.faces`). If the mask is missing or all-zero, the geometry passes through unchanged.',
    },
    {
      name: 'offset',
      type: 'Float',
      default: 0.1,
      description:
        'signed distance to move the selected faces along their cluster\'s average outward normal. Positive = protrude away from the mesh interior (legs from a slab, drawer fronts, raised panels). Negative = recess into the mesh (recessed panels, label insets, key bit channels). Zero is allowed and emits degenerate zero-thickness walls.',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description:
        'extruded mesh. The OFFSET cap is the SELECTED region in the output: `selection.faces` marks the duplicated cap tris (so the next `extrude` chains naturally — extrude × 2 = stairstep), and `selection.edges` marks the rim where the wall meets the cap (so a downstream `bevel` rounds that crease without an explicit `select-by-angle` step). All other selection masks are dropped.',
    },
  ],
  doc: {
    summary:
      'Push selected faces outward (or inward) along their cluster\'s normal, leaving wall quads connecting the offset cap back to the surrounding mesh — the universal "extrude region" op.',
    description: `
Takes a Geometry carrying a face-selection mask (e.g. from a future
\`core/select-by-normal\`) and, for each connected cluster of selected
triangles, duplicates the cluster along its average outward normal
by \`offset\` and welds the duplicate back to the original boundary
with wall quads.

Common pattern:
\`\`\`
  cube → select-by-normal(+Z) → extrude(0.4) → bevel → entity
\`\`\`

For a paneled cabinet door: cube → select-by-normal(+Z) →
inset(0.05) → extrude(-0.01) → select-by-angle(30°) → bevel. Each
modifier consumes the previous step's selection without an
intermediate select.

Cluster handling: adjacent selected tris with a shared edge merge
into one logical face — that shared edge is INTERIOR to the
cluster and never gets a wall (correct for "extrude this cube
face's 2 tris as one face"). Two selected tris with NO shared edge
form two separate clusters and extrude independently.

Normals: the cluster offsets along the AREA-WEIGHTED AVERAGE of
its member tri normals (matches Blender's "Region" extrude). Walls
inherit \`(boundary_edge_dir × cluster_normal)\` per wall, so each
wall face's verts carry that wall's outward normal. The rim where
the wall meets the cap is a SHARP CREASE — same position, two
copies of the vertex with different normals — which the output
\`selection.edges\` marks so a downstream \`bevel\` rounds it on
request.

Negative \`offset\` recesses: same algorithm, the duplicate moves
INWARD, wall winding stays consistent (because the boundary
direction × cluster_normal sign tracks the offset sign).
`,
    sampleGraph: () => {
      // Cube → select-by-normal(+Z) → extrude(0.3) — the canonical
      // "push the top face up to make a peg" demo. The select-by-
      // normal node isn't implemented yet; treat the sample as the
      // intended graph, evaluator may show it as broken until that
      // node lands.
      const g = createGraph();
      const cube = addNode(g, 'core/cube', {
        id: 'cube',
        position: { x: 0, y: 0 },
        inputValues: { size: 1 },
      });
      const sel = addNode(g, 'core/select-by-normal', {
        id: 'select',
        position: { x: 280, y: 0 },
        inputValues: { direction: [0, 1, 0], threshold: 45 },
      });
      const ext = addNode(g, 'core/extrude', {
        id: 'extrude',
        position: { x: 560, y: 0 },
        inputValues: { offset: 0.3 },
      });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: sel.id, socket: 'geometry' });
      addEdge(g, { node: sel.id, socket: 'geometry' }, { node: ext.id, socket: 'geometry' });
      return { graph: g, rootNodeId: 'extrude' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const input = inputs.geometry as GeometryValue;
    if (!input.mesh) {
      throw new Error(
        'core/extrude requires a CPU-side mesh on the input geometry; '
        + 'this source produced GPU-only data.',
      );
    }
    const offset = inputs.offset as number;
    const out = extrudeMesh(input.mesh, { offset });
    return {
      geometry: uploadMeshToGpu(device, out, ctx.previousOutput?.geometry as GeometryValue | undefined),
    };
  },
};
