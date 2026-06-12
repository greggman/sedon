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
import shader from './hex-tile.wgsl';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'hex-tile-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const hexTileNode: NodeDef = {
  id: 'tex/hex-tile',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'hex_color',
      type: 'Color',
      default: [0.85, 0.55, 0.30, 1],
      description: 'colour of each hexagonal tile',
    },
    {
      name: 'mortar_color',
      type: 'Color',
      default: [0.15, 0.15, 0.15, 1],
      description: 'colour of the mortar / gap between tiles',
    },
    {
      name: 'divisions',
      type: 'Vec2',
      default: [10, 10],
      description: 'approximate hex divisions across the texture. Tiles stay regular regardless of aspect because V is scaled internally by √3/2',
    },
    {
      name: 'mortar',
      type: 'Float',
      default: 0.06,
      min: 0,
      max: 0.5,
      description: 'mortar thickness as a fraction of cell radius. 0 = no mortar; 0.06 = thin grout line; 0.2 = thick gap',
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
      description: 'a regular hexagonal-tile pattern with mortar gaps',
    },
  ],
  doc: {
    summary: 'Regular hexagonal tiling — bathroom-tile / honeycomb / strategy-game-grid pattern.',
    description: `
Standard pointy-top hex grid via the "two offset rectangular lattices,
keep the closer cell" construction. Tiles are regular regardless of
output aspect ratio: V gets a √3/2 internal scale so a square texture
shows square-aspect hexes, not stretched ones.

For randomised per-tile colour (e.g. hex tile floor with variation),
chain through [tex/colorize](../../tex/colorize) with a noise that
matches the hex frequency. For random per-tile rotation/offset stamps,
use [tex/tile-with-jitter](../../tex/tile-with-jitter) (square grid) —
this node is just the pattern.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'tex/hex-tile', {
        id: 'hex',
        position: { x: 0, y: 0 },
        inputValues: {
          hex_color: [0.85, 0.55, 0.30, 1],
          mortar_color: [0.15, 0.15, 0.15, 1],
          divisions: [10, 10],
          mortar: 0.08,
          resolution: 512,
        },
      });
      return { graph: g, rootNodeId: 'hex' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const hex = inputs.hex_color as [number, number, number, number];
    const mortar_c = inputs.mortar_color as [number, number, number, number];
    const divisions = inputs.divisions as [number, number];
    const mortar = inputs.mortar as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'hex-tile-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec4 hex (16) + vec4 mortar (16) + vec2 div (8) + f32 mortar (4) +
    // pad (4) = 48 bytes.
    const uniformData = new Float32Array(12);
    uniformData.set(hex, 0);
    uniformData.set(mortar_c, 4);
    uniformData[8] = divisions[0];
    uniformData[9] = divisions[1];
    uniformData[10] = mortar;

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
        label: 'hex-tile-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'hex-tile-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'hex-tile-pass',
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
