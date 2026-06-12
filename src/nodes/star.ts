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
import shader from './star.wgsl';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'star-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const starNode: NodeDef = {
  id: 'tex/star',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'star_color',
      type: 'Color',
      default: [1, 0.85, 0.30, 1],
      description: 'colour of the star body',
    },
    {
      name: 'bg_color',
      type: 'Color',
      default: [0, 0, 0, 0],
      description: 'colour outside the star. Default transparent black makes the star usable directly as a sprite mask',
    },
    {
      name: 'centre',
      type: 'Vec2',
      default: [0.5, 0.5],
      description: 'centre of the star in UV units',
    },
    {
      name: 'points',
      type: 'Int',
      default: 5,
      min: 3,
      max: 32,
      description: 'number of star points. 5 = classic; 6 = Star of David; 8 = compass; high values approach a sun/burst',
    },
    {
      name: 'outer_radius',
      type: 'Float',
      default: 0.4,
      min: 0,
      max: 1,
      description: 'distance from centre to the outer star points, in UV units',
    },
    {
      name: 'inner_ratio',
      type: 'Float',
      default: 0.4,
      min: 0.05,
      max: 0.95,
      description: 'ratio of inner-valley radius to outer-point radius. 0.38 ≈ the classic 5-point regular star; lower = spikier; higher = chunkier (toward a regular polygon)',
    },
    {
      name: 'angle',
      type: 'Float',
      default: 0,
      description: 'rotation in degrees. 0 = first point straight up; positive = counter-clockwise',
    },
    {
      name: 'softness',
      type: 'Float',
      default: 0.004,
      min: 0,
      max: 0.1,
      description: 'edge softness in UV units. 0 = pure binary (aliased) edge; 0.004 ≈ 2-pixel AA at 512px; higher = soft glowy stars',
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
      description: 'an N-pointed star mask centred on `centre`',
    },
  ],
  doc: {
    summary: 'An N-pointed star mask — UI badges, sticker icons, sparkles.',
    description: `
A regular N-pointed star with adjustable inner / outer radii. Outputs the
star body in \`star_color\`, everything else in \`bg_color\` (default
transparent black so it composites directly).

Pair with [tex/blend](../../tex/blend) (multiply mode) for a stamp/badge
effect over a background. Drive \`angle\` from [anim/time](../../anim/time)
for spinning sparkles. For a soft glow, set \`softness\` high — the
smoothstep covers a chunky AA band that reads like a halo.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'tex/star', {
        id: 'star',
        position: { x: 0, y: 0 },
        inputValues: {
          star_color: [1, 0.85, 0.30, 1],
          bg_color: [0.05, 0.07, 0.12, 1],
          centre: [0.5, 0.5],
          points: 5,
          outer_radius: 0.4,
          inner_ratio: 0.4,
          angle: 0,
          softness: 0.004,
          resolution: 512,
        },
      });
      return { graph: g, rootNodeId: 'star' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const star = inputs.star_color as [number, number, number, number];
    const bg = inputs.bg_color as [number, number, number, number];
    const centre = inputs.centre as [number, number];
    const points = inputs.points as number;
    const outerRadius = inputs.outer_radius as number;
    const innerRatio = inputs.inner_ratio as number;
    const angle = inputs.angle as number;
    const softness = inputs.softness as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'star-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec4 star (16) + vec4 bg (16) + vec2 centre (8) + 5 × f32 (20) +
    // pad (4) = 64 bytes.
    const uniformData = new Float32Array(16);
    uniformData.set(star, 0);
    uniformData.set(bg, 4);
    uniformData[8] = centre[0];
    uniformData[9] = centre[1];
    uniformData[10] = outerRadius;
    uniformData[11] = innerRatio;
    uniformData[12] = points;
    uniformData[13] = angle * (Math.PI / 180);
    uniformData[14] = softness;

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
        label: 'star-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'star-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'star-pass',
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
