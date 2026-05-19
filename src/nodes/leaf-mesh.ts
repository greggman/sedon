import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { generateLeafMesh } from '../render/leaf-mesh.js';
import { uploadMeshToGpu } from '../render/mesh.js';

// 3D leaf card with curl + edge bend + tip taper. Drop-in replacement
// for `core/plane` when you want a leaf that doesn't look like a
// rectangle — pair with a leaf-skeleton-derived alpha mask material
// and the silhouette will be the right shape; this node controls the
// underlying 3D form so the leaf doesn't read as a flat billboard
// from all angles.
//
// Local frame: base at the origin, length along +Y, width along ±X,
// face initially looking at +Z. Designed to drop into
// `instance-geometry-on-points` with `align: true` — the leaf's +Y
// will align to each point's outward normal.
export const leafMeshNode: NodeDef = {
  id: 'core/leaf-mesh',
  category: 'Geometry/Primitives',
  inputs: [
    { name: 'length', type: 'Float', default: 1, description: 'leaf length base → tip' },
    { name: 'width', type: 'Float', default: 0.4, description: 'leaf width at the widest point (the base, modulo `cup`)' },
    {
      name: 'curl',
      type: 'Float',
      default: 0.1,
      description: 'how far the tip drops along -Z (world units). 0 = flat; ~0.15 × length looks natural for hanging leaves',
    },
    {
      name: 'bend',
      type: 'Float',
      default: 0.02,
      description: 'how far each edge droops along -Z (world units). Adds gentle channel-like curvature down the midrib',
    },
    {
      name: 'cup',
      type: 'Float',
      default: 0.3,
      description: 'tip taper. 0 = strict rectangle; 1 = pinches to zero width at the tip. ~0.3 gives a typical lanceolate leaf',
    },
    {
      name: 'lengthDivisions',
      type: 'Int',
      default: 8,
      description: 'vertices along the length minus 1. Higher = smoother curl curve',
    },
    {
      name: 'widthDivisions',
      type: 'Int',
      default: 4,
      description: 'vertices across the width minus 1. Higher = smoother edge bend',
    },
  ],
  outputs: [{ name: 'geometry', type: 'Geometry' }],
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const mesh = generateLeafMesh({
      length: inputs.length as number,
      width: inputs.width as number,
      curl: inputs.curl as number,
      bend: inputs.bend as number,
      cup: inputs.cup as number,
      lengthDivisions: inputs.lengthDivisions as number,
      widthDivisions: inputs.widthDivisions as number,
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
