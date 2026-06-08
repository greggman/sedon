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
import dashedStripeShader from './dashed-stripe.wgsl';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

// One dashed line drawn on a transparent / coloured field. Built
// for road lane markings — the "dashes down the centre of the
// asphalt" pattern. Two knobs separate the cadence (dash_count) from
// the duty cycle (dash_fraction): 20 dashes filling 50% of each
// cell reads as classic broken-line lane divider; 1 dash at 100%
// gives a single solid stripe, useful as a road-edge marker.
//
// Same GPU plumbing as core/grid / core/checker.
export const dashedStripeNode: NodeDef = {
  id: 'core/dashed-stripe',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'fg',
      type: 'Color',
      default: [1, 0.85, 0.2, 1],
      description: 'colour of the dashes (default = lane-marker yellow)',
    },
    {
      name: 'bg',
      type: 'Color',
      default: [0.12, 0.12, 0.13, 1],
      description: 'background colour (default = asphalt-dark)',
    },
    {
      name: 'dash_count',
      type: 'Int',
      default: 20,
      min: 1,
      description: 'number of dash+gap pairs along the stripe. Higher = shorter / more frequent dashes',
    },
    {
      name: 'dash_fraction',
      type: 'Float',
      default: 0.5,
      min: 0,
      max: 1,
      description: 'duty cycle: 0.5 = dashes and gaps equal length; 1 = solid line; 0 = no dashes',
    },
    {
      name: 'stripe_width',
      type: 'Float',
      default: 0.08,
      min: 0,
      max: 1,
      description: 'thickness of the stripe band as a fraction of the texture (0.08 ≈ a thin centerline)',
    },
    {
      name: 'orientation',
      type: 'Int',
      default: 0,
      enumOptions: [
        { value: 0, label: 'horizontal (dashes run along U)' },
        { value: 1, label: 'vertical (dashes run along V)' },
      ],
      description: 'which axis the dashes are laid out along',
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
      description: 'a dashed-stripe texture: a centered band of dashes on the bg colour',
    },
  ],
  doc: {
    summary: 'A dashed line on a coloured field — for road lane markings and dashed dividers.',
    description: `
Builds a single dashed stripe centred on one axis of the texture. Two
knobs separate cadence (\`dash_count\`) from duty cycle
(\`dash_fraction\`):

* \`dash_count = 20\`, \`dash_fraction = 0.5\` → classic broken-line
  centerline (20 equal-length dashes and gaps).
* \`dash_count = 1\`, \`dash_fraction = 1\` → a single solid stripe
  (use this for the white edge-of-road line).
* \`dash_count = 8\`, \`dash_fraction = 0.7\` → long dashes with small
  gaps — reads as "do not pass" double-yellow if you stack two of
  these textures vertically with a small offset.

The whole stripe sits in a band of width \`stripe_width\` centred on
the cross-axis; outside the band the texture is \`bg\`, so this
texture composes well as the basecolor of an asphalt plane —
you get road surface + lane marking in one sample.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'core/dashed-stripe', {
        id: 'dash',
        position: { x: 0, y: 0 },
        inputValues: {
          fg: [1, 0.85, 0.2, 1],
          bg: [0.12, 0.12, 0.13, 1],
          dash_count: 20,
          dash_fraction: 0.5,
          stripe_width: 0.08,
          orientation: 0,
          resolution: 256,
        },
      });
      return { graph: g, rootNodeId: 'dash' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const fg = inputs.fg as [number, number, number, number];
    const bg = inputs.bg as [number, number, number, number];
    const dashCount = inputs.dash_count as number;
    const dashFraction = inputs.dash_fraction as number;
    const stripeWidth = inputs.stripe_width as number;
    const orientation = inputs.orientation as number;
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

    // 16-byte-aligned uniform: vec4 fg, vec4 bg, then 4×f32 params.
    const uniformData = new Float32Array(12);
    uniformData.set(fg, 0);
    uniformData.set(bg, 4);
    uniformData[8] = dashCount;
    uniformData[9] = dashFraction;
    uniformData[10] = stripeWidth;
    uniformData[11] = orientation;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const module = getShaderModule(device, dashedStripeShader);
    const { bindGroupLayout: bgl, pipeline } = getPipelineWithLayout(
      device,
      UNIFORM_FRAG_BGL,
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
      [uniformBuffer],
      () => [{ binding: 0, resource: uniformBuffer }],
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
