import type { NodeDef } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
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
  evaluate(ctx, inputs): { texture: Texture2DValue } {
    const device = requireDevice(ctx);
    const resolution = inputs.resolution as number;

    const texture = device.createTexture({
      size: [resolution, resolution],
      format: TEXTURE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    // Params: scale, octaves, lacunarity, gain, seed (5 floats = 20B). Pad to
    // 32 to satisfy the 16-byte uniform-buffer minimum.
    const uniformData = new Float32Array(8);
    uniformData[0] = inputs.scale as number;
    uniformData[1] = inputs.octaves as number;
    uniformData[2] = inputs.lacunarity as number;
    uniformData[3] = inputs.gain as number;
    uniformData[4] = inputs.seed as number;

    const uniformBuffer = device.createBuffer({
      size: uniformData.byteLength,
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
