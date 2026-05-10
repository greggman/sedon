import type { NodeDef } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import shader from './colorize.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const colorizeNode: NodeDef = {
  id: 'core/colorize',
  category: 'Texture/Filters',
  inputs: [
    { name: 'factor', type: 'Texture2D' },
    { name: 'low', type: 'Color', default: [0, 0, 0, 1] },
    { name: 'high', type: 'Color', default: [1, 1, 1, 1] },
    { name: 'resolution', type: 'Int', default: 512 },
  ],
  outputs: [{ name: 'texture', type: 'Texture2D' }],
  evaluate(ctx, inputs): { texture: Texture2DValue } {
    const device = requireDevice(ctx);
    const factor = inputs.factor as Texture2DValue;
    const low = inputs.low as [number, number, number, number];
    const high = inputs.high as [number, number, number, number];
    const resolution = inputs.resolution as number;

    const texture = device.createTexture({
      size: [resolution, resolution],
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // Uniform: vec4 low + vec4 high = 32 bytes.
    const uniformData = new Float32Array(8);
    uniformData.set(low, 0);
    uniformData.set(high, 4);

    const uniformBuffer = device.createBuffer({
      size: uniformData.byteLength,
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
        { binding: 1, resource: factor.view },
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
