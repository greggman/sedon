import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { generateCone } from '../render/cone.js';
import { uploadMeshToGpu } from '../render/mesh.js';

export const coneNode: NodeDef = {
  id: 'core/cone',
  category: 'Geometry/Primitives',
  inputs: [
    {
      name: 'radius',
      type: 'Float',
      default: 0.5,
      description: 'base radius (at y = -height/2)',
    },
    {
      name: 'height',
      type: 'Float',
      default: 1,
      description: 'distance from the base to the tip',
    },
    {
      name: 'segments',
      type: 'Int',
      default: 16,
      min: 2,
      description: 'number of radial subdivisions around the base. Same smoothness vs. cost tradeoff as [core/cylinder](../../core/cylinder)',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'a capped cone mesh with its apex pointing up the +Y axis',
    },
  ],
  doc: {
    summary: 'A capped cone primitive mesh.',
    description: `
Cone with a circular base cap, axis along Y, tip pointing up. The lateral
surface uses slanted normals so the shading reads smooth around the cone
even though the silhouette is faceted to \`segments\`.

Use for tree leaves on conifers (often with a tall, narrow aspect ratio),
spires, instanced caps on top of [core/cylinder](../../core/cylinder)
trunks for low-poly trees, or as a directional marker in debug scenes.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'core/cone', {
        id: 'cone',
        position: { x: 0, y: 0 },
        inputValues: { radius: 0.5, height: 1.5, segments: 24 },
      });
      return { graph: g, rootNodeId: 'cone' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const mesh = generateCone(
      inputs.radius as number,
      inputs.height as number,
      inputs.segments as number,
    );
    return {
      geometry: uploadMeshToGpu(device, mesh, ctx.previousOutput?.geometry as GeometryValue | undefined),
    };
  },
};
