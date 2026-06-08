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

const UNIFORM_2TEX_SAMP_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'warp-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 3, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ],
};
import shader from './warp.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const warpNode: NodeDef = {
  id: 'core/warp',
  category: 'Texture/Filters',
  inputs: [
    {
      name: 'input',
      type: 'Texture2D',
      description: 'the texture being warped — its UVs get offset before sampling',
    },
    {
      name: 'warp',
      type: 'Texture2D',
      description: 'a second texture whose R/G channels supply the per-pixel UV offsets. Typically a noise texture (Perlin / Worley); the difference between the value and 0.5 picks the offset direction',
    },
    {
      name: 'intensity',
      type: 'Float',
      default: 0.1,
      description: 'how far to shift the UVs (in UV units). 0 = no warp; 0.1 = subtle shimmer; 0.3+ = melted/molten look',
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
      description: 'the input texture, sampled at UVs offset by `(warp.r − 0.5, warp.g − 0.5) · intensity` per pixel',
    },
  ],
  doc: {
    summary: 'Distort a texture by offsetting its UVs with a second texture.',
    description: `
For each output pixel, samples the warp texture's R/G channels at the
current UV, converts them to a signed offset (value − 0.5), scales by
\`intensity\`, and reads the input texture at the offset UV. The result is
the input "pushed around" by the warp.

Use to break the regularity of procedural noise
([core/perlin](../../core/perlin) warped by another perlin gives that
classic flame/marble look), to add wind motion to a static texture by
modulating intensity over time, or to roughen the edges of a hand-built
[core/grid](../../core/grid) / mask so it doesn't read so mechanical.
`,
    sampleGraph: () => {
      const g = createGraph();
      const src = addNode(g, 'core/grid', {
        id: 'src',
        position: { x: 0, y: 0 },
        inputValues: {
          fg: [0.08, 0.08, 0.12, 1],
          bg: [0.88, 0.88, 0.92, 1],
          divisions: [8, 8],
          line_width: 0.05,
          resolution: 512,
        },
      });
      const warpTex = addNode(g, 'core/perlin', {
        id: 'warpTex',
        position: { x: 0, y: 220 },
        inputValues: { scale: [3, 3], octaves: 3, lacunarity: 2, gain: 0.5, seed: 0, resolution: 512 },
      });
      const warp = addNode(g, 'core/warp', {
        id: 'warp',
        position: { x: 280, y: 110 },
        inputValues: { intensity: 0.12, resolution: 512 },
      });
      addEdge(g, { node: src.id, socket: 'texture' }, { node: warp.id, socket: 'input' });
      addEdge(g, { node: warpTex.id, socket: 'texture' }, { node: warp.id, socket: 'warp' });
      return { graph: g, rootNodeId: 'warp' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const src = inputs.input as Texture2DValue;
    const warp = inputs.warp as Texture2DValue;
    const intensity = inputs.intensity as number;
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
    uniformData[0] = intensity;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const sampler = getSampler(device, {
      label: 'warp-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });

    const module = getShaderModule(device, shader);
    const { bindGroupLayout: bgl, pipeline } = getPipelineWithLayout(
      device,
      UNIFORM_2TEX_SAMP_BGL,
      (layout) => ({
        label: 'warp-pipeline',
        layout,
        vertex: { module },
        fragment: { module, targets: [{ format: TEXTURE_FORMAT }] },
      }),
    );

    const bindGroup = reusableBindGroup(
      device,
      prev?.__bindGroup,
      bgl,
      [uniformBuffer, src.texture, warp.texture, sampler],
      () => [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: src.texture },
        { binding: 2, resource: warp.texture },
        { binding: 3, resource: sampler },
      ],
    );

    const encoder = device.createCommandEncoder({ label: 'warp-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'warp-pass',
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
