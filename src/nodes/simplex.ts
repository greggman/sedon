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
import shader from './simplex.wgsl';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'simplex-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const simplexNode: NodeDef = {
  id: 'tex/simplex',
  category: 'Texture/Noise',
  inputs: [
    {
      name: 'scale',
      type: 'Vec2',
      default: [4, 4],
      description: 'per-axis tiling. Higher = more cells, finer detail',
    },
    {
      name: 'octaves',
      type: 'Int',
      default: 4,
      min: 1,
      max: 8,
      description: 'fbm layers. 1 = pure simplex; >1 stacks finer octaves on coarser',
    },
    {
      name: 'lacunarity',
      type: 'Float',
      default: 2,
      description: 'frequency multiplier between octaves',
    },
    {
      name: 'gain',
      type: 'Float',
      default: 0.5,
      description: 'amplitude multiplier between octaves. < 0.5 = fast fade-out; > 0.5 = busier result',
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0,
      description: 'random offset; shuffles the noise without retuning anything else',
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
      description: 'fractal simplex noise in [0, 1]',
    },
  ],
  doc: {
    summary: 'Simplex noise — gradient noise on a triangular lattice, without perlin\'s axis bias.',
    description: `
Simplex noise is gradient noise (like [tex/perlin](../../tex/perlin)) but
evaluated on a triangular lattice instead of a square one. The result
looks isotropic — no visible axis-aligned diagonal grain — which is
especially useful at low octave counts and high zooms.

Trade-off vs perlin: this implementation is NOT tileable. If you need
seamless tiling, stick with [tex/perlin](../../tex/perlin); reach for
simplex when you want a single non-tiled noise field with cleaner
appearance.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'tex/simplex', {
        id: 's',
        position: { x: 0, y: 0 },
        inputValues: { scale: [4, 4], octaves: 4, lacunarity: 2, gain: 0.5, seed: 0, resolution: 512 },
      });
      return { graph: g, rootNodeId: 's' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const scale = inputs.scale as [number, number];
    const octaves = inputs.octaves as number;
    const lacunarity = inputs.lacunarity as number;
    const gain = inputs.gain as number;
    const seed = inputs.seed as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'simplex-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec2 scale (8) + 5 × f32 (20) = 28 bytes, aligned up to 32.
    const uniformData = new Float32Array(8);
    uniformData[0] = scale[0];
    uniformData[1] = scale[1];
    uniformData[2] = octaves;
    uniformData[3] = lacunarity;
    uniformData[4] = gain;
    uniformData[5] = seed;

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
        label: 'simplex-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'simplex-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'simplex-pass',
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
