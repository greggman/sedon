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
import shader from './edge-detect.wgsl';

const UNIFORM_TEX_SAMP_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'edge-detect-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const edgeDetectNode: NodeDef = {
  id: 'tex/edge-detect',
  category: 'Texture/Filters',
  inputs: [
    {
      name: 'input',
      type: 'Texture2D',
      description: 'source texture to find edges in. Operates on Rec. 709 luminance',
    },
    {
      name: 'intensity',
      type: 'Float',
      default: 1,
      min: 0,
      description: 'edge strength multiplier. > 1 amplifies; useful when the input has soft transitions',
    },
    {
      name: 'mode',
      type: 'Int',
      default: 0,
      description: 'output format',
      enumOptions: [
        { value: 0, label: 'magnitude (greyscale lerp between bg and edge colour)' },
        { value: 1, label: 'signed gradient (rg = dx, dy; usable as normal-map direction)' },
      ],
    },
    {
      name: 'edge_color',
      type: 'Color',
      default: [1, 1, 1, 1],
      description: 'colour used at full edge intensity (magnitude mode)',
    },
    {
      name: 'bg_color',
      type: 'Color',
      default: [0, 0, 0, 1],
      description: 'colour used where there is no edge (magnitude mode)',
    },
    {
      name: 'resolution',
      type: 'Int',
      default: 512,
      min: 1,
      description: 'output texture width and height in pixels. Drives the Sobel sampling step',
    },
  ],
  outputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'a Sobel edge map of the input',
    },
  ],
  doc: {
    summary: 'Sobel edge detection over an input texture\'s luminance.',
    description: `
A classic 3×3 Sobel filter. For every output pixel it samples the 8
neighbours of the input, computes \`gx\` and \`gy\` gradients of the
luminance, and outputs either:

- **magnitude** mode: \`sqrt(gx² + gy²)\` lerped between \`bg_color\`
  and \`edge_color\`. The expected use — a black-on-white edge mask
  for further processing.
- **signed gradient** mode: \`(gx, gy)\` packed into the red/green
  channels with blue = 0.5. Drop into a normal-map consumer directly,
  or hand off to [tex/normal-from-height](../../tex/normal-from-height)
  upstream for a more controlled normal.

Useful for outlining shapes, building toon-shader edge masks, or
extracting a sketchbook look from a noisier source.
`,
    sampleGraph: () => {
      const g = createGraph();
      const src = addNode(g, 'tex/worley', {
        id: 'src',
        position: { x: 0, y: 0 },
        inputValues: { scale: 8, octaves: 1, lacunarity: 2, gain: 0.5, seed: 0, resolution: 512 },
      });
      const ed = addNode(g, 'tex/edge-detect', {
        id: 'ed',
        position: { x: 280, y: 0 },
        inputValues: {
          intensity: 2,
          mode: 0,
          edge_color: [1, 1, 1, 1],
          bg_color: [0, 0, 0, 1],
          resolution: 512,
        },
      });
      addEdge(g, { node: src.id, socket: 'texture' }, { node: ed.id, socket: 'input' });
      return { graph: g, rootNodeId: 'ed' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const src = inputs.input as Texture2DValue;
    const intensity = inputs.intensity as number;
    const mode = inputs.mode as number;
    const edge = inputs.edge_color as [number, number, number, number];
    const bg = inputs.bg_color as [number, number, number, number];
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'edge-detect-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec2 pixel_size (8) + f32 intensity (4) + f32 mode (4) +
    // vec4 edge (16) + vec4 bg (16) = 48 bytes.
    const uniformData = new Float32Array(12);
    uniformData[0] = 1 / resolution;
    uniformData[1] = 1 / resolution;
    uniformData[2] = intensity;
    uniformData[3] = mode;
    uniformData.set(edge, 4);
    uniformData.set(bg, 8);

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const sampler = getSampler(device, {
      label: 'edge-detect-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const module = getShaderModule(device, shader);
    const { bindGroupLayout: bgl, pipeline } = getPipelineWithLayout(
      device,
      UNIFORM_TEX_SAMP_BGL,
      (layout) => ({
        label: 'edge-detect-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'edge-detect-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'edge-detect-pass',
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
