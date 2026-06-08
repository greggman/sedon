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

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'perlin-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};
import shader from './perlin.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const perlinNode: NodeDef = {
  id: 'core/perlin',
  category: 'Texture/Noise',
  inputs: [
    {
      name: 'scale',
      type: 'Vec2',
      default: [4, 4],
      description: 'tiling frequency per axis. Equal X/Y gives isotropic noise; unequal stretches it (e.g. [2, 12] for vertical wood-grain fibers)',
    },
    {
      name: 'octaves',
      type: 'Int',
      default: 4,
      min: 1,
      description: 'how many noise layers stack on top of each other. Each octave doubles in frequency (via lacunarity) and halves in amplitude (via gain). 1 = pure noise; 4–6 = natural-looking detail; >8 burns GPU for little visible gain',
    },
    {
      name: 'lacunarity',
      type: 'Float',
      default: 2,
      description: 'frequency multiplier between successive octaves. 2 is the classic value (each octave doubles the detail rate); higher values pack finer noise into the same area',
    },
    {
      name: 'gain',
      type: 'Float',
      default: 0.5,
      description: 'amplitude multiplier between successive octaves. <0.5 makes high-frequency layers fade fast (smoother result); >0.5 keeps the fine noise loud (rougher result)',
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0,
      description: 'random seed offset. Change to get a different noise pattern at the same scale/octaves',
    },
    {
      name: 'resolution',
      type: 'Int',
      default: 512,
      min: 1,
      description: 'output texture width and height in pixels. Higher values resolve finer detail at the cost of GPU memory and shading time',
    },
  ],
  outputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'greyscale fractal-Brownian-motion noise in [0, 1], stored in the R channel (G and B are also written for visualisation)',
    },
  ],
  doc: {
    summary: 'Fractal Brownian Motion noise as a 2D texture.',
    description: `
Layers multiple octaves of classic Perlin noise to produce a smooth, organic
greyscale texture. Higher octave counts add finer detail; lacunarity controls
how fast frequency grows per octave; gain controls how fast amplitude falls off.

Use as a base for terrain heightfields, cloud cover, vein patterns on leaves,
turbulence for water — anything that wants natural irregularity without a
visible grid.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'core/perlin', {
        id: 'perlin',
        position: { x: 0, y: 0 },
        inputValues: { scale: [4, 4], octaves: 5, lacunarity: 2, gain: 0.5, seed: 0, resolution: 512 },
      });
      return { graph: g, rootNodeId: 'perlin' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const resolution = inputs.resolution as number;

    // Backward compat: graphs saved before the scale type was widened
    // store scale as a single Float; broadcast to Vec2 so they still work.
    const rawScale = inputs.scale as number | [number, number];
    const scale: [number, number] =
      typeof rawScale === 'number' ? [rawScale, rawScale] : rawScale;

    // Reuse the previously-allocated texture when dims+format are
    // unchanged. Avoids GPU allocate+destroy churn while the user is
    // dragging non-dimension parameters (scale, octaves, gain, …).
    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const outputTexture = reusableTexture(device, prev?.texture, {
      label: 'perlin-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // Params: scale vec2 (8B aligned) + octaves, lacunarity, gain, seed
    // (4 × 4B = 16B) = 24B. Pad to 32 for the 16-byte uniform minimum.
    const uniformData = new Float32Array(8);
    uniformData[0] = scale[0];
    uniformData[1] = scale[1];
    uniformData[2] = inputs.octaves as number;
    uniformData[3] = inputs.lacunarity as number;
    uniformData[4] = inputs.gain as number;
    uniformData[5] = inputs.seed as number;

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
        label: 'perlin-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'perlin-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'perlin-pass',
      colorAttachments: [
        {
          view: outputTexture.texture,
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

    return {
      texture: outputTexture,
      __uniformBuffer: uniformBuffer,
      __bindGroup: bindGroup,
    };
  },
};
