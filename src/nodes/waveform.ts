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
import shader from './waveform.wgsl';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'waveform-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const waveformNode: NodeDef = {
  id: 'tex/waveform',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'color_a',
      type: 'Color',
      default: [0.05, 0.07, 0.12, 1],
      description: 'colour at the trough of the wave',
    },
    {
      name: 'color_b',
      type: 'Color',
      default: [0.95, 0.95, 0.95, 1],
      description: 'colour at the peak of the wave',
    },
    {
      name: 'waveform',
      type: 'Int',
      default: 0,
      description: 'shape of the wave function',
      enumOptions: [
        { value: 0, label: 'sine (smooth)' },
        { value: 1, label: 'triangle' },
        { value: 2, label: 'sawtooth (rising)' },
        { value: 3, label: 'square (hard stripes)' },
        { value: 4, label: 'reverse sawtooth (falling)' },
      ],
    },
    {
      name: 'frequency',
      type: 'Float',
      default: 8,
      min: 0,
      description: 'periods per UV unit along the wave direction. 1 = one cycle across the texture; 8 = eight cycles',
    },
    {
      name: 'angle',
      type: 'Float',
      default: 0,
      description: 'wave direction in degrees. 0 = horizontal sweep (vertical stripes); 90 = vertical sweep (horizontal stripes); 45 = diagonal',
    },
    {
      name: 'phase',
      type: 'Float',
      default: 0,
      description: 'phase shift in turns (1 = one full cycle). Drive from [anim/time](../../anim/time) to animate scrolling stripes',
    },
    {
      name: 'duty',
      type: 'Float',
      default: 0.5,
      min: 0.001,
      max: 0.999,
      description: 'duty cycle. For square: width of color_b portion. For triangle: where the peak sits in the period. For sine/sawtooth: ignored',
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
      description: 'directional stripes from color_a to color_b shaped by the chosen waveform',
    },
  ],
  doc: {
    summary: 'Directional stripe pattern — sine / triangle / sawtooth / square / reverse sawtooth.',
    description: `
A signal generator for textures: pick a wave shape, frequency, and direction,
and get directional stripes. Distinct from [tex/dashed-stripe](../../tex/dashed-stripe)
(which authors a specific dashed-stripe pattern with stripe count) — this is
the underlying signal you'd use to drive other things.

Common uses:

- soft stripes for backgrounds: \`sine\` with low frequency
- hard bands for masks: \`square\` with adjustable duty cycle
- zigzag / chevron: \`triangle\`
- raked-light or rain effect: \`sawtooth\` with high frequency
- "wipe" gradient at a specific angle: \`frequency = 1\`, any non-sine
  waveform

Drive \`phase\` from [anim/time](../../anim/time) for scrolling stripes
(barber pole, scanlines, etc.).
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'tex/waveform', {
        id: 'wave',
        position: { x: 0, y: 0 },
        inputValues: {
          color_a: [0.05, 0.07, 0.12, 1],
          color_b: [0.95, 0.65, 0.20, 1],
          waveform: 0,
          frequency: 8,
          angle: 45,
          phase: 0,
          duty: 0.5,
          resolution: 512,
        },
      });
      return { graph: g, rootNodeId: 'wave' };
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
    const waveform = inputs.waveform as number;
    const frequency = inputs.frequency as number;
    const angle = inputs.angle as number;
    const phase = inputs.phase as number;
    const duty = inputs.duty as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'waveform-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec4 a (16) + vec4 b (16) + 5 × f32 (20) + 12 pad = 64 bytes.
    const uniformData = new Float32Array(16);
    uniformData.set(a, 0);
    uniformData.set(b, 4);
    uniformData[8] = angle * (Math.PI / 180);
    uniformData[9] = frequency;
    uniformData[10] = phase;
    uniformData[11] = duty;
    uniformData[12] = waveform;

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
        label: 'waveform-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'waveform-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'waveform-pass',
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
