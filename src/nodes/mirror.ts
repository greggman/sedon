import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { mirrorMesh, type MirrorAxis } from '../render/mirror-mesh.js';
import { uploadMeshToGpu } from '../render/mesh.js';

// Axis selector is a tiny enum exposed as an Int input with
// enumOptions — keeps the inspector widget a dropdown rather than
// a free-form number. 0/1/2 map to X/Y/Z respectively.
const AXIS_ENUM = [
  { label: 'X (YZ plane)', value: 0 },
  { label: 'Y (XZ plane)', value: 1 },
  { label: 'Z (XY plane)', value: 2 },
];

export const mirrorNode: NodeDef = {
  id: 'core/mirror',
  category: 'Geometry/Modifiers',
  inputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description:
        'input mesh to reflect. Must carry CPU-side vertex data (primitive nodes always do)',
    },
    {
      name: 'axis',
      type: 'Int',
      default: 0,
      enumOptions: AXIS_ENUM,
      description:
        'which world axis the reflection plane is perpendicular to. X = mirror left↔right across the YZ plane, Y = top↔bottom across XZ, Z = front↔back across XY',
    },
    {
      name: 'offset',
      type: 'Float',
      default: 0,
      description:
        'distance from the origin along `axis` to the reflection plane. 0 = mirror across the world origin; positive shifts the plane along the positive axis',
    },
    {
      name: 'weld',
      type: 'Bool',
      default: true,
      description:
        'when on, the output is the input + its mirror merged into one mesh (the typical chair-half / chair-whole workflow). When off, only the mirrored copy is returned',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description:
        'reflected mesh (welded with the input when `weld` is on)',
    },
  ],
  doc: {
    summary: 'Reflect a mesh across an axis-aligned plane — model one half, mirror to whole.',
    description: `
Mirror a mesh across one of the world planes. The classic furniture
workflow: model the LEFT half of a chair (legs, armrest, seat curve),
mirror across the YZ plane, get a symmetric whole. Same trick works
for any axis-symmetric object — keep the source half as the single
source of truth, let the mirror keep both sides identical as you edit.

\`weld\` controls whether the original is included in the output. On
(default) outputs original + reflection joined as one Geometry. Off
outputs just the reflected copy, which is useful when the original
flows down a different chain in the graph and you only want the
mirrored part to scatter / instance separately.

Triangle winding is reversed for the reflected half so back-face
culling continues to keep the OUTSIDE of the mesh visible. Normals
flip along the mirrored axis so lighting reads correctly on the
mirrored surface.
`,
    sampleGraph: () => {
      const g = createGraph();
      // A cube offset along +X so the mirror across the YZ plane
      // produces a visibly-separated pair, not a coincident shape.
      const cube = addNode(g, 'core/cube', {
        id: 'cube',
        position: { x: 0, y: 0 },
        inputValues: { size: 1 },
      });
      const offset = addNode(g, 'core/transform-geometry', {
        id: 'offset',
        position: { x: 280, y: 0 },
        inputValues: { translate: [1.5, 0, 0] },
      });
      const mirror = addNode(g, 'core/mirror', {
        id: 'mirror',
        position: { x: 560, y: 0 },
        inputValues: { axis: 0, offset: 0, weld: true },
      });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: offset.id, socket: 'geometry' });
      addEdge(g, { node: offset.id, socket: 'geometry' }, { node: mirror.id, socket: 'geometry' });
      return { graph: g, rootNodeId: 'mirror' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const input = inputs.geometry as GeometryValue;
    if (!input.mesh) {
      throw new Error(
        'core/mirror requires a CPU-side mesh on the input geometry; ' +
          'this source produced GPU-only data.',
      );
    }
    const axisIdx = inputs.axis as number;
    const axis: MirrorAxis = axisIdx === 2 ? 'Z' : axisIdx === 1 ? 'Y' : 'X';
    const mesh = mirrorMesh(input.mesh, {
      axis,
      offset: inputs.offset as number,
      weld: inputs.weld as boolean,
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
