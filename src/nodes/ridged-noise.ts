import type { NodeDef } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import { requireDevice, reusableTexture } from '../core/resources.js';
import shader from './ridged-noise.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

// Ridged fBm — same lattice/wrap/uniform layout as core/perlin, but the
// inner fBm sum uses `(1 - abs(perlin))²` per octave and weights each
// octave by the previous one (Musgrave's ridged multifractal). Produces
// sharp creases instead of soft hills — perfect for mountain spines,
// rock-fracture patterns, dry-riverbed networks (inverted).
export const ridgedNoiseNode: NodeDef = {
  id: 'core/ridged-noise',
  category: 'Texture/Noise',
  inputs: [
    {
      name: 'scale',
      type: 'Vec2',
      default: [4, 4],
      description: 'tiling frequency per axis. Integers only — fractional periods would break tileability and get rounded',
    },
    { name: 'octaves', type: 'Int', default: 5 },
    { name: 'lacunarity', type: 'Float', default: 2 },
    { name: 'gain', type: 'Float', default: 0.5 },
    { name: 'seed', type: 'Float', default: 0 },
    { name: 'resolution', type: 'Int', default: 512 },
  ],
  outputs: [{ name: 'texture', type: 'Texture2D' }],
  evaluate(ctx, inputs): { texture: Texture2DValue } {
    const device = requireDevice(ctx);
    const resolution = inputs.resolution as number;

    const rawScale = inputs.scale as number | [number, number];
    const scale: [number, number] =
      typeof rawScale === 'number' ? [rawScale, rawScale] : rawScale;

    // Reuse the previously-allocated texture when dims+format are
    // unchanged — same texture object, new contents rendered in.
    const outputTexture = reusableTexture(device, ctx.previousOutput?.texture, {
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // Params layout matches core/perlin: scale vec2 (8B) + octaves,
    // lacunarity, gain, seed (4 × 4B = 16B) = 24B padded to 32 to meet
    // the 16-byte uniform minimum.
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
