import type { NodeDef } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import { requireDevice, reusableBuffer, reusableTexture } from '../core/resources.js';
import { getRenderPipeline, getShaderModule } from '../render/gpu-cache.js';
import shader from './worley.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const worleyNode: NodeDef = {
  id: 'core/worley',
  category: 'Texture/Noise',
  inputs: [
    { name: 'scale', type: 'Float', default: 4 },
    { name: 'octaves', type: 'Int', default: 1 },
    { name: 'lacunarity', type: 'Float', default: 2 },
    { name: 'gain', type: 'Float', default: 0.5 },
    { name: 'seed', type: 'Float', default: 0 },
    { name: 'resolution', type: 'Int', default: 512 },
  ],
  outputs: [{ name: 'texture', type: 'Texture2D' }],
  evaluate(ctx, inputs): { texture: Texture2DValue; __uniformBuffer?: GPUBuffer } {
    const device = requireDevice(ctx);
    const resolution = inputs.resolution as number;

    // Re-use our previous texture when only non-dimension parameters
    // changed (scale, octaves, seed, …). Avoids a GPUTexture
    // allocate+destroy cycle per drag-pixel when the user is nudging a
    // value — the same texture stays put, we just re-render new
    // contents into it.
    const prev = ctx.previousOutput as { texture?: Texture2DValue; __uniformBuffer?: GPUBuffer } | undefined;
    const outputTexture = reusableTexture(device, prev?.texture, {
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // Params: scale, octaves, lacunarity, gain, seed (5 floats = 20B). Pad to
    // 32 to satisfy the 16-byte uniform-buffer minimum.
    const uniformData = new Float32Array(8);
    uniformData[0] = inputs.scale as number;
    uniformData[1] = inputs.octaves as number;
    uniformData[2] = inputs.lacunarity as number;
    uniformData[3] = inputs.gain as number;
    uniformData[4] = inputs.seed as number;

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
          view: outputTexture.view,
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

    return { texture: outputTexture };
  },
};
