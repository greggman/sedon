import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { getRenderPipeline, getSampler, getShaderModule } from '../render/gpu-cache.js';
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
    {
      name: 'invert',
      type: 'Bool',
      default: false,
      description: 'output flatness (white on flats) instead of slope — e.g. as a grass-density mask',
    },
    { name: 'resolution', type: 'Int', default: 512 },
  ],
  outputs: [{ name: 'texture', type: 'Texture2D' }],
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const height = inputs.height as Texture2DValue;
    const strength = inputs.strength as number;
    const invert = inputs.invert as boolean;
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
    uniformData[0] = strength;
    uniformData[1] = invert ? 1 : 0;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const sampler = getSampler(device, {
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });

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
      [uniformBuffer, height.texture, sampler],
      () => [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: height.texture },
        { binding: 2, resource: sampler },
      ],
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
