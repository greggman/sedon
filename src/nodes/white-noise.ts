import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { ShaderStage, getPipelineWithLayout, getShaderModule } from '../render/gpu-cache.js';
import shader from './white-noise.wgsl';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'white-noise-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const whiteNoiseNode: NodeDef = {
  id: 'tex/white-noise',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'color_a',
      type: 'Color',
      default: [0, 0, 0, 1],
      description: 'colour at noise value 0',
    },
    {
      name: 'color_b',
      type: 'Color',
      default: [1, 1, 1, 1],
      description: 'colour at noise value 1',
    },
    {
      name: 'monochrome',
      type: 'Int',
      default: 1,
      description: 'whether all RGB channels share one noise value or get independent values',
      enumOptions: [
        { value: 1, label: 'monochrome' },
        { value: 0, label: 'RGB' },
      ],
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0,
      description: 'changes the hash; same seed = same pattern. Drive from [anim/time](../../anim/time) for animated TV-static',
    },
    {
      name: 'resolution',
      type: 'Int',
      default: 512,
      min: 1,
      description: 'output texture width and height in pixels. The noise hashes per-pixel, so higher resolution = finer grain',
    },
  ],
  outputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'per-pixel uncorrelated random values mapped from color_a to color_b',
    },
  ],
  doc: {
    summary: 'Per-pixel uncorrelated random noise — TV static, fine-grain dither, hash source.',
    description: `
Distinct from [tex/perlin](../../tex/perlin) / [tex/worley](../../tex/worley)
— those produce SMOOTH structured noise. This one produces UNCORRELATED
random per pixel: each output pixel hashes its integer coordinate
independently. Used for:

- TV-static / film-grain overlays (combine with [tex/blend](../../tex/blend)
  in screen or add mode at low factor)
- Dithering / breaking up banding in smooth gradients
- A starting point for stippling effects — feed into
  [tex/threshold](../../tex/threshold) for hard binary noise

Same \`seed\` = same pattern. Drive seed from [anim/time](../../anim/time)
to get classic flickering TV static.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'tex/white-noise', {
        id: 'wn',
        position: { x: 0, y: 0 },
        inputValues: {
          color_a: [0, 0, 0, 1],
          color_b: [1, 1, 1, 1],
          monochrome: 1,
          seed: 0,
          resolution: 256,
        },
      });
      return { graph: g, rootNodeId: 'wn' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const a = inputs.color_a as [number, number, number, number];
    const b = inputs.color_b as [number, number, number, number];
    const seed = inputs.seed as number;
    const monochrome = inputs.monochrome as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'white-noise-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec4 a (16) + vec4 b (16) + f32 seed (4) + f32 mono (4) +
    // f32 res (4) + pad (4) = 48 bytes.
    const uniformData = new Float32Array(12);
    uniformData.set(a, 0);
    uniformData.set(b, 4);
    uniformData[8] = seed;
    uniformData[9] = monochrome;
    uniformData[10] = resolution;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const module = getShaderModule(device, shader);
    const { bindGroupLayout: bgl, pipeline } = getPipelineWithLayout(
      device,
      UNIFORM_FRAG_BGL,
      (layout) => ({
        label: 'white-noise-pipeline',
        layout,
        vertex: { module },
        fragment: { module, targets: [{ format: TEXTURE_FORMAT }] },
      }),
    );

    const bindGroup = reusableBindGroup(
      device,
      prev?.__bindGroup,
      bgl,
      [uniformBuffer],
      () => [{ binding: 0, resource: uniformBuffer }],
    );

    const encoder = device.createCommandEncoder({ label: 'white-noise-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'white-noise-pass',
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
