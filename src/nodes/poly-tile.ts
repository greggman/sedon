import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { ShaderStage, getPipelineWithLayout, getShaderModule } from '../render/gpu-cache.js';
import shader from './poly-tile.wgsl';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'poly-tile-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const polyTileNode: NodeDef = {
  id: 'tex/poly-tile',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'poly_color',
      type: 'Color',
      default: [0.85, 0.55, 0.30, 1],
      description: 'colour of each polygon tile',
    },
    {
      name: 'mortar_color',
      type: 'Color',
      default: [0.15, 0.15, 0.15, 1],
      description: 'colour of the mortar / gap. For N≠4, this also fills the corner gaps where the polygons don\'t tile',
    },
    {
      name: 'divisions',
      type: 'Vec2',
      default: [10, 10],
      description: 'square grid divisions: tiles across × down',
    },
    {
      name: 'sides',
      type: 'Int',
      default: 6,
      min: 3,
      description: 'number of polygon sides. 3 = triangle, 4 = square (perfect tile at angle=0), 5 = pentagon, 6 = hexagon, 8 = octagon, high values approach circles. For N ≠ 4, gaps fill with mortar_color',
    },
    {
      name: 'mortar',
      type: 'Float',
      default: 0.06,
      min: 0,
      max: 0.5,
      description: 'extra mortar thickness as a fraction of cell radius. 0 = polygons touch their cell bounds; > 0 = visible mortar band inside each cell',
    },
    {
      name: 'angle',
      type: 'Float',
      default: 0,
      description: 'rotation of each polygon around its centre, in degrees. Use to align orientation: N=4 at 0 = axis-aligned square; N=6 at 0 = flat-top hex; N=3 at 0 = triangle pointing right (set ±90 for up/down)',
    },
    {
      name: 'row_offset',
      type: 'Float',
      default: 0,
      min: 0,
      description: 'per-row horizontal shift in cell units. Each row N gets shifted by N·row_offset under fract. 0 = aligned; 0.5 = 2-row alternation (running-bond brick); 1/3 ≈ 0.333 = 3-row diagonal sweep; 0.25 = 4-row sweep; integer values wrap back to aligned',
    },
    {
      name: 'resolution',
      type: 'Int',
      default: 512,
      min: 1,
      description: 'output texture width and height in pixels',
    },
  ],
  outputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'a regular polygon tiled on a square grid. Tiles cleanly for N=4; other N produces decorative non-tiling polygon shapes with mortar in the gaps',
    },
  ],
  doc: {
    summary: 'Regular N-sided polygons stamped on a square grid — triangle / square / pentagon / hex / octagon.',
    description: `
A single N-sided regular polygon is drawn in each cell of a square grid.
For \`sides = 4\` and \`angle = 0\`, the polygons are axis-aligned squares
that tile the plane with no gaps (modulo \`mortar\`). For other \`sides\`,
the polygons don't naturally tile the plane — the corner gaps fill with
\`mortar_color\`, which reads as a decorative pattern.

For a TRUE hex tiling (no gaps), use [tex/hex-tile](../../tex/hex-tile).
This node trades that geometric truth for shape flexibility.

Common uses:

- triangle pattern: \`sides = 3\`, \`angle = 90\` for up-pointing
- decorative octagon-and-square (Moroccan-style) look: \`sides = 8\`,
  rotate to taste
- "studded" look: \`sides = 6\`, large \`mortar\` so the hexes float
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'tex/poly-tile', {
        id: 'poly',
        position: { x: 0, y: 0 },
        inputValues: {
          poly_color: [0.85, 0.55, 0.30, 1],
          mortar_color: [0.15, 0.15, 0.15, 1],
          divisions: [8, 8],
          sides: 6,
          mortar: 0.08,
          angle: 0,
          row_offset: 0,
          resolution: 512,
        },
      });
      return { graph: g, rootNodeId: 'poly' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const poly = inputs.poly_color as [number, number, number, number];
    const mortar_c = inputs.mortar_color as [number, number, number, number];
    const divisions = inputs.divisions as [number, number];
    const sides = inputs.sides as number;
    const mortar = inputs.mortar as number;
    const angle = inputs.angle as number;
    const rowOffset = inputs.row_offset as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'poly-tile-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec4 poly (16) + vec4 mortar (16) + vec2 div (8) + f32 mortar (4) +
    // f32 sides (4) + f32 angle (4) + 12 pad = 64 bytes (next vec4
    // alignment boundary).
    const uniformData = new Float32Array(16);
    uniformData.set(poly, 0);
    uniformData.set(mortar_c, 4);
    uniformData[8] = divisions[0];
    uniformData[9] = divisions[1];
    uniformData[10] = mortar;
    uniformData[11] = sides;
    uniformData[12] = angle * (Math.PI / 180);
    uniformData[13] = rowOffset;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const module = getShaderModule(device, shader);
    const { bindGroupLayout: bgl, pipeline } = getPipelineWithLayout(
      device,
      UNIFORM_FRAG_BGL,
      (layout) => ({
        label: 'poly-tile-pipeline',
        layout,
        vertex: { module },
        fragment: { module, targets: [{ format: TEXTURE_FORMAT }] },
      }),
    );

    const bindGroup = reusableBindGroup(
      device,
      prev?.__bindGroup,
      bgl,
      [uniformBuffer],
      () => [{ binding: 0, resource: uniformBuffer }],
    );

    const encoder = device.createCommandEncoder({ label: 'poly-tile-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'poly-tile-pass',
      colorAttachments: [
        {
          view: out.texture,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup.bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);

    return { texture: out, __uniformBuffer: uniformBuffer, __bindGroup: bindGroup };
  },
};
