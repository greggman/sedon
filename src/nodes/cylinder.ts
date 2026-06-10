import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { generateCylinder } from '../render/cylinder.js';
import { uploadMeshToGpu } from '../render/mesh.js';

export const cylinderNode: NodeDef = {
  id: 'geom/cylinder',
  category: 'Geometry/Primitives',
  inputs: [
    {
      name: 'radius',
      type: 'Float',
      default: 0.5,
      description: 'world-space radius of the cylinder body',
    },
    {
      name: 'height',
      type: 'Float',
      default: 1,
      description: 'world-space height. The cylinder is centred vertically on the origin',
    },
    {
      name: 'segments',
      type: 'Int',
      default: 16,
      min: 2,
      description: 'number of radial subdivisions around the circumference. 8 reads octagonal, 16 is the smoothness sweet spot, 32+ for close-up renders',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'a capped cylinder mesh centred at the origin with its axis along Y',
    },
  ],
  doc: {
    summary: 'A capped cylinder primitive mesh.',
    description: `
Standard radial cylinder with circular end caps. Axis runs along Y, body
centred on the origin. The cap triangles share vertices with the rim so
the join is smooth; the body uses face-aligned normals so the radial
seams shade as expected (no smearing from averaged normals).

Use for pipes, columns, tree trunks (when paired with a noise-driven
[geom/transform](../../geom/transform) to vary diameter), or as the base
for instanced [geom/grass-blades](../../geom/grass-blades) if you ever want
square-ish blades.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'geom/cylinder', {
        id: 'cylinder',
        position: { x: 0, y: 0 },
        inputValues: { radius: 0.5, height: 1.5, segments: 24 },
      });
      return { graph: g, rootNodeId: 'cylinder' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const mesh = generateCylinder(
      inputs.radius as number,
      inputs.height as number,
      inputs.segments as number,
    );
    return {
      geometry: uploadMeshToGpu(device, mesh, ctx.previousOutput?.geometry as GeometryValue | undefined),
    };
  },
};
