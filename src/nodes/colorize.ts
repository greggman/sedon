import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableTexture,
} from '../core/resources.js';
import { getRenderPipeline, getSampler, getShaderModule } from '../render/gpu-cache.js';
import shader from './colorize.wgsl';

// Remap a single-channel input through a 1D RAMP TEXTURE. Pairs with
// `core/ramp` for authored gradients, but any Nx1 RGBA texture works
// as the palette source — e.g. a sampled brand-colour strip, a heat
// map LUT, etc.
//
// The shader does the half-texel sample-uv correction so a 2-pixel
// ramp behaves like a clean 0→1 lerp, not a "stuck at endpoint until
// 0.25" step — see colorize.wgsl. Authors using `core/ramp` get the
// expected linear behaviour by default; authors using an arbitrary
// LUT texture get the same correction for free.

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const colorizeNode: NodeDef = {
  id: 'core/colorize',
  category: 'Texture/Filters',
  inputs: [
    {
      name: 'factor',
      type: 'Texture2D',
      description: 'single-channel input. Its red value at each pixel is the parameter t ∈ [0,1] that samples the ramp; e.g. a perlin texture becomes a ramp-coloured noise pattern',
    },
    {
      name: 'ramp',
      type: 'Texture2D',
      description: 'Nx1 colour palette texture (typically from `core/ramp`). Sampled by the per-pixel factor value to produce the output colour. Any Texture2D works — but ramps are 1-row wide because only the U axis matters',
    },
    { name: 'resolution', type: 'Int', default: 512 },
  ],
  outputs: [{ name: 'texture', type: 'Texture2D' }],
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const factor = inputs.factor as Texture2DValue;
    const ramp = inputs.ramp as Texture2DValue;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
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

    // Linear filtering covers both the factor sample (smooth across
    // the input) and the ramp sample (smooth between adjacent stop
    // colours). Repeat addressing for factor only affects authoring
    // edge cases; clamp would also be fine here.
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
      [factor.texture, ramp.texture, sampler],
      () => [
        { binding: 0, resource: factor.texture },
        { binding: 1, resource: ramp.texture },
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

    return { texture: out, __bindGroup: bindGroup };
  },
};
