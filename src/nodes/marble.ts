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
import shader from './marble.wgsl';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'marble-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const marbleNode: NodeDef = {
  id: 'tex/marble',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'vein_color',
      type: 'Color',
      default: [0.15, 0.13, 0.18, 1],
      description: 'colour of the marble veins (the thin dark seams)',
    },
    {
      name: 'base_color',
      type: 'Color',
      default: [0.92, 0.90, 0.86, 1],
      description: 'colour of the base marble (the wider lighter background)',
    },
    {
      name: 'frequency',
      type: 'Float',
      default: 4,
      min: 0,
      description: 'periods per UV unit along the vein direction. 1 = single broad vein; 4 = a few sweeping veins; 12 = dense pinstripe',
    },
    {
      name: 'turbulence',
      type: 'Float',
      default: 4,
      min: 0,
      description: 'how much the noise warps the stripes. 0 = parallel stripes; 2 = gentle swirl; 4 = classic marble; 8+ = chaotic',
    },
    {
      name: 'noise_scale',
      type: 'Float',
      default: 3,
      min: 0.01,
      description: 'scale of the warping noise. Lower = broad slow swirls; higher = chattery noise',
    },
    {
      name: 'octaves',
      type: 'Int',
      default: 4,
      min: 1,
      max: 8,
      description: 'fbm layers on the warping noise. 1 = smooth; 4 = textured; 6+ = grainy',
    },
    {
      name: 'sharpness',
      type: 'Float',
      default: 0.08,
      min: 0.001,
      max: 1,
      description: 'half-width of the smoothstep band around each vein. 0.02 = razor-sharp; 0.08 = classic; 0.3 = soft watercolour wash',
    },
    {
      name: 'angle',
      type: 'Float',
      default: 0,
      description: 'direction of the base stripes (before turbulence), in degrees. 0 = horizontal stripes; 90 = vertical; 45 = diagonal',
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0,
      description: 'random offset of the noise. Change to shuffle the vein layout without re-tuning the other parameters',
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
      description: 'a marble-like veined texture: thin vein_color seams over a wider base_color body',
    },
  ],
  doc: {
    summary: 'Procedural marble — turbulent veined stone for floors, walls, countertops.',
    description: `
The classic marble shader: take parallel stripes, warp them with fractal
noise, sharpen the zero-crossings into thin veins. Tune \`turbulence\` for
how chaotic the veins are; \`sharpness\` for how knife-edge the seams look.

Drop the output into [tex/normal-from-height](../../tex/normal-from-height)
to get a vein-recessed normal map for lit surfaces. For a more colourful
variant, run through [tex/colorize](../../tex/colorize) with a multi-stop
ramp (vein, mid-stone, light-stone, base) for that polished-marble look
where the stone has internal variation between veins.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'tex/marble', {
        id: 'm',
        position: { x: 0, y: 0 },
        inputValues: {
          vein_color: [0.15, 0.13, 0.18, 1],
          base_color: [0.92, 0.90, 0.86, 1],
          frequency: 4,
          turbulence: 4,
          noise_scale: 3,
          octaves: 4,
          sharpness: 0.08,
          angle: 0,
          seed: 0,
          resolution: 512,
        },
      });
      return { graph: g, rootNodeId: 'm' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const vein = inputs.vein_color as [number, number, number, number];
    const base = inputs.base_color as [number, number, number, number];
    const frequency = inputs.frequency as number;
    const turbulence = inputs.turbulence as number;
    const noiseScale = inputs.noise_scale as number;
    const octaves = inputs.octaves as number;
    const sharpness = inputs.sharpness as number;
    const angle = inputs.angle as number;
    const seed = inputs.seed as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'marble-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec4 vein (16) + vec4 base (16) + 8 × f32 (32) = 64 bytes.
    const uniformData = new Float32Array(16);
    uniformData.set(vein, 0);
    uniformData.set(base, 4);
    uniformData[8] = frequency;
    uniformData[9] = turbulence;
    uniformData[10] = noiseScale;
    uniformData[11] = octaves;
    uniformData[12] = sharpness;
    uniformData[13] = angle * (Math.PI / 180);
    uniformData[14] = seed;

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
        label: 'marble-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'marble-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'marble-pass',
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
