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
import brickShader from './brick.wgsl';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'brick-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const brickNode: NodeDef = {
  id: 'tex/brick',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'brick_color',
      type: 'Color',
      default: [0.62, 0.34, 0.28, 1],
      description: 'the colour of each brick. Defaults to a warm clay red',
    },
    {
      name: 'mortar_color',
      type: 'Color',
      default: [0.78, 0.78, 0.78, 1],
      description: 'the colour of the gaps between bricks',
    },
    {
      name: 'divisions',
      type: 'Vec2i',
      default: [6, 12],
      description: 'bricks across × rows down. Real bricks are roughly 2:1 (wide:tall), so a square texture wants twice as many rows as columns to keep the proportion',
    },
    {
      name: 'mortar',
      type: 'Float',
      default: 0.05,
      min: 0,
      max: 0.5,
      description: 'mortar gap thickness as a fraction of a brick. 0 = no gap (touching bricks); 0.05 = thin classic mortar; 0.2+ = chunky industrial / rough',
    },
    {
      name: 'row_offset',
      type: 'Float',
      default: 0.5,
      min: 0,
      max: 1,
      description: 'horizontal shift between alternating rows, as a fraction of one brick. 0 = stack bond (bricks line up vertically); 0.5 = running bond (the everyday bricklayer\'s pattern); 0.33 = third bond',
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
      description: 'a brick-wall texture with the chosen pattern, colours, mortar thickness, and row offset',
    },
  ],
  doc: {
    summary: 'A parametric brick-wall texture — bricks, mortar, offset bond.',
    description: `
Standard brick wall: rectangular tiles separated by a mortar gap, with
alternating rows shifted by \`row_offset\` for that running-bond look.

For a real wall, pair with [tex/normal-from-height](../../tex/normal-from-height)
fed by this same texture to get the mortar-recess shading. For visual
break-up, run the output through [tex/warp](../../tex/warp) driven by a
low-frequency [tex/perlin](../../tex/perlin) so the brick edges aren't
geometrically perfect.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'tex/brick', {
        id: 'brick',
        position: { x: 0, y: 0 },
        inputValues: {
          brick_color: [0.62, 0.34, 0.28, 1],
          mortar_color: [0.78, 0.78, 0.78, 1],
          divisions: [6, 12],
          mortar: 0.05,
          row_offset: 0.5,
          resolution: 512,
        },
      });
      return { graph: g, rootNodeId: 'brick' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const brick = inputs.brick_color as [number, number, number, number];
    const mortar_col = inputs.mortar_color as [number, number, number, number];
    const divisions = inputs.divisions as [number, number];
    const mortar = inputs.mortar as number;
    const rowOffset = inputs.row_offset as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'brick-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // Layout: vec4 brick (16) + vec4 mortar_color (16) + vec2 divisions (8) +
    // f32 mortar (4) + f32 row_offset (4) = 48 bytes.
    const uniformData = new Float32Array(12);
    uniformData.set(brick, 0);
    uniformData.set(mortar_col, 4);
    uniformData[8] = divisions[0];
    uniformData[9] = divisions[1];
    uniformData[10] = mortar;
    uniformData[11] = rowOffset;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const module = getShaderModule(device, brickShader);
    const { bindGroupLayout: bgl, pipeline } = getPipelineWithLayout(
      device,
      UNIFORM_FRAG_BGL,
      (layout) => ({
        label: 'brick-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'brick-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'brick-pass',
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
