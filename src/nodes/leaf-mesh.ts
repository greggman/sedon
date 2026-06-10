import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { generateLeafMesh } from '../render/leaf-mesh.js';
import { uploadMeshToGpu } from '../render/mesh.js';

// 3D leaf card with curl + edge bend + tip taper. Drop-in replacement
// for `geom/plane` when you want a leaf that doesn't look like a
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
  id: 'geom/leaf',
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
      min: 1,
      description: 'vertices along the length minus 1. Higher = smoother curl curve',
    },
    {
      name: 'widthDivisions',
      type: 'Int',
      default: 4,
      min: 1,
      description: 'vertices across the width minus 1. Higher = smoother edge bend',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: '3D leaf card mesh — base at the origin, length along +Y, width along ±X, face initially looking at +Z. Designed to drop into [geom/instance-on-points](../../geom/instance-on-points) with `align: true` so the leaf\'s +Y aligns to each point\'s outward normal',
    },
  ],
  doc: {
    summary: 'A 3D leaf card with curl, edge bend, and tip taper — looks volumetric from any angle.',
    description: `
A drop-in replacement for [geom/plane](../../geom/plane) when you want
a leaf that doesn't read as a flat rectangle from oblique angles.
Pair with a [leaf/skeleton](../../leaf/skeleton)-derived alpha-cutoff
material and the silhouette gets the right organic shape; this node
controls the underlying 3D form so the leaf has visible volume.

Local frame: base at the origin, length along +Y, width along ±X,
face initially looking at +Z. Three shaping knobs:

- **curl** — how far the tip drops along −Z. Gives hanging leaves
  their gravity-loaded look.
- **bend** — how far each edge droops along −Z. Adds a gentle
  channel along the midrib (looks like the leaf folds slightly).
- **cup** — tip taper. 0 = rectangle; 1 = pinches to zero width at
  the tip. ~0.3 = typical lanceolate.

Drop into [geom/instance-on-points](../../geom/instance-on-points)
on a [branch/sample-points](../../branch/sample-points) cloud with
\`align: true\` and you get a tree's worth of properly-oriented
leaves attached to the branches.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'geom/leaf', {
        id: 'leaf',
        position: { x: 0, y: 0 },
        inputValues: {
          length: 1, width: 0.4,
          curl: 0.15, bend: 0.03, cup: 0.3,
          lengthDivisions: 12, widthDivisions: 6,
        },
      });
      return { graph: g, rootNodeId: 'leaf' };
    },
  },
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
