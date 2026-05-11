import type { NodeDef } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import shader from './levels.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

// Brightness / contrast / gamma adjustment of an input texture. Defaults are
// no-op so dropping the node in unconfigured doesn't change anything; tune
// values to tighten dynamic range, push mid-tones, etc. Useful for taming
// flat-looking procedural noise before piping it into colorize.
export const levelsNode: NodeDef = {
  id: 'core/levels',
  category: 'Texture/Filters',
  inputs: [
    { name: 'input', type: 'Texture2D' },
    {
      name: 'brightness',
      type: 'Float',
      default: 0,
      description: 'additive shift; positive lightens, negative darkens',
    },
    {
      name: 'contrast',
      type: 'Float',
      default: 1,
      description: 'multiplier around mid-gray (0.5); >1 expands range, <1 compresses',
    },
    {
      name: 'gamma',
      type: 'Float',
      default: 1,
      description: '<1 pushes midtones brighter, >1 pushes them darker',
    },
    { name: 'resolution', type: 'Int', default: 512 },
  ],
  outputs: [{ name: 'texture', type: 'Texture2D' }],
  evaluate(ctx, inputs): { texture: Texture2DValue } {
    const device = requireDevice(ctx);
    const src = inputs.input as Texture2DValue;
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
    uniformData[0] = inputs.brightness as number;
    uniformData[1] = inputs.contrast as number;
    uniformData[2] = inputs.gamma as number;

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
        { binding: 1, resource: src.view },
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
