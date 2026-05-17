import type { NodeDef } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import { requireDevice, reusableTexture } from '../core/resources.js';
import { getRenderPipeline, getSampler, getShaderModule } from '../render/gpu-cache.js';
import shader from './blend-mask.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

// Per-pixel mask blend: each output texel = mix(a, b, mask.r). Use cases:
// splat-paint terrain (grass × rock keyed by a slope mask), regional color
// swaps, weather effects, etc. The companion `core/blend` uses a uniform
// factor instead of a mask texture.
export const blendMaskNode: NodeDef = {
  id: 'core/blend-mask',
  category: 'Texture/Filters',
  inputs: [
    { name: 'a', type: 'Texture2D' },
    { name: 'b', type: 'Texture2D' },
    { name: 'mask', type: 'Texture2D' },
    { name: 'resolution', type: 'Int', default: 512 },
  ],
  outputs: [{ name: 'texture', type: 'Texture2D' }],
  evaluate(ctx, inputs): { texture: Texture2DValue; __uniformBuffer?: GPUBuffer } {
    const device = requireDevice(ctx);
    const a = inputs.a as Texture2DValue;
    const b = inputs.b as Texture2DValue;
    const mask = inputs.mask as Texture2DValue;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as { texture?: Texture2DValue } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

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

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: a.texture },
        { binding: 1, resource: b.texture },
        { binding: 2, resource: mask.texture },
        { binding: 3, resource: sampler },
      ],
    });

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
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);

    return { texture: out };
  },
};
