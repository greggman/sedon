import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { ShaderStage, getPipelineWithLayout, getSampler, getShaderModule } from '../render/gpu-cache.js';

const UNIFORM_TEX_SAMP_BGL: GPUBindGroupLayoutDescriptor = {
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ],
};
import shader from './slope-from-height.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

// Convert a heightfield texture into a grayscale slope mask via the
// magnitude of its gradient. Black = flat, white = steep. Drop into a
// blend node as the t-factor to splat-paint terrain (grass on flats, rock
// on steeps), or into cloud-step → cloud-multiply for per-point distribution
// gating that mirrors what cloud-slope does for point clouds.
export const slopeFromHeightNode: NodeDef = {
  id: 'core/slope-from-height',
  category: 'Texture/Filters',
  inputs: [
    {
      name: 'height',
      type: 'Texture2D',
      description: 'greyscale heightfield: the R channel is read as height',
    },
    {
      name: 'strength',
      type: 'Float',
      default: 4,
      description: 'gradient multiplier; larger values make more area read as steep (more white pixels in the output)',
    },
    {
      name: 'invert',
      type: 'Bool',
      default: false,
      description: 'output flatness (white on flats) instead of steepness — use as a grass-density mask, foam mask, or anywhere flats should be marked',
    },
    {
      name: 'resolution',
      type: 'Int',
      default: 512,
      min: 1,
      description: 'output texture width and height in pixels',
    },
  ],
  outputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'greyscale slope mask: black where the height is flat, white where it changes fast (steep). With invert=true the polarity is flipped',
    },
  ],
  doc: {
    summary: 'Heightfield → greyscale slope mask (steeper = brighter).',
    description: `
Samples the input height's gradient magnitude — a central-difference filter
that reads "how fast does the height change here?" — and writes it directly
as a greyscale mask. Flat areas → black; steep areas → white.

The killer use is splat-painting terrain. Wire a heightfield in, get a
slope mask out, drop it into a [core/blend-mask](../../core/blend-mask) as
the \`mask\` input with grass for \`a\` and rock for \`b\`, and you get
grass on the flats and rock on the steeps with a smooth gradient in
between. With invert=true you get the opposite — useful as a "grow grass
here" or "spawn foam here" mask.
`,
    sampleGraph: () => {
      const g = createGraph();
      const src = addNode(g, 'core/ridged-noise', {
        id: 'height',
        position: { x: 0, y: 0 },
        inputValues: { scale: [4, 4], octaves: 4, lacunarity: 2, gain: -0.5, seed: 0, resolution: 512 },
      });
      const sfh = addNode(g, 'core/slope-from-height', {
        id: 'slope',
        position: { x: 280, y: 0 },
        inputValues: { strength: 4, invert: false, resolution: 512 },
      });
      addEdge(g, { node: src.id, socket: 'texture' }, { node: sfh.id, socket: 'height' });
      return { graph: g, rootNodeId: 'slope' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const height = inputs.height as Texture2DValue;
    const strength = inputs.strength as number;
    const invert = inputs.invert as boolean;
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

    const uniformData = new Float32Array(4);
    uniformData[0] = strength;
    uniformData[1] = invert ? 1 : 0;

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
    const { bindGroupLayout: bgl, pipeline } = getPipelineWithLayout(
      device,
      UNIFORM_TEX_SAMP_BGL,
      (layout) => ({
        layout,
        vertex: { module },
        fragment: { module, targets: [{ format: TEXTURE_FORMAT }] },
      }),
    );

    const bindGroup = reusableBindGroup(
      device,
      prev?.__bindGroup,
      bgl,
      [uniformBuffer, height.texture, sampler],
      () => [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: height.texture },
        { binding: 2, resource: sampler },
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
