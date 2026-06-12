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
import shader from './curl-noise.wgsl';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'curl-noise-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const curlNoiseNode: NodeDef = {
  id: 'tex/curl-noise',
  category: 'Texture/Noise',
  inputs: [
    {
      name: 'scale',
      type: 'Vec2',
      default: [4, 4],
      description: 'per-axis tiling of the underlying simplex noise',
    },
    {
      name: 'octaves',
      type: 'Int',
      default: 3,
      min: 1,
      max: 8,
      description: 'fbm layers on the scalar potential before differentiation. Higher = finer flow detail',
    },
    {
      name: 'lacunarity',
      type: 'Float',
      default: 2,
      description: 'frequency multiplier between fbm octaves',
    },
    {
      name: 'gain',
      type: 'Float',
      default: 0.5,
      description: 'amplitude multiplier between fbm octaves',
    },
    {
      name: 'step_size',
      type: 'Float',
      default: 0.01,
      min: 0.0001,
      description: 'finite-difference step for derivatives, in noise-space units. Smaller = sharper / more aliased; larger = smoother',
    },
    {
      name: 'mode',
      type: 'Int',
      default: 2,
      description: 'how to render the vector field',
      enumOptions: [
        { value: 0, label: 'packed (R=x, G=y) — flow map' },
        { value: 1, label: 'magnitude greyscale' },
        { value: 2, label: 'direction as hue (visualisation)' },
      ],
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0,
      description: 'random offset of the noise',
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
      description: 'a divergence-free 2D vector field derived from simplex noise',
    },
  ],
  doc: {
    summary: 'Divergence-free 2D vector field — wind, smoke, flowing hair direction.',
    description: `
Curl noise: the 2D curl \`(∂f/∂y, −∂f/∂x)\` of a scalar fbm \`f\`.
Because curl is divergence-free, flows neither accumulate nor dissipate
— that's exactly what you want for wind-like motion, smoke, particle
drift, or hair direction maps.

Modes:

- **packed (R=x, G=y)** — store as a flow map. Downstream consumers can
  unpack via \`v = sample.rg * 2 - 1\`. Drives realistic-looking
  wind/water flow in particle systems.
- **magnitude greyscale** — \`length(curl)\` as a luminance map. Useful
  to see where the field is strong vs calm.
- **direction as hue** — angle of the vector encoded as HSV hue, magnitude
  as value. Purely for visual inspection; not for downstream sampling.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'tex/curl-noise', {
        id: 'curl',
        position: { x: 0, y: 0 },
        inputValues: {
          scale: [4, 4],
          octaves: 3,
          lacunarity: 2,
          gain: 0.5,
          step_size: 0.01,
          mode: 2,
          seed: 0,
          resolution: 512,
        },
      });
      return { graph: g, rootNodeId: 'curl' };
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
    const stepSize = inputs.step_size as number;
    const mode = inputs.mode as number;
    const seed = inputs.seed as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'curl-noise-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec2 scale (8) + 7 × f32 (28) + pad (4) = 40 bytes, aligned up to 48.
    const uniformData = new Float32Array(12);
    uniformData[0] = scale[0];
    uniformData[1] = scale[1];
    uniformData[2] = octaves;
    uniformData[3] = lacunarity;
    uniformData[4] = gain;
    uniformData[5] = seed;
    uniformData[6] = stepSize;
    uniformData[7] = mode;

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
        label: 'curl-noise-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'curl-noise-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'curl-noise-pass',
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
