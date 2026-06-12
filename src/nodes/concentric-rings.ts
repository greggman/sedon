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
import shader from './concentric-rings.wgsl';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'concentric-rings-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const concentricRingsNode: NodeDef = {
  id: 'tex/concentric-rings',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'ring_color',
      type: 'Color',
      default: [0.95, 0.95, 0.95, 1],
      description: 'colour of the rings',
    },
    {
      name: 'gap_color',
      type: 'Color',
      default: [0.10, 0.12, 0.18, 1],
      description: 'colour between rings and outside the outer radius',
    },
    {
      name: 'centre',
      type: 'Vec2',
      default: [0.5, 0.5],
      description: 'centre of the ring pattern in UV units',
    },
    {
      name: 'inner_radius',
      type: 'Float',
      default: 0,
      min: 0,
      max: 1,
      description: 'radius at which the first ring starts. 0 = rings begin at the centre',
    },
    {
      name: 'outer_radius',
      type: 'Float',
      default: 0.45,
      min: 0,
      max: 1,
      description: 'radius at which the last ring ends. Beyond this, gap_color',
    },
    {
      name: 'ring_count',
      type: 'Int',
      default: 8,
      min: 1,
      description: 'number of ring periods packed between inner and outer radii',
    },
    {
      name: 'ring_width',
      type: 'Float',
      default: 0.5,
      min: 0,
      max: 1,
      description: 'fraction of each period filled by the ring colour. 0.5 = equal ring/gap; 0.2 = thin rings on a wide gap; 0.8 = thick rings with thin gaps',
    },
    {
      name: 'softness',
      type: 'Float',
      default: 0.003,
      min: 0,
      max: 0.05,
      description: 'edge softness in UV units. 0 = pure binary edges; 0.003 ≈ 1-pixel AA at 512px',
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
      description: 'concentric rings centred on `centre`',
    },
  ],
  doc: {
    summary: 'Concentric rings — target / vinyl record / Saturn rings.',
    description: `
N equally-spaced rings packed between \`inner_radius\` and \`outer_radius\`.
\`ring_width\` controls the duty cycle within each period.

Pair with [tex/colorize](../../tex/colorize) where the ring index drives
the colour for rainbow / heat-map rings. Use \`inner_radius\` > 0 to leave
a clean disc at the centre (e.g. an iris).
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'tex/concentric-rings', {
        id: 'rings',
        position: { x: 0, y: 0 },
        inputValues: {
          ring_color: [0.95, 0.95, 0.95, 1],
          gap_color: [0.10, 0.12, 0.18, 1],
          centre: [0.5, 0.5],
          inner_radius: 0.05,
          outer_radius: 0.45,
          ring_count: 8,
          ring_width: 0.5,
          softness: 0.003,
          resolution: 512,
        },
      });
      return { graph: g, rootNodeId: 'rings' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const ring = inputs.ring_color as [number, number, number, number];
    const gap = inputs.gap_color as [number, number, number, number];
    const centre = inputs.centre as [number, number];
    const innerRadius = inputs.inner_radius as number;
    const outerRadius = inputs.outer_radius as number;
    const ringCount = inputs.ring_count as number;
    const ringWidth = inputs.ring_width as number;
    const softness = inputs.softness as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'concentric-rings-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec4 ring (16) + vec4 gap (16) + vec2 centre (8) + 5 × f32 (20) =
    // 60 bytes, aligned up to 64.
    const uniformData = new Float32Array(16);
    uniformData.set(ring, 0);
    uniformData.set(gap, 4);
    uniformData[8] = centre[0];
    uniformData[9] = centre[1];
    uniformData[10] = innerRadius;
    uniformData[11] = outerRadius;
    uniformData[12] = ringCount;
    uniformData[13] = ringWidth;
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
        label: 'concentric-rings-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'concentric-rings-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'concentric-rings-pass',
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
