import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import {
  combineSelectionMasks,
  countEdges,
  countFaces,
  countVertices,
  withSelectionMask,
  type CombineMode,
  type ElementType,
} from '../render/selection-ops.js';

// Element-type enum codes — same values as `core/select-invert`.
const ELEMENT_EDGES    = 0;
const ELEMENT_VERTICES = 1;
const ELEMENT_FACES    = 2;
function elementTypeFromCode(code: number): ElementType {
  if (code === ELEMENT_VERTICES) return 'vertices';
  if (code === ELEMENT_FACES) return 'faces';
  return 'edges';
}

const MODE_AND      = 0;
const MODE_OR       = 1;
const MODE_XOR      = 2;
const MODE_SUBTRACT = 3;
function modeFromCode(code: number): CombineMode {
  if (code === MODE_OR) return 'or';
  if (code === MODE_XOR) return 'xor';
  if (code === MODE_SUBTRACT) return 'subtract';
  return 'and';
}

export const selectCombineNode: NodeDef = {
  id: 'core/select-combine',
  category: 'Geometry/Selection',
  inputs: [
    {
      name: 'geometry_a',
      type: 'Geometry',
      description:
        'first selection input — the "A" side of the combine. Its non-selection mesh data (positions / indices / UVs / GPU buffers) is what flows into the output; the "B" geometry only contributes its selection mask. Wire the side whose mesh you want to keep here.',
    },
    {
      name: 'geometry_b',
      type: 'Geometry',
      description:
        'second selection input — the "B" side of the combine. Only its selection mask of the chosen element type is read; the rest of B is ignored. A and B should describe selections on the SAME mesh topology (same positions / indices) — combining masks across different meshes will produce nonsense.',
    },
    {
      name: 'mode',
      type: 'Int',
      default: MODE_AND,
      enumOptions: [
        { value: MODE_AND,      label: 'AND (intersection)' },
        { value: MODE_OR,       label: 'OR (union)' },
        { value: MODE_XOR,      label: 'XOR (symmetric difference)' },
        { value: MODE_SUBTRACT, label: 'SUBTRACT (A and not B)' },
      ],
      description:
        'how to combine the two selections per element. AND keeps elements selected in both; OR keeps elements selected in either; XOR keeps elements selected in exactly one; SUBTRACT keeps A\'s selection minus anything in B.',
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
        'which selection slot to combine. Only this slot is touched in the output; other slots from A pass through unchanged.',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description:
        'A\'s geometry with its selection slot replaced by the combined mask. Other selection slots from A are preserved verbatim.',
    },
    {
      name: 'selected_count',
      type: 'Int',
      description:
        'count of selected elements in the combined slot.',
    },
  ],
  doc: {
    summary:
      'Combine two selection masks element-wise (AND / OR / XOR / SUBTRACT).',
    description: `
The composition primitive for building compositional selections. The
canonical usage: layer multiple rules to narrow down "the edges I
want to bevel."

Examples:
- "sharp edges that are also on the top half" → select-by-angle AND
  select-by-axis (later, when that node exists).
- "all SMOOTH edges" → select-by-angle(threshold=30) → select-invert.
- "sharp edges except the top rim" → select-by-angle SUBTRACT
  select-by-axis(top).

A's mesh flows through; only A's selection slot is replaced. B is
read for its mask only — wire whichever side has the mesh data you
want downstream as A.
`,
    sampleGraph: () => {
      // Two selections on the SAME squashed sphere: A picks polar
      // bands (angle ≥ 18°), B picks the equator-ish band (angle
      // between 10° and 18° — by combining "below 18°" AND "above
      // 10°" via SUBTRACT later). For the docs preview we use OR
      // to show the UNION: both bands lit, so you can see the
      // combine actually merging two source masks instead of just
      // forwarding one.
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
      const a = addNode(g, 'core/select-by-angle', {
        id: 'select_a',
        position: { x: 560, y: -80 },
        inputValues: { threshold: 18 },
      });
      const b = addNode(g, 'core/select-by-angle', {
        id: 'select_b',
        position: { x: 560, y: 80 },
        inputValues: { threshold: 8, select_below: true },
      });
      const comb = addNode(g, 'core/select-combine', {
        id: 'combine',
        position: { x: 840, y: 0 },
        inputValues: { mode: MODE_OR, element_type: ELEMENT_EDGES },
      });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: squash.id, socket: 'geometry' });
      addEdge(g, { node: squash.id, socket: 'geometry' }, { node: a.id, socket: 'geometry' });
      addEdge(g, { node: squash.id, socket: 'geometry' }, { node: b.id, socket: 'geometry' });
      addEdge(g, { node: a.id, socket: 'geometry' }, { node: comb.id, socket: 'geometry_a' });
      addEdge(g, { node: b.id, socket: 'geometry' }, { node: comb.id, socket: 'geometry_b' });
      return { graph: g, rootNodeId: 'combine' };
    },
  },
  evaluate(_ctx, inputs): { geometry: GeometryValue; selected_count: number } {
    const inputA = inputs.geometry_a as GeometryValue;
    const inputB = inputs.geometry_b as GeometryValue;
    if (!inputA.mesh) {
      throw new Error(
        'core/select-combine requires a CPU-side mesh on geometry_a; '
        + 'this source produced GPU-only data.',
      );
    }
    const type = elementTypeFromCode(inputs.element_type as number);
    const mode = modeFromCode(inputs.mode as number);
    const aMask = inputA.mesh.selection?.[type];
    const bMask = inputB.mesh?.selection?.[type];
    const mask = combineSelectionMasks(inputA.mesh, aMask, bMask, mode, type);
    const nextSelection = withSelectionMask(inputA.mesh, type, mask);
    const nextMesh = { ...inputA.mesh, selection: nextSelection };
    const nextGeometry: GeometryValue = { ...inputA, mesh: nextMesh };
    let count = 0;
    if (type === 'edges')    count = countEdges(mask);
    if (type === 'vertices') count = countVertices(mask);
    if (type === 'faces')    count = countFaces(mask);
    return { geometry: nextGeometry, selected_count: count };
  },
};
