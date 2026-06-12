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
import shader from './voronoise.wgsl';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'voronoise-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const voronoiseNode: NodeDef = {
  id: 'tex/voronoise',
  category: 'Texture/Noise',
  inputs: [
    {
      name: 'scale',
      type: 'Float',
      default: 6,
      min: 0.1,
      description: 'cell density across the texture',
    },
    {
      name: 'u',
      type: 'Float',
      default: 1,
      min: 0,
      description: 'feature-point irregularity. 0 = regular grid; 1 = fully random scatter (voronoi-like); > 1 overshoots into "scattered cluster" chaos as feature points spill across cell boundaries',
    },
    {
      name: 'v',
      type: 'Float',
      default: 1,
      min: 0,
      max: 1,
      description: 'cell hardness. 0 = smooth blend across cells (more like value noise); 1 = sharp voronoi-style boundaries. Continuous between',
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0,
      description: 'random offset of the lattice hashes',
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
      description: 'continuously-parameterised noise between regular grid, value noise, and voronoi cells',
    },
  ],
  doc: {
    summary: 'Voronoise — IQ\'s continuous (u, v) parameterisation between grid, value noise, and voronoi.',
    description: `
Iñigo Quilez's [voronoise](https://iquilezles.org/articles/voronoise/) —
a single noise function with two continuous parameters that sweep through
several familiar types:

- \`u = 0, v = 0\` → smooth blended grid (value-noise look)
- \`u = 0, v = 1\` → sharp regular-grid cells
- \`u = 1, v = 0\` → smoothed-out voronoi
- \`u = 1, v = 1\` → classic voronoi (matches [tex/worley](../../tex/worley)
  with octaves = 1)
- \`u > 1\` overshoots — feature points spill across cell boundaries
  for "scattered cluster" patterns

The two-parameter space is unique and useful when authoring textures — you
can dial in exactly the look you want without picking a discrete noise
type. Drive \`u\` or \`v\` from [anim/time](../../anim/time) for unusual
animated transitions.

5×5 cell loop per pixel, so noticeably more expensive than
[tex/worley](../../tex/worley). Use it when you need the parameter
flexibility, not as a default cellular noise.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'tex/voronoise', {
        id: 'v',
        position: { x: 0, y: 0 },
        inputValues: { scale: 6, u: 1, v: 1, seed: 0, resolution: 512 },
      });
      return { graph: g, rootNodeId: 'v' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const scale = inputs.scale as number;
    const u = inputs.u as number;
    const v = inputs.v as number;
    const seed = inputs.seed as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'voronoise-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // 4 × f32 = 16 bytes (the uniform-buffer minimum).
    const uniformData = new Float32Array(4);
    uniformData[0] = scale;
    uniformData[1] = u;
    uniformData[2] = v;
    uniformData[3] = seed;

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
        label: 'voronoise-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'voronoise-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'voronoise-pass',
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
