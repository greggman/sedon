import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue, PointCloudValue } from '../core/resources.js';
import { distributeOnFaces } from '../render/mesh.js';

export const distributeOnFacesNode: NodeDef = {
  id: 'core/distribute-on-faces',
  category: 'Geometry/Distribution',
  inputs: [
    { name: 'geometry', type: 'Geometry' },
    { name: 'density', type: 'Float', default: 10, description: 'points per unit area' },
    { name: 'seed', type: 'Float', default: 0 },
  ],
  outputs: [{ name: 'points', type: 'PointCloud' }],
  evaluate(_ctx, inputs): { points: PointCloudValue } {
    const geom = inputs.geometry as GeometryValue;
    if (!geom.mesh) {
      throw new Error(
        'core/distribute-on-faces requires a CPU-side mesh on the input ' +
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
