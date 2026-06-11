import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { uploadMeshToGpu } from '../render/mesh.js';
import { generateSphere } from '../render/sphere.js';

export const sphereNode: NodeDef = {
  id: 'geom/sphere',
  category: 'Geometry/Primitives',
  inputs: [
    {
      name: 'radius',
      type: 'Float',
      default: 1,
      description: 'world-space radius',
    },
    {
      name: 'segments',
      type: 'Int',
      default: 32,
      min: 2,
      description: 'longitudinal subdivisions (around the equator). More = smoother silhouette; 16 reads as faceted, 64 is essentially smooth',
    },
    {
      name: 'rings',
      type: 'Int',
      default: 16,
      min: 2,
      description: 'latitudinal subdivisions (pole to pole). Usually half the segment count looks balanced',
    },
    {
      name: 'longitude_start',
      type: 'Float',
      default: 0,
      description: 'start of the longitude window, DEGREES. Default 0; together with longitude_end = 360 gives the full sphere',
    },
    {
      name: 'longitude_end',
      type: 'Float',
      default: 360,
      description: 'end of the longitude window, DEGREES. Default 360. Set to 180 for a half-orange wedge',
    },
    {
      name: 'latitude_start',
      type: 'Float',
      default: -90,
      description: 'start of the latitude window, DEGREES (geographic convention: -90 = south pole). Default -90. Set to 0 to start at the equator',
    },
    {
      name: 'latitude_end',
      type: 'Float',
      default: 90,
      description: 'end of the latitude window, DEGREES (+90 = north pole). Default 90. Set to 0 for the southern hemisphere',
    },
    {
      name: 'cap',
      type: 'Bool',
      default: true,
      description: 'close the top + bottom open boundaries with flat triangle-fan discs when the latitude range is partial. No-op for a full sphere. Longitude-side boundaries are never capped',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'a UV sphere mesh centred at the origin, ready to wire into [scene/entity](../../scene/entity) or [geom/instance-on-points](../../geom/instance-on-points)',
    },
  ],
  doc: {
    summary: 'A UV-sphere primitive mesh, optionally windowed to a partial latitude / longitude range.',
    description: `
The classic longitude/latitude sphere. Generates triangle strips from
\`rings\` × \`segments\` vertices on a unit sphere, scaled by \`radius\`.
Pinches at the poles like every UV sphere does — for cases where that
matters (close-up shading, even tessellation), an icosphere generator
would be a better choice; this one trades that for predictable UV layout.

The four window inputs (\`longitude_start\` / \`longitude_end\` /
\`latitude_start\` / \`latitude_end\`) carve out a partial sphere when
the defaults are tightened — half-sphere, sphere cap (polar dome),
equatorial band, orange-wedge, etc. With \`cap: true\` (the default)
the top and bottom open boundaries close with flat triangle-fan discs;
longitude-side boundaries are intentionally left open so you can see
through wedge interiors.

Wire the output into a [scene/entity](../../scene/entity) to give
it a material and place it in a scene, into
[geom/instance-on-points](../../geom/instance-on-points)
to scatter copies across a point cloud, or into
[geom/merge](../../geom/merge) to combine with other
meshes before instancing.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'geom/sphere', {
        id: 'sphere',
        position: { x: 0, y: 0 },
        inputValues: { radius: 1, segments: 32, rings: 16 },
      });
      return { graph: g, rootNodeId: 'sphere' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const deg = Math.PI / 180;
    const mesh = generateSphere({
      radius: inputs.radius as number,
      segments: inputs.segments as number,
      rings: inputs.rings as number,
      longitudeStart: (inputs.longitude_start as number) * deg,
      longitudeEnd: (inputs.longitude_end as number) * deg,
      latitudeStart: (inputs.latitude_start as number) * deg,
      latitudeEnd: (inputs.latitude_end as number) * deg,
      cap: inputs.cap as boolean,
    });
    return {
      geometry: uploadMeshToGpu(device, mesh, ctx.previousOutput?.geometry as GeometryValue | undefined),
    };
  },
};
