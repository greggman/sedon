import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { computeNormalsWithCuspAngle } from '../render/compute-normals.js';
import { uploadMeshToGpu } from '../render/mesh.js';

export const computeNormalsNode: NodeDef = {
  id: 'geom/compute-normals',
  category: 'Geometry/Modifiers',
  inputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'mesh to re-shade. Must carry a CPU-side copy (most procedural primitives in sedon do — GPU-compute-generated terrain meshes currently don\'t).',
    },
    {
      name: 'cusp_angle',
      type: 'Float',
      default: 30,
      min: 0,
      max: 180,
      description:
        'angle threshold in DEGREES. Edges whose dihedral angle is BELOW this are smoothed (a single vertex normal shared by both faces); edges at-or-above are creased (the vertex is duplicated so each face gets its own normal). 0 = every shared edge is a hard kink (faceted shading), 180 = every shared edge is smooth (continuous normals across the whole surface). 30° is the conventional default — matches Blender Auto Smooth and is right for "smooth curves, sharp corners" on bevelled / lathed / extruded furniture parts.',
    },
    {
      name: 'weld_by_position',
      type: 'Bool',
      default: true,
      description:
        'when ON (default), vertices at coincident positions are treated as a single topological vertex during the smoothing pass. Sedon\'s procedural primitives (cube, sphere, cylinder, lathe) emit per-face SPLIT vertices so each face can carry its own UVs — without welding, the half-edge layer would see every face as an island and refuse to smooth across any edge. Output keeps the original vertex count + UVs intact; only the smoothed normal is shared. Turn OFF for the rare case where you intentionally authored split vertices as hard edges and don\'t want them merged.',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description:
        'mesh with recomputed per-vertex normals. Topology is preserved; vertices are split only at edges that cross the cusp threshold. UV / position data is copied verbatim onto any duplicated vertices.',
    },
  ],
  doc: {
    summary: 'Recompute vertex normals with a dihedral-angle cusp threshold (smooth below, crease above).',
    description: `
The auto-smooth / smooth-by-angle operation every DCC ships. Reads the
input mesh's topology, builds a half-edge connectivity layer, and for
each shared edge decides:

- **Dihedral angle < cusp** → SMOOTH: both faces contribute to a shared
  vertex normal at each endpoint. The vertex isn't duplicated.
- **Dihedral angle ≥ cusp** → CREASE: each face gets its own normal at
  the shared vertex. The vertex is duplicated in the output so the
  shader sees a discontinuity (the visible "edge").

Used after operations that produce hard geometric edges you want
shaded as such — bevels around cube corners, the join between a
lathed body and its end cap, the seam where a swept profile meets a
mitre. Lower angles give a more faceted result; higher angles give a
more continuous one. 30° is the universal sweet spot for furniture
and architectural shapes.

Weighting: each face's contribution to a shared vertex normal is
weighted by its INTERIOR ANGLE at that vertex (Max / Blender Auto
Smooth convention). This produces symmetric results on uniform
primitives even when their triangulation isn't symmetric — a cube
corner gets (1,1,1)/√3 regardless of which diagonal each quad face
chose to split along.

Edge cases:
- Boundary edges (only one face) act as creases — no smoothing.
- Non-manifold edges (3+ faces or inconsistent winding) also crease.
- Degenerate faces (any pair of coincident corners) contribute zero
  weight and end up with a fallback +Y normal in their own group.
`,
    sampleGraph: () => {
      const g = createGraph();
      const cube = addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 0, y: 0 },
        inputValues: { size: 1 },
      });
      const normals = addNode(g, 'geom/compute-normals', {
        id: 'normals',
        position: { x: 280, y: 0 },
        inputValues: { cusp_angle: 30 },
      });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: normals.id, socket: 'geometry' });
      return { graph: g, rootNodeId: 'normals' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const input = inputs.geometry as GeometryValue;
    if (!input.mesh) {
      throw new Error(
        'geom/compute-normals requires a CPU-side mesh on the input geometry; '
        + 'this source produced GPU-only data.',
      );
    }
    const cuspDegrees = inputs.cusp_angle as number;
    const cuspRadians = cuspDegrees * Math.PI / 180;
    const weldByPosition = (inputs.weld_by_position as boolean | undefined) ?? true;
    const out = computeNormalsWithCuspAngle(input.mesh, cuspRadians, { weldByPosition });
    return {
      geometry: uploadMeshToGpu(device, out, ctx.previousOutput?.geometry as GeometryValue | undefined),
    };
  },
};
