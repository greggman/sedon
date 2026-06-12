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
import shader from './uv-polar.wgsl';

const UNIFORM_TEX_SAMP_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'uv-polar-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const uvPolarNode: NodeDef = {
  id: 'tex/uv-polar',
  category: 'Texture/Filters',
  inputs: [
    {
      name: 'input',
      type: 'Texture2D',
      description: 'source texture to resample under the polar transform',
    },
    {
      name: 'direction',
      type: 'Int',
      default: 1,
      description: 'cartesian → polar (wrap a flat strip into a disc) or polar → cartesian (unwrap a disc back to a strip)',
      enumOptions: [
        { value: 0, label: 'cartesian → polar (wrap)' },
        { value: 1, label: 'polar → cartesian (unwrap)' },
      ],
    },
    {
      name: 'centre',
      type: 'Vec2',
      default: [0.5, 0.5],
      description: 'centre of the polar transform in UV units. [0.5, 0.5] is the image centre',
    },
    {
      name: 'repeats',
      type: 'Float',
      default: 1,
      min: 0.1,
      description: 'angular repetitions. 1 = single sweep; 4 = 4-fold kaleidoscope; 8 = 8-fold; etc.',
    },
    {
      name: 'angle_offset',
      type: 'Float',
      default: 0,
      description: 'rotation in turns. Lets you spin the seam (where the 1-pixel discontinuity ends up) to a less-visible spot',
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
      description: 'the input resampled under the polar transform',
    },
  ],
  doc: {
    summary: 'Cartesian ↔ polar UV warp for kaleidoscope and "wrap-around" effects.',
    description: `
The classic radial warp. Two directions:

- **cartesian → polar** — treat the output's u/v as (angle, radius) and
  sample the input there. A horizontal stripe becomes a circle, a
  gradient becomes a halo, repeated noise becomes a sunburst.
- **polar → cartesian** — the inverse: sample the input as if it were
  itself a polar image. Useful for unwrapping a generated disc back to
  a strip for further editing.

\`repeats\` > 1 produces angular tiling (great for kaleidoscope and
mandala patterns); chain with [tex/uv-mirror](../../tex/uv-mirror) for
classic kaleidoscope symmetry.
`,
    sampleGraph: () => {
      const g = createGraph();
      const src = addNode(g, 'tex/dashed-stripe', {
        id: 'src',
        position: { x: 0, y: 0 },
        inputValues: {
          stripe_color: [0.95, 0.55, 0.20, 1],
          background_color: [0.05, 0.07, 0.12, 1],
          stripe_count: 8,
          stripe_width: 0.4,
          dash_count: 4,
          dash_duty: 0.5,
          resolution: 512,
        },
      });
      const polar = addNode(g, 'tex/uv-polar', {
        id: 'polar',
        position: { x: 280, y: 0 },
        inputValues: {
          direction: 1,
          centre: [0.5, 0.5],
          repeats: 1,
          angle_offset: 0,
          resolution: 512,
        },
      });
      addEdge(g, { node: src.id, socket: 'texture' }, { node: polar.id, socket: 'input' });
      return { graph: g, rootNodeId: 'polar' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const src = inputs.input as Texture2DValue;
    const centre = inputs.centre as [number, number];
    const direction = inputs.direction as number;
    const repeats = inputs.repeats as number;
    const angleOffset = inputs.angle_offset as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'uv-polar-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec2 centre (8) + f32 direction (4) + f32 repeats (4) +
    // f32 angle (4) + pad (4) = 24 bytes, padded out to 32 for safety.
    const uniformData = new Float32Array(8);
    uniformData[0] = centre[0];
    uniformData[1] = centre[1];
    uniformData[2] = direction;
    uniformData[3] = repeats;
    uniformData[4] = angleOffset;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Repeat addressing means a "wrap" polar gets the u-seam tiling
    // naturally — the input's left edge stitches to its right edge.
    const sampler = getSampler(device, {
      label: 'uv-polar-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
    });

    const module = getShaderModule(device, shader);
    const { bindGroupLayout: bgl, pipeline } = getPipelineWithLayout(
      device,
      UNIFORM_TEX_SAMP_BGL,
      (layout) => ({
        label: 'uv-polar-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'uv-polar-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'uv-polar-pass',
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
