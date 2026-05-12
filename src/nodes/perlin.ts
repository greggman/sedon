import type { NodeDef } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import { requireDevice, reusableTexture } from '../core/resources.js';
import shader from './perlin.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const perlinNode: NodeDef = {
  id: 'core/perlin',
  category: 'Texture/Noise',
  inputs: [
    {
      name: 'scale',
      type: 'Vec2',
      default: [4, 4],
      description: 'tiling frequency per axis. Equal X/Y gives isotropic noise; unequal stretches it (e.g. [2, 12] for vertical wood-grain fibers)',
    },
    { name: 'octaves', type: 'Int', default: 4 },
    { name: 'lacunarity', type: 'Float', default: 2 },
    { name: 'gain', type: 'Float', default: 0.5 },
    { name: 'seed', type: 'Float', default: 0 },
    { name: 'resolution', type: 'Int', default: 512 },
  ],
  outputs: [{ name: 'texture', type: 'Texture2D' }],
  evaluate(ctx, inputs): { texture: Texture2DValue } {
    const device = requireDevice(ctx);
    const resolution = inputs.resolution as number;

    // Backward compat: graphs saved before the scale type was widened
    // store scale as a single Float; broadcast to Vec2 so they still work.
    const rawScale = inputs.scale as number | [number, number];
    const scale: [number, number] =
      typeof rawScale === 'number' ? [rawScale, rawScale] : rawScale;

    // Reuse the previously-allocated texture when dims+format are
    // unchanged. Avoids GPU allocate+destroy churn while the user is
    // dragging non-dimension parameters (scale, octaves, gain, …).
    const outputTexture = reusableTexture(device, ctx.previousOutput?.texture, {
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // Params: scale vec2 (8B aligned) + octaves, lacunarity, gain, seed
    // (4 × 4B = 16B) = 24B. Pad to 32 for the 16-byte uniform minimum.
    const uniformData = new Float32Array(8);
    uniformData[0] = scale[0];
    uniformData[1] = scale[1];
    uniformData[2] = inputs.octaves as number;
    uniformData[3] = inputs.lacunarity as number;
    uniformData[4] = inputs.gain as number;
    uniformData[5] = inputs.seed as number;

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
