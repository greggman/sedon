import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { getRenderPipeline, getShaderModule } from '../render/gpu-cache.js';
import shader from './grass-blades.wgsl';

// Procedural blade-card texture for core/grass. Renders tapered,
// leaning blades with an ALPHA SILHOUETTE so the grass shader's
// alpha-cut carves out individual leaves (vs the solid quads you get
// feeding it a plain texture). RGB is a base→tip gradient; the grass
// node can multiply its own tint on top (set that tint near-white to
// use these colours directly).
const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const grassBladesNode: NodeDef = {
  id: 'core/grass-blades',
  category: 'Texture/Generators',
  inputs: [
    { name: 'bladeCount', type: 'Int', default: 5 },
    { name: 'baseColor', type: 'Color', default: [0.12, 0.3, 0.08, 1] },
    { name: 'tipColor', type: 'Color', default: [0.55, 0.78, 0.32, 1] },
    { name: 'width', type: 'Float', default: 1, description: 'Blade width multiplier.' },
    { name: 'lean', type: 'Float', default: 0.15, description: 'How far blade tips sweep sideways.' },
    { name: 'seed', type: 'Float', default: 0 },
    { name: 'resolution', type: 'Int', default: 256 },
  ],
  outputs: [{ name: 'texture', type: 'Texture2D' }],
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const baseColor = inputs.baseColor as [number, number, number, number];
    const tipColor = inputs.tipColor as [number, number, number, number];
    const bladeCount = inputs.bladeCount as number;
    const width = inputs.width as number;
    const lean = inputs.lean as number;
    const seed = inputs.seed as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // Params: baseColor(4) + tipColor(4) + cfg(bladeCount,width,lean,seed)
    const uniformData = new Float32Array(12);
    uniformData.set(baseColor, 0);
    uniformData.set(tipColor, 4);
    uniformData[8] = bladeCount;
    uniformData[9] = width;
    uniformData[10] = lean;
    uniformData[11] = seed;

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

    const bindGroup = reusableBindGroup(
      device,
      prev?.__bindGroup,
      pipeline.getBindGroupLayout(0),
      [uniformBuffer],
      () => [{ binding: 0, resource: uniformBuffer }],
    );

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: out.texture, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup.bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);

    return { texture: out, __uniformBuffer: uniformBuffer, __bindGroup: bindGroup };
  },
};
