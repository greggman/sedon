import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { HeightfieldValue, Texture2DValue } from '../core/resources.js';

// Wrap a Texture2D with world-space metadata so downstream terrain nodes can
// interpret it as a heightfield. Any Texture2D-producing node (Perlin,
// Worley, Blend, Warp, Colorize, etc.) plugs straight in, so the entire
// texture toolkit composes for terrain authoring.
export const heightfieldNode: NodeDef = {
  id: 'core/heightfield',
  category: 'Heightfield/Generators',
  inputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'greyscale source texture. R channel is read as height [0, 1], remapped to `heightRange`',
    },
    {
      name: 'worldSize',
      type: 'Vec2',
      default: [10, 10],
      description: 'world-space footprint in metres (X, Z). The texture stretches across this area; smaller worldSize = more pixels per metre = sharper detail',
    },
    {
      name: 'heightRange',
      type: 'Vec2',
      default: [0, 2],
      description: 'world-space height bounds. R=0 in the texture maps to heightRange[0], R=1 maps to heightRange[1]',
    },
  ],
  outputs: [
    {
      name: 'heightfield',
      type: 'Heightfield',
      description: 'a Texture2D paired with its world-space scale and height range, ready for [core/heightfield-to-mesh](../../core/heightfield-to-mesh) or [terrain/hydraulic-erosion](../../terrain/hydraulic-erosion) consumption',
    },
  ],
  doc: {
    summary: 'Tag a Texture2D as a heightfield with world-space scale and height range.',
    description: `
A heightfield is just a texture plus the metadata needed to interpret it
as terrain: how big it is in world units and what its bright/dark pixels
mean in metres of altitude. This node is the wrapper — feed any
greyscale-producing texture node ([core/perlin](../../core/perlin),
[core/worley](../../core/worley),
[core/ridged-noise](../../core/ridged-noise),
[core/blend](../../core/blend), [core/warp](../../core/warp), …) into the
\`texture\` input, set the world dimensions and the altitude bounds, and
you have a Heightfield ready to mesh.

Because the input is just a Texture2D socket, the whole texture toolkit
composes for terrain authoring — you can run a Perlin through Levels and
Blur, blend in Ridged Noise for mountain ridges, warp the whole thing
with another Perlin, and pipe the result into this node. The downstream
[core/heightfield-to-mesh](../../core/heightfield-to-mesh) doesn't know or
care how the texture was built.
`,
    sampleGraph: () => {
      const g = createGraph();
      const noise = addNode(g, 'core/perlin', {
        id: 'noise',
        position: { x: 0, y: 0 },
        inputValues: { scale: [3, 3], octaves: 5, lacunarity: 2, gain: 0.5, seed: 0, resolution: 512 },
      });
      const hf = addNode(g, 'core/heightfield', {
        id: 'hf',
        position: { x: 280, y: 0 },
        inputValues: { worldSize: [10, 10], heightRange: [0, 2] },
      });
      addEdge(g, { node: noise.id, socket: 'texture' }, { node: hf.id, socket: 'texture' });
      return { graph: g, rootNodeId: 'hf' };
    },
  },
  evaluate(_ctx, inputs): { heightfield: HeightfieldValue } {
    return {
      heightfield: {
        texture: inputs.texture as Texture2DValue,
        worldSize: inputs.worldSize as [number, number],
        heightRange: inputs.heightRange as [number, number],
      },
    };
  },
};
