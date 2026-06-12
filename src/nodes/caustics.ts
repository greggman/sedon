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
import shader from './caustics.wgsl';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'caustics-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const causticsNode: NodeDef = {
  id: 'tex/caustics',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'dark_color',
      type: 'Color',
      default: [0.05, 0.08, 0.18, 1],
      description: 'background colour between caustic filaments (typically a dark water blue)',
    },
    {
      name: 'bright_color',
      type: 'Color',
      default: [0.85, 0.95, 1.0, 1],
      description: 'colour of the bright caustic filaments (typically a near-white)',
    },
    {
      name: 'scale',
      type: 'Float',
      default: 6,
      min: 0.1,
      description: 'noise scale. Lower = broad, slow-moving cells; higher = denser net',
    },
    {
      name: 'octaves',
      type: 'Int',
      default: 3,
      min: 1,
      max: 8,
      description: 'fbm octaves on the warp field. Higher = more detail (and more shader work; capped at 8 inside the shader); 3 is a good baseline',
    },
    {
      name: 'intensity',
      type: 'Float',
      default: 2,
      min: 0,
      description: 'how many bright crossings per noise period. Higher = denser, finer caustic net',
    },
    {
      name: 'sharpness',
      type: 'Float',
      default: 1.5,
      min: 0.001,
      description: 'power on the result. 1 = soft; 2–4 = sharp filaments; higher = razor-thin glints',
    },
    {
      name: 'flow',
      type: 'Float',
      default: 0.5,
      min: 0,
      description: 'offset between the two interfering noise samples. 0 = smudgy bands; > 0 = the criss-crossing caustic net. Drive from [anim/time](../../anim/time) to animate flowing water caustics',
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0,
      description: 'random offset of the noise',
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
      description: 'an interfering-net pattern resembling underwater caustic light',
    },
  ],
  doc: {
    summary: 'Underwater-style caustic light — bright interference filaments on dark background.',
    description: `
The "pool floor / underwater" caustic look: two fractal-noise fields
sampled at slightly offset positions are each passed through \`abs(sin(...))\`,
then multiplied. The product is bright only where BOTH noise fields are at
a zero crossing — that's where two ripples interfere — giving the
characteristic criss-crossing filament pattern.

Drive \`flow\` from [anim/time](../../anim/time) to animate flowing water
caustics. Add the result to a base texture via [tex/blend](../../tex/blend)
in screen or add mode for a "sunlit through water" lighting effect.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'tex/caustics', {
        id: 'c',
        position: { x: 0, y: 0 },
        inputValues: {
          dark_color: [0.05, 0.08, 0.18, 1],
          bright_color: [0.85, 0.95, 1.0, 1],
          scale: 6,
          octaves: 3,
          intensity: 2,
          sharpness: 1.5,
          flow: 0.5,
          seed: 0,
          resolution: 512,
        },
      });
      return { graph: g, rootNodeId: 'c' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const dark = inputs.dark_color as [number, number, number, number];
    const bright = inputs.bright_color as [number, number, number, number];
    const scale = inputs.scale as number;
    const octaves = inputs.octaves as number;
    const intensity = inputs.intensity as number;
    const sharpness = inputs.sharpness as number;
    const flow = inputs.flow as number;
    const seed = inputs.seed as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'caustics-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec4 dark (16) + vec4 bright (16) + 6 × f32 (24) + 2 pad (8) = 64 bytes.
    const uniformData = new Float32Array(16);
    uniformData.set(dark, 0);
    uniformData.set(bright, 4);
    uniformData[8] = scale;
    uniformData[9] = octaves;
    uniformData[10] = intensity;
    uniformData[11] = sharpness;
    uniformData[12] = flow;
    uniformData[13] = seed;

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
        label: 'caustics-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'caustics-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'caustics-pass',
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
