import type { NodeDef } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import shader from './solid-color.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const solidColorNode: NodeDef = {
  id: 'core/solid-color',
  category: 'Texture/Generators',
  inputs: [
    { name: 'color', type: 'Color', default: [1, 1, 1, 1] },
    { name: 'resolution', type: 'Int', default: 512 },
  ],
  outputs: [{ name: 'texture', type: 'Texture2D' }],
  evaluate(ctx, inputs): { texture: Texture2DValue } {
    const device = requireDevice(ctx);
    const color = inputs.color as [number, number, number, number];
    const resolution = inputs.resolution as number;

    const texture = device.createTexture({
      size: [resolution, resolution],
      format: TEXTURE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    const uniformData = new Float32Array(4);
    uniformData.set(color, 0);

    const uniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformData as BufferSource);

    const module = device.createShaderModule({ code: shader });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module },
      fragment: { module, targets: [{ format: TEXTURE_FORMAT }] },
    });

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
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
