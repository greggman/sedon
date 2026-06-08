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
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};
import shader from './worley.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const worleyNode: NodeDef = {
  id: 'core/worley',
  category: 'Texture/Noise',
  inputs: [
    {
      name: 'scale',
      type: 'Float',
      default: 4,
      description: 'cell density: how many cells fit across the texture in each axis. Higher = smaller, more cells; lower = bigger, fewer cells',
    },
    {
      name: 'octaves',
      type: 'Int',
      default: 1,
      min: 1,
      description: 'how many cellular layers stack together. 1 = pure Worley cells; >1 mixes finer cells on top of coarser ones for fractal cell patterns',
    },
    {
      name: 'lacunarity',
      type: 'Float',
      default: 2,
      description: 'frequency multiplier between octaves (only meaningful when octaves > 1). 2 = each layer has twice the cell density',
    },
    {
      name: 'gain',
      type: 'Float',
      default: 0.5,
      description: 'amplitude multiplier between octaves (only meaningful when octaves > 1). <0.5 fades fine cells fast; >0.5 keeps them visible',
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0,
      description: 'random seed offset. Change to shuffle the cell-point positions',
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
      description: 'cellular noise: each pixel encodes the distance to its nearest cell point, normalised to [0, 1]. Cell centres are dark, cell edges are bright',
    },
  ],
  doc: {
    summary: 'Cellular (Worley) noise — each pixel is the distance to its nearest random point.',
    description: `
Scatters seed points across the plane and writes each pixel's distance to the
closest one. The result reads as a Voronoi-like field of cells with bright edges
where two cells meet and dark centres where the seed point sits.

Use for stone / scale / cracked-earth / leaf-vein patterns, foam masks on water,
or as a base for [core/distance-transform](../../core/distance-transform) →
[core/ramp](../../core/ramp) pipelines that want a more "structured" starting
texture than smooth fbm noise.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'core/worley', {
        id: 'worley',
        position: { x: 0, y: 0 },
        inputValues: { scale: 6, octaves: 1, lacunarity: 2, gain: 0.5, seed: 0, resolution: 512 },
      });
      return { graph: g, rootNodeId: 'worley' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const resolution = inputs.resolution as number;

    // Re-use our previous texture when only non-dimension parameters
    // changed (scale, octaves, seed, …). Avoids a GPUTexture
    // allocate+destroy cycle per drag-pixel when the user is nudging a
    // value — the same texture stays put, we just re-render new
    // contents into it.
    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const outputTexture = reusableTexture(device, prev?.texture, {
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // Params: scale, octaves, lacunarity, gain, seed (5 floats = 20B). Pad to
    // 32 to satisfy the 16-byte uniform-buffer minimum.
    const uniformData = new Float32Array(8);
    uniformData[0] = inputs.scale as number;
    uniformData[1] = inputs.octaves as number;
    uniformData[2] = inputs.lacunarity as number;
    uniformData[3] = inputs.gain as number;
    uniformData[4] = inputs.seed as number;

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

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
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
