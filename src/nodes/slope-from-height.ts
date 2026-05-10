import type { NodeDef } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import shader from './slope-from-height.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

// Convert a heightfield texture into a grayscale slope mask via the
// magnitude of its gradient. Black = flat, white = steep. Drop into a
// blend node as the t-factor to splat-paint terrain (grass on flats, rock
// on steeps), or into cloud-step → cloud-multiply for per-point distribution
// gating that mirrors what cloud-slope does for point clouds.
export const slopeFromHeightNode: NodeDef = {
  id: 'core/slope-from-height',
  category: 'Texture/Filters',
  inputs: [
    { name: 'height', type: 'Texture2D' },
    {
      name: 'strength',
      type: 'Float',
      default: 4,
      description: 'gradient multiplier; larger → more area reads as steep',
    },
    { name: 'resolution', type: 'Int', default: 512 },
  ],
  outputs: [{ name: 'texture', type: 'Texture2D' }],
  evaluate(ctx, inputs): { texture: Texture2DValue } {
    const device = requireDevice(ctx);
    const height = inputs.height as Texture2DValue;
    const strength = inputs.strength as number;
    const resolution = inputs.resolution as number;

    const texture = device.createTexture({
      size: [resolution, resolution],
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    const uniformData = new Float32Array(4);
    uniformData[0] = strength;

    const uniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformData as BufferSource);

    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });

    const module = device.createShaderModule({ code: shader });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module },
      fragment: { module, targets: [{ format: TEXTURE_FORMAT }] },
    });

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: height.view },
        { binding: 2, resource: sampler },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);

    return {
      texture: {
        texture,
        view: texture.createView(),
        format: TEXTURE_FORMAT,
        width: resolution,
        height: resolution,
      },
    };
  },
};
