import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { getRenderPipeline, getShaderModule } from '../render/gpu-cache.js';
import shader from './solid-color.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const solidColorNode: NodeDef = {
  id: 'core/solid-color',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'color',
      type: 'Color',
      default: [1, 1, 1, 1],
      description: 'the colour every pixel will be set to (RGBA, alpha included)',
    },
    {
      name: 'resolution',
      type: 'Int',
      default: 512,
      description: 'output texture width and height in pixels. Keep small (32) when only the colour matters; bump up only if a downstream filter actually needs more pixels',
    },
  ],
  outputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'a texture where every pixel equals `color`',
    },
  ],
  doc: {
    summary: 'A flat colour as a Texture2D.',
    description:
      'Renders one solid colour into every pixel of an N×N texture. Useful as the ' +
      '`a` or `b` input to a blend node when you want to test "what does this look like ' +
      'tinted purple", as a stand-in albedo while you build out the rest of a material, ' +
      'or anywhere a downstream consumer wants a texture but you only want to feed it a ' +
      'colour.',
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'core/solid-color', {
        id: 'solid',
        position: { x: 0, y: 0 },
        inputValues: { color: [0.36, 0.58, 0.85, 1], resolution: 256 },
      });
      return { graph: g, rootNodeId: 'solid' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const color = inputs.color as [number, number, number, number];
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    const uniformData = new Float32Array(4);
    uniformData.set(color, 0);

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const module = getShaderModule(device, shader);
    const pipeline = getRenderPipeline(device, {
      layout: 'auto',
      vertex: { module },
      fragment: { module, targets: [{ format: TEXTURE_FORMAT }] },
    });

    const bindGroup = reusableBindGroup(
      device,
      prev?.__bindGroup,
      pipeline.getBindGroupLayout(0),
      [uniformBuffer],
      () => [{ binding: 0, resource: uniformBuffer }],
    );

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
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
