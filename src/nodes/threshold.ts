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
import shader from './threshold.wgsl';

const UNIFORM_TEX_SAMP_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'threshold-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const thresholdNode: NodeDef = {
  id: 'tex/threshold',
  category: 'Texture/Filters',
  inputs: [
    {
      name: 'input',
      type: 'Texture2D',
      description: 'source texture to threshold',
    },
    {
      name: 'threshold',
      type: 'Float',
      default: 0.5,
      min: 0,
      max: 1,
      description: 'cutoff value. Pixels brighter than this become high_color; darker pixels become low_color',
    },
    {
      name: 'softness',
      type: 'Float',
      default: 0,
      min: 0,
      max: 0.5,
      description: 'half-width of the smoothstep band around `threshold`. 0 = pure binary cutoff (aliased edges); 0.02 = AA-style; 0.1+ = soft blended transition',
    },
    {
      name: 'channel',
      type: 'Int',
      default: 0,
      description: 'which channel of the input drives the threshold test',
      enumOptions: [
        { value: 0, label: 'luminance (Rec. 709)' },
        { value: 1, label: 'red' },
        { value: 2, label: 'alpha' },
      ],
    },
    {
      name: 'low_color',
      type: 'Color',
      default: [0, 0, 0, 1],
      description: 'output colour for pixels below the threshold',
    },
    {
      name: 'high_color',
      type: 'Color',
      default: [1, 1, 1, 1],
      description: 'output colour for pixels above the threshold',
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
      description: 'a binary (or softly-banded) mask: low_color where input < threshold, high_color where input > threshold',
    },
  ],
  doc: {
    summary: 'Binary cutoff with optional soft band — make a mask from any texture.',
    description: `
The mask-builder. Feed in noise, a gradient, or any greyscale signal, set
where to slice it, and get a clean 2-colour mask.

Common pairings:

- [tex/perlin](../../tex/perlin) → threshold → cloud / island silhouette mask
- [tex/worley](../../tex/worley) → threshold → cellular / cracked-leather mask
- [tex/white-noise](../../tex/white-noise) → threshold → hard stipple pattern
- [tex/linear-gradient](../../tex/linear-gradient) → threshold → hard
  horizon line or wipe-in transition

\`softness\` controls anti-aliasing of the edge; \`channel\` lets you
threshold a colour image's red or alpha rather than its luminance.
`,
    sampleGraph: () => {
      const g = createGraph();
      const noise = addNode(g, 'tex/perlin', {
        id: 'src',
        position: { x: 0, y: 0 },
        inputValues: { scale: [4, 4], octaves: 4, lacunarity: 2, gain: 0.5, seed: 0, resolution: 512 },
      });
      const thr = addNode(g, 'tex/threshold', {
        id: 'thr',
        position: { x: 280, y: 0 },
        inputValues: {
          threshold: 0.5,
          softness: 0.02,
          channel: 0,
          low_color: [0, 0, 0, 1],
          high_color: [1, 1, 1, 1],
          resolution: 512,
        },
      });
      addEdge(g, { node: noise.id, socket: 'texture' }, { node: thr.id, socket: 'input' });
      return { graph: g, rootNodeId: 'thr' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const src = inputs.input as Texture2DValue;
    const threshold = inputs.threshold as number;
    const softness = inputs.softness as number;
    const channel = inputs.channel as number;
    const low = inputs.low_color as [number, number, number, number];
    const high = inputs.high_color as [number, number, number, number];
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'threshold-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec4 low (16) + vec4 high (16) + f32 threshold (4) + f32 softness (4) +
    // f32 channel (4) + pad (4) = 48 bytes.
    const uniformData = new Float32Array(12);
    uniformData.set(low, 0);
    uniformData.set(high, 4);
    uniformData[8] = threshold;
    uniformData[9] = softness;
    uniformData[10] = channel;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const sampler = getSampler(device, {
      label: 'threshold-sampler',
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
        label: 'threshold-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'threshold-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'threshold-pass',
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
