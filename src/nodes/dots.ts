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
import dotsShader from './dots.wgsl';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'dots-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const dotsNode: NodeDef = {
  id: 'tex/dots',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'dot_color',
      type: 'Color',
      default: [0.95, 0.95, 0.95, 1],
      description: 'the colour of each dot',
    },
    {
      name: 'bg_color',
      type: 'Color',
      default: [0.1, 0.1, 0.1, 1],
      description: 'the colour between dots',
    },
    {
      name: 'divisions',
      type: 'Vec2i',
      default: [16, 16],
      description: 'dots across × dots down',
    },
    {
      name: 'radius',
      type: 'Float',
      default: 0.3,
      min: 0,
      max: 1,
      description: 'dot radius as a fraction of a cell (0.5 = dot touches the cell edge). > 0.5 makes dots overlap into a mesh',
    },
    {
      name: 'softness',
      type: 'Float',
      default: 0,
      min: 0,
      max: 0.5,
      description: 'edge softness in cell-uv units. 0 = hard pixel edges; 0.03 = AA-style smoothing; 0.1+ = soft bokeh / film-grain halo',
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
      description: 'a dot pattern: dot_color discs over bg_color, on a regular grid',
    },
  ],
  doc: {
    summary: 'A regular dot pattern — useful as a polka-dot, halftone seed, or stipple mask.',
    description: `
Hard or soft circles laid out on a regular grid. With \`softness\` > 0
the dots feather to their bg colour — useful as a coarse halftone /
print look or as a procedural film-grain seed.

For a NON-regular dot scatter (random sizes / offsets), feed
[tex/worley](../../tex/worley) into [tex/threshold](../../tex/threshold)
instead.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'tex/dots', {
        id: 'dots',
        position: { x: 0, y: 0 },
        inputValues: {
          dot_color: [0.95, 0.95, 0.95, 1],
          bg_color: [0.1, 0.1, 0.1, 1],
          divisions: [16, 16],
          radius: 0.3,
          softness: 0.02,
          resolution: 512,
        },
      });
      return { graph: g, rootNodeId: 'dots' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const dot = inputs.dot_color as [number, number, number, number];
    const bg = inputs.bg_color as [number, number, number, number];
    const divisions = inputs.divisions as [number, number];
    const radius = inputs.radius as number;
    const softness = inputs.softness as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'dots-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec4 dot (16) + vec4 bg (16) + vec2 divisions (8) + f32 radius (4) +
    // f32 softness (4) = 48 bytes.
    const uniformData = new Float32Array(12);
    uniformData.set(dot, 0);
    uniformData.set(bg, 4);
    uniformData[8] = divisions[0];
    uniformData[9] = divisions[1];
    uniformData[10] = radius;
    uniformData[11] = softness;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const module = getShaderModule(device, dotsShader);
    const { bindGroupLayout: bgl, pipeline } = getPipelineWithLayout(
      device,
      UNIFORM_FRAG_BGL,
      (layout) => ({
        label: 'dots-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'dots-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'dots-pass',
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
