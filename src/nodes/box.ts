import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { generateBox } from '../render/cube.js';
import { uploadMeshToGpu } from '../render/mesh.js';

// Independent width / height / depth box. Same topology as `core/cube`
// (6 hard-edged faces, per-face normals, 24 verts) but parameterised
// by three half-extents instead of one — saves a cube+transform.scale
// pair in furniture / architecture graphs where almost nothing is
// cubic. The standard tabletop, drawer body, shelf panel, sofa seat
// all want non-uniform dimensions.
export const boxNode: NodeDef = {
  id: 'core/box',
  category: 'Geometry/Primitives',
  inputs: [
    {
      name: 'width',
      type: 'Float',
      default: 1,
      min: 0,
      description: 'extent along X (centred on origin)',
    },
    {
      name: 'height',
      type: 'Float',
      default: 1,
      min: 0,
      description: 'extent along Y (centred on origin)',
    },
    {
      name: 'depth',
      type: 'Float',
      default: 1,
      min: 0,
      description: 'extent along Z (centred on origin)',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'an axis-aligned box mesh centred at the origin, ±width/2 × ±height/2 × ±depth/2. Per-face normals so it shades crisply',
    },
  ],
  doc: {
    summary: 'Axis-aligned rectangular box with independent W/H/D (cube + scale, in one node).',
    description: `
Same topology as [core/cube](../../core/cube) — 6 hard-edged faces,
per-face normals, 24 verts — but with independent half-extents per
axis. Centred at the origin, extending ±width/2 along X, ±height/2
along Y, ±depth/2 along Z.

For furniture / architecture graphs where almost every primitive is
non-uniform (tabletops, drawer bodies, shelf panels, sofa seats),
this replaces the usual cube + [core/transform](../../core/transform)
scale wiring. The cube is still the right choice when you want
uniform scale via a downstream parameter (e.g. random-scaled crates
in a city demo).

The base sits at \`y = -height/2\`, so a downstream
\`transform.translate = [x, height/2, z]\` lands the box on the
\`y = 0\` ground plane at \`(x, z)\`.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'core/box', {
        id: 'box',
        position: { x: 0, y: 0 },
        inputValues: { width: 2, height: 0.1, depth: 1.2 },
      });
      return { graph: g, rootNodeId: 'box' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const mesh = generateBox(
      inputs.width as number,
      inputs.height as number,
      inputs.depth as number,
    );
    return {
      geometry: uploadMeshToGpu(device, mesh, ctx.previousOutput?.geometry as GeometryValue | undefined),
    };
  },
};
