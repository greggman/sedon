import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue, PointCloudValue } from '../core/resources.js';
import { distributeOnFaces } from '../render/mesh.js';

export const distributeOnFacesNode: NodeDef = {
  id: 'points/on-faces',
  category: 'Geometry/Distribution',
  inputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'source mesh to scatter points across. Must carry CPU-side mesh data (primitives do; [geom/heightfield-from-texture](../../geom/heightfield-from-texture) needs `cpu_access: true`)',
    },
    {
      name: 'density',
      type: 'Float',
      default: 10,
      description: 'points per unit area. 10 on a 4×4 plane = ~160 points; bump up for closer scatter, down for sparse',
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0,
      description: 'PRNG seed; same seed reproduces the same point set',
    },
  ],
  outputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: 'points scattered across the mesh\'s surface, with normals matching the per-face normal at each sample location',
    },
  ],
  doc: {
    summary: 'Scatter points uniformly across a mesh\'s surface, with per-face normals.',
    description: `
Samples points proportional to per-triangle area (so big triangles get
more points than small ones, keeping the distribution visually uniform
across the surface). Each point's normal matches the face it landed
on, so a downstream
[geom/instance-on-points](../../geom/instance-on-points)
with \`align: true\` places instances flush to the surface — trees
standing up on terrain, barnacles clinging to a hull, hairs sticking
out of skin.

The mesh must carry CPU-side data because the scatter happens on the
CPU (one triangle area sum + N random samples). Primitives have it by
default. For a heightfield terrain, set
[geom/heightfield-from-texture](../../geom/heightfield-from-texture)'s
\`cpu_access: true\`.

For projecting a flat grid onto terrain (denser at the centre of the
visible disc, e.g. for grass billboards), reach for
[geom/grass](../../geom/grass) instead — it does camera-relative
distribution as a render-time recipe rather than a static cloud.
`,
    sampleGraph: () => {
      const g = createGraph();
      // Sphere makes the per-face normals visually obvious — every
      // instanced cube sticks out radially because align=true rotates
      // local +Y onto each point's normal, which on a sphere points
      // straight out from the centre.
      const sphere = addNode(g, 'geom/sphere', {
        id: 'sphere',
        position: { x: 0, y: 0 },
        inputValues: { radius: 1, segments: 32, rings: 16 },
      });
      const points = addNode(g, 'points/on-faces', {
        id: 'points',
        position: { x: 280, y: 0 },
        inputValues: { density: 30, seed: 0 },
      });
      const cube = addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 0, y: 200 },
        inputValues: { size: 1 },
      });
      const inst = addNode(g, 'geom/instance-on-points', {
        id: 'inst',
        position: { x: 560, y: 100 },
        inputValues: { scale: 0.06, align: true },
      });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: points.id, socket: 'geometry' });
      addEdge(g, { node: points.id, socket: 'points' }, { node: inst.id, socket: 'points' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: inst.id, socket: 'instance' });
      return { graph: g, rootNodeId: 'inst' };
    },
  },
  evaluate(_ctx, inputs): { points: PointCloudValue } {
    const geom = inputs.geometry as GeometryValue;
    if (!geom.mesh) {
      throw new Error(
        'points/on-faces requires a CPU-side mesh on the input ' +
          'geometry; the upstream node produced GPU-only data.',
      );
    }
    return {
      points: distributeOnFaces(
        geom.mesh,
        inputs.density as number,
        inputs.seed as number,
      ),
    };
  },
};
