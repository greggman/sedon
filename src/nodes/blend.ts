import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { getRenderPipeline, getSampler, getShaderModule } from '../render/gpu-cache.js';
import shader from './blend.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const blendNode: NodeDef = {
  id: 'core/blend',
  category: 'Texture/Filters',
  inputs: [
    {
      name: 'a',
      type: 'Texture2D',
      description: 'first input texture. For mix mode, this is the value at factor = 0',
    },
    {
      name: 'b',
      type: 'Texture2D',
      description: 'second input texture. For mix mode, this is the value at factor = 1',
    },
    {
      name: 'factor',
      type: 'Float',
      default: 0.5,
      description: 'blend amount. Meaning depends on mode: mix uses it as a linear lerp factor; add/multiply/screen treat it as a per-pixel strength multiplier on b',
    },
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
    {
      name: 'resolution',
      type: 'Int',
      default: 512,
      description: 'output texture width and height in pixels',
    },
  ],
  outputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'the per-pixel result of combining a and b under the chosen mode',
    },
  ],
  doc: {
    summary: 'Combine two textures pixelwise under a chosen blend mode.',
    description: `
Blend modes: mix (linear interpolation), add (a + factor·b), multiply
(a · ((1−factor) + factor·b)), screen (1 − (1−a)·(1−factor·b)). The mix mode
is what most users want by default; multiply is the classic "mask" operation
(use a = colour, b = greyscale mask); add brightens; screen brightens while
staying soft at the top end.

Inputs are sampled with linear filtering and repeat addressing, so blending
two textures of different resolutions still works — the smaller one tiles to
cover the output. For per-pixel blending where the strength varies across
the texture, reach for [core/blend-mask](../../core/blend-mask) instead.
`,
    sampleGraph: () => {
      // Perlin (smooth fbm) blended with Worley (cellular distance) so
      // the mix is visually obvious — pure noise on one side, cell
      // borders on the other, the result wears both signatures.
      const g = createGraph();
      const a = addNode(g, 'core/perlin', {
        id: 'a',
        position: { x: 0, y: 0 },
        inputValues: { scale: [4, 4], octaves: 4, lacunarity: 2, gain: 0.5, seed: 0, resolution: 512 },
      });
      const b = addNode(g, 'core/worley', {
        id: 'b',
        position: { x: 0, y: 220 },
        inputValues: { scale: 8, octaves: 1, lacunarity: 2, gain: 0.5, seed: 0, resolution: 512 },
      });
      const blend = addNode(g, 'core/blend', {
        id: 'blend',
        position: { x: 280, y: 110 },
        inputValues: { factor: 0.5, mode: 0, resolution: 512 },
      });
      addEdge(g, { node: a.id, socket: 'texture' }, { node: blend.id, socket: 'a' });
      addEdge(g, { node: b.id, socket: 'texture' }, { node: blend.id, socket: 'b' });
      return { graph: g, rootNodeId: 'blend' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const a = inputs.a as Texture2DValue;
    const b = inputs.b as Texture2DValue;
    const factor = inputs.factor as number;
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

    const bindGroup = reusableBindGroup(
      device,
      prev?.__bindGroup,
      pipeline.getBindGroupLayout(0),
      [uniformBuffer, a.texture, b.texture, sampler],
      () => [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: a.texture },
        { binding: 2, resource: b.texture },
        { binding: 3, resource: sampler },
      ],
    );

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: out.texture,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        },
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
