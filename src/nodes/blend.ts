import type { NodeDef } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import { requireDevice, reusableBuffer, reusableTexture } from '../core/resources.js';
import { getRenderPipeline, getSampler, getShaderModule } from '../render/gpu-cache.js';
import shader from './blend.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const blendNode: NodeDef = {
  id: 'core/blend',
  category: 'Texture/Filters',
  inputs: [
    { name: 'a', type: 'Texture2D' },
    { name: 'b', type: 'Texture2D' },
    { name: 'factor', type: 'Float', default: 0.5 },
    {
      name: 'mode',
      type: 'Int',
      default: 0,
      description: 'compositing operator applied between a and b',
      enumOptions: [
        { value: 0, label: 'mix' },
        { value: 1, label: 'add' },
        { value: 2, label: 'multiply' },
        { value: 3, label: 'screen' },
      ],
    },
    { name: 'resolution', type: 'Int', default: 512 },
  ],
  outputs: [{ name: 'texture', type: 'Texture2D' }],
  evaluate(ctx, inputs): { texture: Texture2DValue; __uniformBuffer?: GPUBuffer } {
    const device = requireDevice(ctx);
    const a = inputs.a as Texture2DValue;
    const b = inputs.b as Texture2DValue;
    const factor = inputs.factor as number;
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

    // 16-byte aligned: f32 factor + f32 mode + vec2 pad.
    const mode = inputs.mode as number;
    const uniformData = new Float32Array(4);
    uniformData[0] = factor;
    uniformData[1] = mode;

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

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: a.view },
        { binding: 2, resource: b.view },
        { binding: 3, resource: sampler },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: out.view,
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
