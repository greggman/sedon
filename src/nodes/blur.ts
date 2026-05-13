import type { NodeDef } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import { requireDevice, reusableTexture } from '../core/resources.js';
import shader from './blur.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

// Separable Gaussian blur. Two passes (H then V) over a 1D kernel of
// (2*radius + 1) taps. Cheap enough to use freely in compositing
// chains; useful for halos / soft shadows / softening procedural
// patterns before they get gradient-mapped.
export const blurNode: NodeDef = {
  id: 'core/blur',
  category: 'Texture/Filters',
  inputs: [
    { name: 'texture', type: 'Texture2D' },
    {
      name: 'radius',
      type: 'Float',
      default: 8,
      description: 'Gaussian half-width in pixels at the output resolution. 0 disables the blur.',
    },
    { name: 'resolution', type: 'Int', default: 512 },
  ],
  outputs: [{ name: 'texture', type: 'Texture2D' }],
  evaluate(ctx, inputs): { texture: Texture2DValue } {
    const device = requireDevice(ctx);
    const src = inputs.texture as Texture2DValue;
    const radius = inputs.radius as number;
    const resolution = inputs.resolution as number;

    const usage =
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC;

    // Output texture is reused via the eval cache. The intermediate is
    // transient (one eval's worth) and just gets recreated each call
    // — it could be pooled if blur turns into a hot path.
    const prev = ctx.previousOutput as { texture?: Texture2DValue } | undefined;
    const outTexture = reusableTexture(device, prev?.texture, {
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage,
    });
    const intermediate = device.createTexture({
      size: [resolution, resolution],
      format: TEXTURE_FORMAT,
      usage,
    });
    const intermediateView = intermediate.createView();

    // Uniform buffer: vec2 texel_size, vec2 direction, f32 radius +
    // 3 f32 pad → 32 bytes. We write it once per pass, swapping the
    // direction between the two draws.
    const uniformData = new Float32Array(8);
    uniformData[0] = 1 / resolution;
    uniformData[1] = 1 / resolution;
    uniformData[4] = radius;
    const uniformBuffer = device.createBuffer({
      size: uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const module = device.createShaderModule({ code: shader });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module },
      fragment: { module, targets: [{ format: TEXTURE_FORMAT }] },
    });

    const writeUniform = (dx: number, dy: number) => {
      uniformData[2] = dx;
      uniformData[3] = dy;
      device.queue.writeBuffer(uniformBuffer, 0, uniformData as BufferSource);
    };

    // Pass 1: horizontal (src → intermediate).
    writeUniform(1, 0);
    {
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
            view: intermediateView,
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
    }

    // Pass 2: vertical (intermediate → output). Separate submit so the
    // intermediate write is visible to the second pass without
    // requiring a memory barrier (WebGPU's queue submission boundary
    // already orders them).
    writeUniform(0, 1);
    {
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: intermediateView },
          { binding: 2, resource: sampler },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: outTexture.view,
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
    }

    intermediate.destroy();
    return { texture: outTexture };
  },
};
