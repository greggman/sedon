import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { getRenderPipeline, getSampler, getShaderModule } from '../render/gpu-cache.js';
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
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __intermediate?: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroupH?: ReusableBindGroup;
    __bindGroupV?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const src = inputs.texture as Texture2DValue;
    const radius = inputs.radius as number;
    const resolution = inputs.resolution as number;

    const usage =
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC;

    // Output + intermediate textures are both reused via the eval cache.
    // The intermediate is stashed as a private field on the output so
    // the next eval's previousOutput exposes it for reuse.
    const prev = ctx.previousOutput as
      | {
          texture?: Texture2DValue;
          __intermediate?: Texture2DValue;
          __uniformBuffer?: GPUBuffer;
          __bindGroupH?: ReusableBindGroup;
          __bindGroupV?: ReusableBindGroup;
        }
      | undefined;
    const outTexture = reusableTexture(device, prev?.texture, {
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage,
    });
    const intermediate = reusableTexture(device, prev?.__intermediate, {
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage,
    });
    const intermediateView = intermediate.texture;

    // Uniform buffer: vec2 texel_size, vec2 direction, f32 radius +
    // 3 f32 pad → 32 bytes. We write it once per pass, swapping the
    // direction between the two draws.
    const uniformData = new Float32Array(8);
    uniformData[0] = 1 / resolution;
    uniformData[1] = 1 / resolution;
    uniformData[4] = radius;
    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const sampler = getSampler(device, {
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const module = getShaderModule(device, shader);
    const pipeline = getRenderPipeline(device, {
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
    const bindGroupH = reusableBindGroup(
      device,
      prev?.__bindGroupH,
      pipeline.getBindGroupLayout(0),
      [uniformBuffer, src.texture, sampler],
      () => [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: src.texture },
        { binding: 2, resource: sampler },
      ],
    );
    {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: intermediateView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroupH.bindGroup);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
    }

    // Pass 2: vertical (intermediate → output). Separate submit so the
    // intermediate write is visible to the second pass without
    // requiring a memory barrier (WebGPU's queue submission boundary
    // already orders them).
    writeUniform(0, 1);
    const bindGroupV = reusableBindGroup(
      device,
      prev?.__bindGroupV,
      pipeline.getBindGroupLayout(0),
      [uniformBuffer, intermediateView, sampler],
      () => [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: intermediateView },
        { binding: 2, resource: sampler },
      ],
    );
    {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: outTexture.texture,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroupV.bindGroup);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
    }

    // intermediate stays alive in the returned outputs so the next
    // eval can reuse it via prev.__intermediate; the cache sweep will
    // destroy it when this node's outputs are evicted.
    return {
      texture: outTexture,
      __intermediate: intermediate,
      __uniformBuffer: uniformBuffer,
      __bindGroupH: bindGroupH,
      __bindGroupV: bindGroupV,
    };
  },
};
