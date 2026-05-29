import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { getRenderPipeline, getShaderModule } from '../render/gpu-cache.js';
import gridShader from './grid.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const gridNode: NodeDef = {
  id: 'core/grid',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'fg',
      type: 'Color',
      default: [0, 0, 0, 1],
      description: 'line colour drawn on top of bg',
    },
    {
      name: 'bg',
      type: 'Color',
      default: [1, 1, 1, 1],
      description: 'cell-interior colour drawn between lines',
    },
    {
      name: 'divisions',
      type: 'Vec2i',
      default: [8, 8],
      description: 'number of cells along X and Y. [8, 8] = 8×8 grid; can be asymmetric ([16, 1] gives vertical stripes)',
    },
    {
      name: 'line_width',
      type: 'Float',
      default: 0.05,
      description: 'thickness of each grid line as a fraction of a cell (0.05 = 5% of cell width). 0 = no lines; 1 = solid fg',
    },
    {
      name: 'resolution',
      type: 'Int',
      default: 512,
      description: 'output texture width and height in pixels',
    },
  ],
  outputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'a grid texture: bg in cell interiors, fg along the dividing lines',
    },
  ],
  doc: {
    summary: 'A 2D grid texture — line colour, cell colour, divisions, line width.',
    description:
      'Renders a configurable grid into an N×N texture. The two colours fill the cells and ' +
      'the dividing lines; `divisions` picks how many cells span the texture; `line_width` ' +
      'controls how chunky the lines are relative to a cell.\n\n' +
      'Handy as a visual test pattern when wiring up a texture pipeline (you immediately ' +
      'see whether UVs are tiling correctly), a placeholder mask while building a more ' +
      'serious texture chain, or a hand-tuned mask for tile/brick/checker effects.',
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'core/grid', {
        id: 'grid',
        position: { x: 0, y: 0 },
        inputValues: {
          fg: [0.08, 0.08, 0.12, 1],
          bg: [0.88, 0.88, 0.92, 1],
          divisions: [8, 8],
          line_width: 0.06,
          resolution: 256,
        },
      });
      return { graph: g, rootNodeId: 'grid' };
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
    const divisions = inputs.divisions as [number, number];
    const lineWidth = inputs.line_width as number;
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

    // 16-byte aligned uniform: vec4 fg, vec4 bg, vec2 divisions, f32 line_width, f32 pad.
    const uniformData = new Float32Array(12);
    uniformData.set(fg, 0);
    uniformData.set(bg, 4);
    uniformData[8] = divisions[0];
    uniformData[9] = divisions[1];
    uniformData[10] = lineWidth;
    uniformData[11] = 0;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const module = getShaderModule(device, gridShader);
    const pipeline = getRenderPipeline(device, {
      layout: 'auto',
      vertex: { module },
      fragment: { module, targets: [{ format: TEXTURE_FORMAT }] },
    });

    const bindGroup = reusableBindGroup(
      device,
      prev?.__bindGroup,
      pipeline.getBindGroupLayout(0),
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
