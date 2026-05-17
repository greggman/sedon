import type { NodeDef } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import { requireDevice, reusableBuffer, reusableTexture } from '../core/resources.js';
import { getRenderPipeline, getShaderModule } from '../render/gpu-cache.js';
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
  evaluate(ctx, inputs): { texture: Texture2DValue; __uniformBuffer?: GPUBuffer } {
    const device = requireDevice(ctx);
    const color = inputs.color as [number, number, number, number];
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as { texture?: Texture2DValue; __uniformBuffer?: GPUBuffer } | undefined;
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

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: uniformBuffer }],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: out.texture,
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

    return { texture: out, __uniformBuffer: uniformBuffer };
  },
};
