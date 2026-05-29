import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { uploadMeshToGpu, type CpuMesh } from '../render/mesh.js';

// Transform UVs of an input geometry — multiplies by `scale`. Useful for
// tiling a texture more (or less) densely across a mesh than its source UVs
// dictate. A heightfield-to-mesh outputs UVs in [0,1] across the whole
// terrain, so a single grass-texture image stretches across all of it; pass
// the mesh through uv-transform with scale=[16, 16] and the texture tiles
// 16× in each direction, reading as proper close-range grass density.
//
// scale > 1 → texture appears smaller / repeats more
// scale < 1 → texture stretches / repeats less
//
// Repetition is handled by the sampler's `repeat` address mode (already on
// in createSharedSampler), so non-integer scales work fine.
export const uvTransformNode: NodeDef = {
  id: 'core/uv-transform',
  category: 'Geometry/Modifiers',
  inputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'input mesh whose UVs will be rescaled',
    },
    {
      name: 'scale',
      type: 'Vec2',
      default: [1, 1],
      description: 'multiplier on UVs per axis; >1 tiles textures more densely (texture appears smaller), <1 stretches the texture across more of the mesh',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'the input mesh with every UV coordinate multiplied by `scale`. Positions / normals / indices unchanged',
    },
  ],
  doc: {
    summary: 'Multiply a mesh\'s UVs by a per-axis scale factor.',
    description: `
Scales the UV coordinates of every vertex by \`scale.x\` and \`scale.y\`.
Texture sampling already uses repeat addressing, so non-integer scales
work fine — \`scale = [2.5, 2.5]\` tiles a texture 2.5× across the mesh.

The motivating use: a [core/texture-to-heightfield-mesh](../../core/texture-to-heightfield-mesh)
emits UVs in [0, 1] across the whole terrain. A single grass texture
stretched across a 200m terrain reads as blurry mud at ground level. Pass
the mesh through uv-transform with \`scale = [16, 16]\` and the same
texture tiles 16× per axis, reading as proper close-range grass.

Smaller-than-one scales are also useful — \`[0.5, 0.5]\` stretches a
texture to cover 4× more of the mesh, handy when a UV unwrap was
authored too tight.
`,
    sampleGraph: () => {
      const g = createGraph();
      const plane = addNode(g, 'core/plane', {
        id: 'plane',
        position: { x: 0, y: 0 },
        inputValues: { size: [4, 4], divisions: [1, 1] },
      });
      const uvtx = addNode(g, 'core/uv-transform', {
        id: 'uv',
        position: { x: 280, y: 0 },
        inputValues: { scale: [4, 4] },
      });
      addEdge(g, { node: plane.id, socket: 'geometry' }, { node: uvtx.id, socket: 'geometry' });
      return { graph: g, rootNodeId: 'uv' };
    },
  },
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const input = inputs.geometry as GeometryValue;
    if (!input.mesh) {
      throw new Error(
        'core/uv-transform requires a CPU-side mesh on the input geometry; ' +
          'this source produced GPU-only data.',
      );
    }
    const scale = inputs.scale as [number, number];
    const sx = scale[0];
    const sy = scale[1];

    const srcUv = input.mesh.uvs;
    const uvs = new Float32Array(srcUv.length);
    for (let i = 0; i < srcUv.length; i += 2) {
      uvs[i]     = srcUv[i]!     * sx;
      uvs[i + 1] = srcUv[i + 1]! * sy;
    }

    const out: CpuMesh = {
      positions: input.mesh.positions,
      normals: input.mesh.normals,
      uvs,
      indices: input.mesh.indices,
    };
    return {
      geometry: uploadMeshToGpu(device, out, ctx.previousOutput?.geometry as GeometryValue | undefined),
    };
  },
};
