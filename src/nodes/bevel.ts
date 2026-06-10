import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { bevelMesh } from '../render/bevel.js';
import { uploadMeshToGpu } from '../render/mesh.js';

export const bevelNode: NodeDef = {
  id: 'geom/bevel',
  category: 'Geometry/Modifiers',
  inputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description:
        'mesh to bevel. Must carry a CPU-side mesh AND an edge selection mask (typically produced by `geom/select-by-angle` upstream). If `selection.edges` is missing or all-zero, the geometry passes through unchanged.',
    },
    {
      name: 'width',
      type: 'Float',
      default: 0.05,
      min: 0,
      description:
        'inset distance from each affected vertex to its new position, measured along the per-sector angle bisector. Larger widths cut more material off each selected edge; if it grows past half the shortest incident edge length, neighbouring bevels overlap and the output topology gets ugly — there\'s no overlap detection yet.',
    },
    {
      name: 'segments',
      type: 'Int',
      default: 1,
      min: 1,
      description:
        'number of subdivisions across each bevel strip. 1 = chamfer (single flat cut per edge). 2+ will produce a rounded arc cross-section — not yet implemented; values above 1 currently behave the same as 1.',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description:
        'beveled mesh. Vertices have been split along selected edges and new strip / corner-fill faces inserted. The edge-selection mask is DROPPED — the new topology no longer matches the input indexing. Pipe through `geom/compute-normals` afterwards to get clean shading on the new strips.',
    },
  ],
  doc: {
    summary:
      'Replace selected edges with chamfered (or rounded, segments ≥ 2) strips — the canonical "soften the sharp corners" furniture op.',
    description: `
Takes a Geometry carrying an edge-selection mask (e.g. from
\`geom/select-by-angle\`) and replaces every selected edge with a
strip of new faces. Each affected vertex is split into one inset
copy per smoothing sector (separated by selected edges), and a
small corner-cap fills the gap where multiple selected edges meet.

Common pattern:
\`\`\`
  primitive → select-by-angle → bevel → compute-normals → entity
\`\`\`

\`compute-normals\` downstream tidies the per-vertex shading on the
new strips (which we emit with placeholder normals — the algorithm
already knows angle-weighted recomputation gives the cleanest
result and would just duplicate work to do it here).

\`segments = 1\` is chamfer. Higher segment counts (rounded bevels)
are a follow-up — values >1 currently render the same as 1.
\`width\` is the simple "step this far along the bisector" semantic;
"perpendicular distance from edge" is a finer-grained option we
might add if anyone needs it (Blender exposes both).
`,
    sampleGraph: () => {
      // Cube → select-by-angle(30°) → bevel(width=0.1) — the
      // canonical "round the corners of a cube" demo. The result is
      // a chamfered cube where every former 90° corner becomes a
      // tiny triangle and every former edge a thin diagonal strip.
      const g = createGraph();
      const cube = addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 0, y: 0 },
        inputValues: { size: 1 },
      });
      const sel = addNode(g, 'geom/select-by-angle', {
        id: 'select',
        position: { x: 280, y: 0 },
        inputValues: { threshold: 30 },
      });
      const bev = addNode(g, 'geom/bevel', {
        id: 'bevel',
        position: { x: 560, y: 0 },
        inputValues: { width: 0.12, segments: 4 },
      });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: sel.id, socket: 'geometry' });
      addEdge(g, { node: sel.id, socket: 'geometry' }, { node: bev.id, socket: 'geometry' });
      return { graph: g, rootNodeId: 'bevel' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const input = inputs.geometry as GeometryValue;
    if (!input.mesh) {
      throw new Error(
        'geom/bevel requires a CPU-side mesh on the input geometry; '
        + 'this source produced GPU-only data.',
      );
    }
    const width = inputs.width as number;
    const segments = inputs.segments as number;
    const out = bevelMesh(input.mesh, { width, segments });
    return {
      geometry: uploadMeshToGpu(device, out, ctx.previousOutput?.geometry as GeometryValue | undefined),
    };
  },
};
