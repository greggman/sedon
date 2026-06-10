import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue, MeshSelection } from '../core/resources.js';
import { countSelectedFaces, selectFacesByNormal } from '../render/select-by-normal.js';

export const selectByNormalNode: NodeDef = {
  id: 'geom/select-by-normal',
  category: 'Geometry/Selection',
  inputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description:
        'mesh to select faces on. Must carry a CPU-side mesh. Any existing `selection.faces` mask is REPLACED in the output; use `geom/select-combine` to merge. Other selection slots (edges, vertices) pass through.',
    },
    {
      name: 'direction',
      type: 'Vec3',
      default: [0, 1, 0],
      description:
        'target normal direction. Need not be unit length — it\'s normalised internally. Common values: `[0, 1, 0]` for "up-facing" (tabletops, drawer tops), `[0, -1, 0]` for "down-facing" (drawer bottoms, leg undersides), `[1, 0, 0]` for "right-facing" (drawer front of a +X cabinet), and so on.',
    },
    {
      name: 'threshold',
      type: 'Float',
      default: 45,
      min: 0,
      max: 180,
      description:
        'max angle in DEGREES between each face\'s normal and `direction`. A face is selected when its normal sits within this cone around the target. 45° picks "the top half" on a sphere; 10° picks only nearly-flat tops; 90° picks everything on the target\'s side of the mesh.',
    },
    {
      name: 'select_below',
      type: 'Bool',
      default: false,
      description:
        'invert: select faces whose normal is OUTSIDE the threshold cone instead. Useful for "everything except the top" or as a building block for "find the sides."',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description:
        'the input geometry with its FACE selection mask set on `selection.faces`. Positions / indices / UVs / other selection masks pass through unchanged. Downstream face-consuming ops (`geom/extrude`, future `geom/inset`) read this mask.',
    },
    {
      name: 'selected_count',
      type: 'Int',
      description:
        'number of triangles selected. Lets you sanity-check the selection without a viewer: a cube with `direction=[0,1,0]` and `threshold=30°` reports 2 (the +Y face\'s 2 tris), `threshold=90°` reports 6 (the upper half of the cube — +Y plus four side faces all within 90° of up).',
    },
  ],
  doc: {
    summary:
      'Select faces whose normals point in a given direction (within an angular threshold) — the building block for "do something to the top / bottom / front / etc."',
    description: `
For each triangle, computes the face normal from its winding and
marks it selected when the angle between that normal and
\`direction\` is at-or-below \`threshold\`. Output is the same
Geometry with its \`selection.faces\` slot populated.

Common patterns:
\`\`\`
  cube → select-by-normal([0,1,0], 45°) → extrude(0.3)
\`\`\`
"Extrude the top face up by 0.3" — classic furniture move (leg
from a slab, raised drawer pull from a face).

\`\`\`
  cube → select-by-normal([0,1,0], 45°) → inset(0.05) → extrude(-0.01)
\`\`\`
The paneled cabinet door: shrink the top face inward, recess the
inner ring back into the door.

The threshold is in DEGREES so it composes naturally with intuition
about angles. Internally it's converted to a cosine comparison so
no per-face \`acos\` is needed.

Edge cases:
- Degenerate triangles (collinear vertices) have no normal and are
  never selected.
- Zero-length \`direction\` matches nothing — empty selection.
- Existing \`selection.edges\` / \`selection.vertices\` masks pass
  through; this node only writes the FACES slot.
`,
    sampleGraph: () => {
      // Squashed sphere → select-by-normal +Y, threshold 30° → the
      // top cap faces. Then extrude to push them up further.
      const g = createGraph();
      const sphere = addNode(g, 'geom/sphere', {
        id: 'sphere',
        position: { x: 0, y: 0 },
        inputValues: { radius: 1, slices: 32, stacks: 16 },
      });
      const squash = addNode(g, 'geom/transform', {
        id: 'squash',
        position: { x: 280, y: 0 },
        inputValues: { scale: [1, 0.5, 1] },
      });
      const sel = addNode(g, 'geom/select-by-normal', {
        id: 'select',
        position: { x: 560, y: 0 },
        inputValues: { direction: [0, 1, 0], threshold: 30 },
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
        'geom/select-by-normal requires a CPU-side mesh on the input geometry; '
        + 'this source produced GPU-only data.',
      );
    }
    const direction = inputs.direction as [number, number, number];
    const thresholdDegrees = inputs.threshold as number;
    const thresholdRadians = thresholdDegrees * Math.PI / 180;
    const selectBelow = (inputs.select_below as boolean | undefined) ?? false;

    const faces = selectFacesByNormal(input.mesh, {
      direction,
      thresholdRadians,
      selectBelow,
    });
    const selectionCount = countSelectedFaces(faces);

    // Same convention as select-by-angle: fresh mesh + selection
    // objects so we never mutate the cached upstream value.
    const nextSelection: MeshSelection = { ...(input.mesh.selection ?? {}), faces };
    const nextMesh = { ...input.mesh, selection: nextSelection };
    const nextGeometry: GeometryValue = { ...input, mesh: nextMesh };
    return { geometry: nextGeometry, selected_count: selectionCount };
  },
};
