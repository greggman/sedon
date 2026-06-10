import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { uploadMeshToGpu } from '../render/mesh.js';
import { generatePlane } from '../render/plane.js';

export const planeNode: NodeDef = {
  id: 'geom/plane',
  category: 'Geometry/Primitives',
  inputs: [
    {
      name: 'size',
      type: 'Vec2',
      default: [4, 4],
      description: 'world-space width and depth (X and Z). The plane is centred on the origin and lies on the Y = 0 plane',
    },
    {
      name: 'divisions',
      type: 'Vec2i',
      default: [4, 4],
      description: 'number of grid cells along each axis. 1×1 is a single quad; bump up only if you need extra vertices for displacement or vertex-coloured shading',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'a flat plane mesh lying on Y = 0, normal pointing up (+Y)',
    },
  ],
  doc: {
    summary: 'A flat plane primitive mesh, optionally subdivided.',
    description: `
A horizontal rectangle on the XZ plane, centred at the origin. The
divisions count picks how many subdivision quads it gets; for a basic
ground plane 1×1 is fine, but if you intend to vertex-displace it (per-
vertex noise, an attached heightfield) crank up the divisions so there's
geometry to push around.

Use as a ground plane, as a billboard for textured masks, or as the
target of a [points/on-faces](../../points/on-faces)
that needs a regular sampling surface.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'geom/plane', {
        id: 'plane',
        position: { x: 0, y: 0 },
        inputValues: { size: [4, 4], divisions: [4, 4] },
      });
      return { graph: g, rootNodeId: 'plane' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const size = inputs.size as [number, number];
    const divisions = inputs.divisions as [number, number];
    const mesh = generatePlane(
      size[0],
      size[1],
      Math.max(1, Math.round(divisions[0])),
      Math.max(1, Math.round(divisions[1])),
    );
    return {
      geometry: uploadMeshToGpu(device, mesh, ctx.previousOutput?.geometry as GeometryValue | undefined),
    };
  },
};
