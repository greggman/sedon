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
import shader from './linear-gradient.wgsl';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'linear-gradient-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const linearGradientNode: NodeDef = {
  id: 'tex/linear-gradient',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'color_a',
      type: 'Color',
      default: [0, 0, 0, 1],
      description: 'colour at the start of the sweep',
    },
    {
      name: 'color_b',
      type: 'Color',
      default: [1, 1, 1, 1],
      description: 'colour at the end of the sweep',
    },
    {
      name: 'angle',
      type: 'Float',
      default: 0,
      description: 'sweep direction in radians. 0 = horizontal (color_a on the left, color_b on the right); π/2 = vertical (a at the bottom, b at the top); π = horizontal flipped',
    },
    {
      name: 'smoothness',
      type: 'Float',
      default: 0,
      min: 0,
      max: 3,
      description: '0 = straight linear lerp; 1 = smoothstep (ease-in-out); 2/3 = increasingly hard plateaus. Fractional values blend between',
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
      description: 'a 2D linear gradient from color_a → color_b along the chosen angle',
    },
  ],
  doc: {
    summary: 'A 2D linear gradient at a chosen angle.',
    description: `
Lerps from \`color_a\` to \`color_b\` across the texture along the
\`angle\` direction. Distinct from [tex/ramp](../../tex/ramp), which
authors a 1D N-stop LUT for downstream colour-mapping; this is the
2D image you'd put on a background or composite into a UI.

Pair with [tex/multiply](../../tex/blend) (mode = multiply) to tint
another texture, or feed into [tex/threshold](../../tex/threshold) to
slice the gradient into a hard-edged mask.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'tex/linear-gradient', {
        id: 'grad',
        position: { x: 0, y: 0 },
        inputValues: {
          color_a: [0.05, 0.05, 0.12, 1],
          color_b: [0.95, 0.75, 0.55, 1],
          angle: Math.PI / 2,
          smoothness: 0.5,
          resolution: 512,
        },
      });
      return { graph: g, rootNodeId: 'grad' };
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
    const angle = inputs.angle as number;
    const smoothness = inputs.smoothness as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'linear-gradient-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec4 a (16) + vec4 b (16) + f32 angle (4) + f32 smoothness (4) +
    // 8 pad = 48 bytes.
    const uniformData = new Float32Array(12);
    uniformData.set(a, 0);
    uniformData.set(b, 4);
    uniformData[8] = angle;
    uniformData[9] = smoothness;

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
        label: 'linear-gradient-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'linear-gradient-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'linear-gradient-pass',
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
