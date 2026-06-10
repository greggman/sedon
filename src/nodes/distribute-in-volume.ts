import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue, PointCloudValue } from '../core/resources.js';
import { distributeInVolume } from '../render/mesh.js';

export const distributeInVolumeNode: NodeDef = {
  id: 'points/in-volume',
  category: 'Geometry/Distribution',
  inputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'closed mesh whose INTERIOR is sampled. Must be watertight + consistently wound — open or flipped meshes break the inside/outside test. Primitive sphere/cube/cylinder work out of the box; CPU-side mesh required (no GPU-only inputs)',
    },
    {
      name: 'density',
      type: 'Float',
      default: 10,
      description: 'points per unit volume of the mesh\'s interior. A unit-radius sphere has volume ~4.2 — density 10 gives ~42 points. Bump for denser attractor clouds; drop for faster eval',
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0,
      description: 'PRNG seed; same seed reproduces the same point cloud',
    },
  ],
  outputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: 'points scattered uniformly through the mesh interior. No surface normals (interior points have no natural orientation) — paired downstream nodes that read `align: true` will see the per-instance default of identity rotation',
    },
  ],
  doc: {
    summary: 'Scatter points uniformly through the INTERIOR of a closed mesh.',
    description: `
Volume-filling counterpart to
[points/on-faces](../../points/on-faces). Generates
candidate points uniformly inside the mesh's axis-aligned bounding box,
then keeps only the ones that test as inside via a ray-cast parity
check. Expected output count ≈ \`density × interior_volume\`.

**Use case**: the right shape of attractor cloud for
[branch/space-colonization](../../branch/space-colonization). A
surface-only attractor cloud (from
[points/on-faces](../../points/on-faces) on a sphere)
makes branches grow toward the shell and stop, so the resulting tree is
a hollow rind. A volume-filling cloud (this node) gives the algorithm
attractors to chase INTO the canopy, producing the irregular forking
through the interior that big-canopy deciduous trees (oak, maple,
beech) actually have. Pair sphere → this → space-colonization for the
classic round canopy; ellipsoid for flame-shape; stretched cube for
hedgerow.

**Requirements on the input mesh**: closed (watertight), manifold,
consistently wound. Open meshes or inverted faces produce false
positives/negatives in the inside test. Primitive
[geom/sphere](../../geom/sphere), [geom/cube](../../geom/cube),
[geom/cylinder](../../geom/cylinder), and
[geom/cone](../../geom/cone) all qualify.

**Cost** is O(candidates × triangles). Density 10 on a sphere with 16
segments × 12 rings (~140 triangles) costs ~3 ms; bump density up for
hero shots and accept that cost at edit time.
`,
    sampleGraph: () => {
      const g = createGraph();
      // Sphere → distribute-in-volume → instance-cube-on-points so we
      // can see the cubes filling the sphere's interior, not just its
      // shell. align stays off because interior points have no normals.
      const sphere = addNode(g, 'geom/sphere', {
        id: 'sphere',
        position: { x: 0, y: 0 },
        inputValues: { radius: 1, segments: 16, rings: 12 },
      });
      const points = addNode(g, 'points/in-volume', {
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
        inputValues: { scale: 0.05, align: false },
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
        'points/in-volume requires a CPU-side mesh on the input ' +
          'geometry; the upstream node produced GPU-only data.',
      );
    }
    return {
      points: distributeInVolume(
        geom.mesh,
        inputs.density as number,
        inputs.seed as number,
      ),
    };
  },
};
