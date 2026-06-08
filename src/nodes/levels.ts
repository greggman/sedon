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
  label: 'levels-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ],
};
import shader from './levels.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

// Brightness / contrast / gamma adjustment of an input texture. Defaults are
// no-op so dropping the node in unconfigured doesn't change anything; tune
// values to tighten dynamic range, push mid-tones, etc. Useful for taming
// flat-looking procedural noise before piping it into colorize.
export const levelsNode: NodeDef = {
  id: 'core/levels',
  category: 'Texture/Filters',
  inputs: [
    {
      name: 'input',
      type: 'Texture2D',
      description: 'source texture to tone-adjust',
    },
    {
      name: 'brightness',
      type: 'Float',
      default: 0,
      description: 'additive shift; positive lightens, negative darkens',
    },
    {
      name: 'contrast',
      type: 'Float',
      default: 1,
      description: 'multiplier around mid-gray (0.5); >1 expands range (more punchy), <1 compresses (greys things out)',
    },
    {
      name: 'gamma',
      type: 'Float',
      default: 1,
      description: 'midtone curve. <1 pushes midtones brighter (lifts shadows), >1 pushes them darker (crushes shadows)',
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
      description: 'the input run through `(((rgb + brightness) − 0.5) · contrast + 0.5)^gamma`',
    },
  ],
  doc: {
    summary: 'Brightness / contrast / gamma adjustment on a texture.',
    description: `
A standard tone-adjustment trio. Brightness shifts the curve up or down;
contrast expands or compresses range around the midpoint; gamma reshapes the
midtones with a power curve. Defaults are a no-op so dropping the node in
unconfigured passes the input through unchanged.

The most common reason to reach for levels: procedural noise often comes out
flat (no extreme darks or lights), and a [core/colorize](../../core/colorize)
downstream will read muddy because the gradient only ever gets sampled near
t=0.5. Bump contrast above 1 and the noise starts using more of the gradient.
Crush gamma below 1 and the bright bits pop while the dark bits stay dark.
`,
    sampleGraph: () => {
      const g = createGraph();
      const src = addNode(g, 'core/perlin', {
        id: 'src',
        position: { x: 0, y: 0 },
        inputValues: { scale: [6, 6], octaves: 4, lacunarity: 2, gain: 0.5, seed: 0, resolution: 512 },
      });
      const lev = addNode(g, 'core/levels', {
        id: 'levels',
        position: { x: 280, y: 0 },
        inputValues: { brightness: 0, contrast: 3.5, gamma: 0.7, resolution: 512 },
      });
      addEdge(g, { node: src.id, socket: 'texture' }, { node: lev.id, socket: 'input' });
      return { graph: g, rootNodeId: 'levels' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const src = inputs.input as Texture2DValue;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'levels-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    const uniformData = new Float32Array(4);
    uniformData[0] = inputs.brightness as number;
    uniformData[1] = inputs.contrast as number;
    uniformData[2] = inputs.gamma as number;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const sampler = getSampler(device, {
      label: 'levels-sampler',
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
        label: 'levels-pipeline',
        layout,
        vertex: { module },
        fragment: { module, targets: [{ format: TEXTURE_FORMAT }] },
      }),
    );

    const bindGroup = reusableBindGroup(
      device,
      prev?.__bindGroup,
      bgl,
      [uniformBuffer, src.texture, sampler],
      () => [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: src.texture },
        { binding: 2, resource: sampler },
      ],
    );

    const encoder = device.createCommandEncoder({ label: 'levels-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'levels-pass',
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
