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
import shader from './invert.wgsl';

const UNIFORM_TEX_SAMP_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'invert-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const invertNode: NodeDef = {
  id: 'tex/invert',
  category: 'Texture/Filters',
  inputs: [
    {
      name: 'input',
      type: 'Texture2D',
      description: 'source texture to invert',
    },
    {
      name: 'invert_alpha',
      type: 'Int',
      default: 0,
      description: 'whether to invert the alpha channel too',
      enumOptions: [
        { value: 0, label: 'RGB only (preserve alpha)' },
        { value: 1, label: 'RGBA' },
      ],
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
      description: 'the input with `1 - rgb` per channel; alpha optionally inverted too',
    },
  ],
  doc: {
    summary: 'Invert a texture\'s colours (1 − rgb per channel).',
    description: `
The classic photo-negative. Useful for:

- flipping a mask's polarity without rewiring the upstream signal
- turning a dark-on-light pattern into light-on-dark
- preprocessing for [tex/threshold](../../tex/threshold) when the source's
  bright/dark sense is the opposite of what you want

By default alpha passes through unchanged, since inverting alpha usually
flips a transparent area into opaque garbage. Flip \`invert_alpha\` if
you actually want a transparency invert.
`,
    sampleGraph: () => {
      const g = createGraph();
      const src = addNode(g, 'tex/perlin', {
        id: 'src',
        position: { x: 0, y: 0 },
        inputValues: { scale: [4, 4], octaves: 4, lacunarity: 2, gain: 0.5, seed: 0, resolution: 512 },
      });
      const inv = addNode(g, 'tex/invert', {
        id: 'inv',
        position: { x: 280, y: 0 },
        inputValues: { invert_alpha: 0, resolution: 512 },
      });
      addEdge(g, { node: src.id, socket: 'texture' }, { node: inv.id, socket: 'input' });
      return { graph: g, rootNodeId: 'inv' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const src = inputs.input as Texture2DValue;
    const invertAlpha = inputs.invert_alpha as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'invert-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // f32 invert_alpha (4) + 3 × f32 pad = 16 bytes (one vec4 worth).
    const uniformData = new Float32Array(4);
    uniformData[0] = invertAlpha;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const sampler = getSampler(device, {
      label: 'invert-sampler',
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
        label: 'invert-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'invert-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'invert-pass',
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
