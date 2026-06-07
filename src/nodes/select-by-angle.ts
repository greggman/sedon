import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue, MeshSelection } from '../core/resources.js';
import { countSelectedEdges, selectEdgesByAngle } from '../render/select-by-angle.js';

export const selectByAngleNode: NodeDef = {
  id: 'core/select-by-angle',
  category: 'Geometry/Selection',
  inputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description:
        'mesh to select edges on. Must carry a CPU-side mesh (most procedural primitives in sedon do — GPU-compute-generated terrain meshes currently don\'t). Any existing selection is REPLACED in the output; combine with `core/select-combine` if you want to merge selections.',
    },
    {
      name: 'threshold',
      type: 'Float',
      default: 30,
      min: 0,
      max: 180,
      description:
        'dihedral-angle threshold in DEGREES. Edges whose adjacent faces meet at AN ANGLE ≥ this are selected — "the sharp edges." Default 30° catches every cube / cylinder / lathe-cap edge while leaving smooth lathe-body curves alone. Boundary edges (only one face) and non-manifold edges are never selected — no second face to angle against.',
    },
    {
      name: 'weld_by_position',
      type: 'Bool',
      default: true,
      description:
        'when ON (default), coincident-position vertices weld for the topology pass — required for Sedon\'s split-vertex primitives (cube, sphere, cylinder, lathe) so face-to-face edges actually register as shared. Match this to the same flag on `core/compute-normals`. Turn OFF only when you intentionally authored split vertices as hard edges and want them treated as boundaries.',
    },
    {
      name: 'select_below',
      type: 'Bool',
      default: false,
      description:
        'invert the test: select edges whose angle is BELOW the threshold (i.e. coplanar / smooth edges). Useful as a building block for "find the flat regions" workflows. Off by default — the bevel-this-edge case is the much more common one.',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description:
        'the input geometry with its edge selection mask set. Positions / indices / UVs are passed through unchanged — only the `selection.edges` slot is populated. Downstream selection ops (`core/select-invert`, `core/select-combine`) and topology ops (future `core/bevel`, `core/chamfer`) read this mask.',
    },
    {
      name: 'selected_count',
      type: 'Int',
      description:
        'number of EDGES selected (not half-edges — each undirected edge counts once). Lets you verify the selection without a visualization node: a cube should report 12, a tetrahedron 6, an unbevelled cylinder body 0 (its quad strip joins are coplanar).',
    },
  ],
  doc: {
    summary:
      'Select edges where the dihedral angle between adjacent faces meets a threshold — the building block for bevelling / chamfering "the sharp corners."',
    description: `
Walks the mesh's edges and marks each one selected when the angle
between its two adjacent face normals is at-or-above the threshold.
Output is the same Geometry with its \`selection.edges\` slot
populated; downstream consumers (bevel, chamfer, future selection
combinators) read it.

Match \`weld_by_position\` to whatever value you used on
\`core/compute-normals\` upstream so the topology layer sees the same
shared edges.

Common usage:
- Wire after a cube / cylinder / lathe / extrude to pick the natural
  bevel-candidate edges. Threshold 30° is conservative — most furniture
  shapes need it down at 10°-20° if you want to bevel softer joins.
- Wire into \`core/select-combine\` with another selection to layer
  rules ("sharp edges that are also on the top half").
`,
    sampleGraph: () => {
      // A SQUASHED sphere gives the threshold something interesting
      // to do — a uniform sphere or cube produces an "all or nothing"
      // selection (every edge has the same dihedral) and the docs
      // preview can't show the partial result the user is buying into.
      // After scaling Y to 0.5, the curvature at the poles steepens
      // while the equatorial ring edges stay shallow, so a 18°
      // threshold catches the polar bands and leaves the equator
      // un-selected — visible as orange/red rings in the wireframe.
      const g = createGraph();
      const sphere = addNode(g, 'core/sphere', {
        id: 'sphere',
        position: { x: 0, y: 0 },
        inputValues: { radius: 1, segments: 32, rings: 16 },
      });
      const squash = addNode(g, 'core/transform-geometry', {
        id: 'squash',
        position: { x: 280, y: 0 },
        inputValues: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 0.5, 1] },
      });
      const sel = addNode(g, 'core/select-by-angle', {
        id: 'select',
        position: { x: 560, y: 0 },
        inputValues: { threshold: 18 },
      });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: squash.id, socket: 'geometry' });
      addEdge(g, { node: squash.id, socket: 'geometry' }, { node: sel.id, socket: 'geometry' });
      return { graph: g, rootNodeId: 'select' };
    },
  },
  evaluate(_ctx, inputs): { geometry: GeometryValue; selected_count: number } {
    const input = inputs.geometry as GeometryValue;
    if (!input.mesh) {
      throw new Error(
        'core/select-by-angle requires a CPU-side mesh on the input geometry; '
        + 'this source produced GPU-only data.',
      );
    }
    const thresholdDegrees = inputs.threshold as number;
    const thresholdRadians = thresholdDegrees * Math.PI / 180;
    const weldByPosition = (inputs.weld_by_position as boolean | undefined) ?? true;
    const selectBelow = (inputs.select_below as boolean | undefined) ?? false;

    const edges = selectEdgesByAngle(input.mesh, thresholdRadians, {
      weldByPosition,
      selectBelow,
    });
    const selectionCount = countSelectedEdges(edges);

    // Carry the new selection on a fresh mesh object so we don't
    // mutate the upstream's CpuMesh (it may be cached / shared). GPU
    // buffers pass through unchanged — the selection is CPU-only
    // metadata and downstream ops re-read it from the mesh.
    const nextSelection: MeshSelection = { ...(input.mesh.selection ?? {}), edges };
    const nextMesh = { ...input.mesh, selection: nextSelection };
    const nextGeometry: GeometryValue = { ...input, mesh: nextMesh };
    return { geometry: nextGeometry, selected_count: selectionCount };
  },
};
