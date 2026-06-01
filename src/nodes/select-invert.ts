import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import {
  countEdges,
  countFaces,
  countVertices,
  invertSelectionMask,
  withSelectionMask,
  type ElementType,
} from '../render/selection-ops.js';

// Element-type enum codes. Stable integers chosen so adding new
// element types later doesn't shift existing values.
const ELEMENT_EDGES    = 0;
const ELEMENT_VERTICES = 1;
const ELEMENT_FACES    = 2;

function elementTypeFromCode(code: number): ElementType {
  if (code === ELEMENT_VERTICES) return 'vertices';
  if (code === ELEMENT_FACES) return 'faces';
  return 'edges';
}

export const selectInvertNode: NodeDef = {
  id: 'core/select-invert',
  category: 'Geometry/Selection',
  inputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description:
        'mesh whose selection should be inverted. If no selection of the chosen element type exists on the input, the output is FULLY selected (every element marked) — "the inverse of nothing" is "everything."',
    },
    {
      name: 'element_type',
      type: 'Int',
      default: ELEMENT_EDGES,
      enumOptions: [
        { value: ELEMENT_EDGES,    label: 'Edges' },
        { value: ELEMENT_VERTICES, label: 'Vertices' },
        { value: ELEMENT_FACES,    label: 'Faces' },
      ],
      description:
        'which selection slot to invert. Only this slot changes; the other two are passed through unchanged.',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description:
        'the input geometry with the chosen selection slot inverted.',
    },
    {
      name: 'selected_count',
      type: 'Int',
      description:
        'count of selected elements AFTER inversion. For edges, this is logical edges (twin pairs collapsed); for vertices / faces, the raw count.',
    },
  ],
  doc: {
    summary:
      'Flip a selection mask: previously-selected elements become unselected and vice versa.',
    description: `
Pairs with \`core/select-by-angle\` and \`core/select-combine\` as the
primitive set for building compositional selections. Common pattern:
"select the SHARP edges" → invert → "select the SMOOTH edges" so a
downstream op (smoothing, UV unwrap by patch) sees the complement.

An empty selection inverts to a full one — useful for "select all"
without a separate node. Just wire a geometry that has no selection,
pick the element type, and invert.
`,
    sampleGraph: () => {
      // Same squashed-sphere setup as core/select-by-angle's sample so
      // the user can see the SAME polar bands flip — before invert,
      // the polar rings are highlighted; after invert, the equatorial
      // belt is. Side-by-side comparison in the docs sells the
      // operation.
      const g = createGraph();
      const sphere = addNode(g, 'core/sphere', {
        id: 'sphere',
        position: { x: 0, y: 0 },
        inputValues: { radius: 1, segments: 32, rings: 16 },
      });
      const squash = addNode(g, 'core/transform', {
        id: 'squash',
        position: { x: 280, y: 0 },
        inputValues: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 0.5, 1] },
      });
      const sel = addNode(g, 'core/select-by-angle', {
        id: 'select',
        position: { x: 560, y: 0 },
        inputValues: { threshold: 18 },
      });
      const inv = addNode(g, 'core/select-invert', {
        id: 'invert',
        position: { x: 840, y: 0 },
        inputValues: { element_type: ELEMENT_EDGES },
      });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: squash.id, socket: 'geometry' });
      addEdge(g, { node: squash.id, socket: 'geometry' }, { node: sel.id, socket: 'geometry' });
      addEdge(g, { node: sel.id, socket: 'geometry' }, { node: inv.id, socket: 'geometry' });
      return { graph: g, rootNodeId: 'invert' };
    },
  },
  evaluate(_ctx, inputs): { geometry: GeometryValue; selected_count: number } {
    const input = inputs.geometry as GeometryValue;
    if (!input.mesh) {
      throw new Error(
        'core/select-invert requires a CPU-side mesh on the input geometry; '
        + 'this source produced GPU-only data.',
      );
    }
    const type = elementTypeFromCode(inputs.element_type as number);
    const mask = invertSelectionMask(input.mesh, type);
    const nextSelection = withSelectionMask(input.mesh, type, mask);
    const nextMesh = { ...input.mesh, selection: nextSelection };
    const nextGeometry: GeometryValue = { ...input, mesh: nextMesh };
    let count = 0;
    if (type === 'edges')    count = countEdges(mask);
    if (type === 'vertices') count = countVertices(mask);
    if (type === 'faces')    count = countFaces(mask);
    return { geometry: nextGeometry, selected_count: count };
  },
};
