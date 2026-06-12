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
import shader from './radial-gradient.wgsl';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'radial-gradient-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const radialGradientNode: NodeDef = {
  id: 'tex/radial-gradient',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'inner_color',
      type: 'Color',
      default: [1, 1, 1, 1],
      description: 'colour at the centre',
    },
    {
      name: 'outer_color',
      type: 'Color',
      default: [0, 0, 0, 1],
      description: 'colour at and beyond the falloff radius',
    },
    {
      name: 'centre',
      type: 'Vec2',
      default: [0.5, 0.5],
      description: 'centre of the radial sweep, in UV units (0..1). [0.5, 0.5] = image centre; [0, 0] = top-left corner',
    },
    {
      name: 'radius',
      type: 'Float',
      default: 0.5,
      min: 0,
      max: 2,
      description: 'distance at which the gradient finishes blending to outer_color, in UV units. 0.5 = the disc just touches the image edges at axis-aligned cardinals',
    },
    {
      name: 'smoothness',
      type: 'Float',
      default: 0,
      min: 0,
      max: 3,
      description: '0 = linear falloff; 1 = smoothstep; 2/3 = harder plateaus (good for spotlight / vignette masks)',
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
      description: 'a 2D radial gradient from inner_color at the centre to outer_color at the falloff radius',
    },
  ],
  doc: {
    summary: 'A 2D radial gradient — disc / vignette / spotlight mask.',
    description: `
Maps distance from \`centre\` to \`outer_color\` over \`radius\`,
with optional smoothstep shaping. The everyday use cases:

- vignette mask: inner = (1,1,1,1), outer = (0,0,0,1), smoothness 1
- spotlight on a scene: inner = warm bright, outer = ambient dim
- circular fade to alpha: outer alpha = 0 with smoothness 1+

For an off-centre look, move \`centre\` away from (0.5, 0.5).
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'tex/radial-gradient', {
        id: 'rg',
        position: { x: 0, y: 0 },
        inputValues: {
          inner_color: [1, 1, 1, 1],
          outer_color: [0, 0, 0, 1],
          centre: [0.5, 0.5],
          radius: 0.5,
          smoothness: 1,
          resolution: 512,
        },
      });
      return { graph: g, rootNodeId: 'rg' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const inner = inputs.inner_color as [number, number, number, number];
    const outer = inputs.outer_color as [number, number, number, number];
    const centre = inputs.centre as [number, number];
    const radius = inputs.radius as number;
    const smoothness = inputs.smoothness as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'radial-gradient-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec4 inner (16) + vec4 outer (16) + vec2 centre (8) + f32 radius (4) +
    // f32 smoothness (4) = 48 bytes.
    const uniformData = new Float32Array(12);
    uniformData.set(inner, 0);
    uniformData.set(outer, 4);
    uniformData[8] = centre[0];
    uniformData[9] = centre[1];
    uniformData[10] = radius;
    uniformData[11] = smoothness;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const module = getShaderModule(device, shader);
    const { bindGroupLayout: bgl, pipeline } = getPipelineWithLayout(
      device,
      UNIFORM_FRAG_BGL,
      (layout) => ({
        label: 'radial-gradient-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'radial-gradient-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'radial-gradient-pass',
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
