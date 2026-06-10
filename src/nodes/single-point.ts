import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue } from '../core/resources.js';

// One-point PointCloud at a user-provided position. Useful when you need
// `scene/instance-on-points` to drop a single scene at a specific
// world-space location — e.g. placing each species at its own offset in a
// "tree family" demo where there's no Scene-level transform node yet.
export const singlePointNode: NodeDef = {
  id: 'points/single',
  category: 'Geometry/Distribution',
  inputs: [
    {
      name: 'position',
      type: 'Vec3',
      default: [0, 0, 0],
      description: 'world-space position of the single point',
    },
    {
      name: 'normal',
      type: 'Vec3',
      default: [0, 1, 0],
      description: 'surface normal at the point (drives align-to-normal in downstream scatter)',
    },
  ],
  outputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: 'a 1-point cloud carrying position + normal. Feed into [geom/instance-on-points](../../geom/instance-on-points) or [scene/instance-on-points](../../scene/instance-on-points) to drop a single object at the position',
    },
  ],
  doc: {
    summary: 'A 1-point PointCloud at a user-provided world-space position.',
    description: `
The trivial distributor. Useful when you need
[scene/instance-on-points](../../scene/instance-on-points) to
drop a single scene at a specific world-space location — e.g. placing
each species at its own offset in a "tree family" demo where there's
no Scene-level transform node yet, or hand-placing one boulder in a
forest demo.

For multiple specific positions, use multiple single-point nodes and
merge them upstream of the instancer, or reach for a real distributor
like [points/grid](../../points/grid),
[points/radial](../../points/radial),
[points/phyllotaxis](../../points/phyllotaxis), or
[points/on-faces](../../points/on-faces).
`,
    sampleGraph: () => {
      const g = createGraph();
      // One point → one cube via the instancer. Wireframe preview
      // shows the cube exactly where the point lives.
      const point = addNode(g, 'points/single', {
        id: 'point',
        position: { x: 0, y: 0 },
        inputValues: { position: [0, 0, 0], normal: [0, 1, 0] },
      });
      const cube = addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 0, y: 200 },
        inputValues: { size: 1 },
      });
      const inst = addNode(g, 'geom/instance-on-points', {
        id: 'inst',
        position: { x: 280, y: 100 },
        inputValues: { scale: 0.5, align: true },
      });
      addEdge(g, { node: point.id, socket: 'points' }, { node: inst.id, socket: 'points' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: inst.id, socket: 'instance' });
      return { graph: g, rootNodeId: 'inst' };
    },
  },
  evaluate(_ctx, inputs): { points: PointCloudValue } {
    const pos = inputs.position as [number, number, number];
    const norm = inputs.normal as [number, number, number];
    return {
      points: {
        positions: new Float32Array([pos[0], pos[1], pos[2]]),
        normals: new Float32Array([norm[0], norm[1], norm[2]]),
        count: 1,
      },
    };
  },
};
