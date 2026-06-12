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
import shader from './wood.wgsl';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'wood-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const woodNode: NodeDef = {
  id: 'tex/wood',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'light_color',
      type: 'Color',
      default: [0.72, 0.50, 0.30, 1],
      description: 'colour of the sapwood / between-ring light bands',
    },
    {
      name: 'dark_color',
      type: 'Color',
      default: [0.38, 0.22, 0.13, 1],
      description: 'colour of the dark growth rings',
    },
    {
      name: 'centre',
      type: 'Vec2',
      default: [-0.3, 0.5],
      description: 'tree-centre point in UV units. Off-canvas (e.g. [-0.3, 0.5]) gives the classic "plank cut some distance from the tree centre" look; [0.5, 0.5] gives a bullseye',
    },
    {
      name: 'ring_count',
      type: 'Float',
      default: 24,
      min: 0,
      description: 'rings per UV unit. Around 20–40 reads as plank-scale wood; 5 = sliced log',
    },
    {
      name: 'ring_distortion',
      type: 'Float',
      default: 1,
      min: 0,
      description: 'how much low-freq noise warps the rings. 0 = perfect circles; 1 = elliptical wobble; 4 = irregular natural rings',
    },
    {
      name: 'ring_width',
      type: 'Float',
      default: 0.3,
      min: 0,
      max: 1,
      description: 'fraction of each ring period filled by the dark band. 0.2 = thin sharp rings; 0.5 = equal light/dark',
    },
    {
      name: 'grain_strength',
      type: 'Float',
      default: 0.05,
      min: 0,
      description: 'amplitude of the high-freq directional grain. 0 = no grain; 0.05 = subtle wood texture; 0.15 = rough sawn',
    },
    {
      name: 'grain_scale',
      type: 'Float',
      default: 30,
      min: 0.01,
      description: 'frequency of the grain streaks. Higher = finer, denser grain',
    },
    {
      name: 'distortion_scale',
      type: 'Float',
      default: 2,
      min: 0.01,
      description: 'frequency of the ring-distortion noise. Lower = broad bulges in the rings; higher = ragged ring edges',
    },
    {
      name: 'sharpness',
      type: 'Float',
      default: 0.05,
      min: 0.001,
      description: 'half-width of the smoothstep band on each ring edge. Smaller = harder ring transitions; > 1 bleeds rings into a uniform tone',
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
      description: 'a wood plank texture: concentric growth rings + grain streaks',
    },
  ],
  doc: {
    summary: 'Procedural wood — concentric growth rings plus directional grain.',
    description: `
Models a plank cut at some distance from the tree's centre. Rings are
circles of constant distance from \`centre\`, distorted by low-frequency
noise; on top of that, high-frequency noise streaks run along the ring
direction to give the characteristic wood grain.

The default \`centre = [-0.3, 0.5]\` places the tree origin off the left
edge, so the rings appear as gentle curves (the typical wood-plank
look). Move \`centre\` to (0.5, 0.5) for a target/bullseye end-grain look,
or close to one corner for a quarter-sawn cathedral grain.

Drop into [tex/normal-from-height](../../tex/normal-from-height) for a
displacement-relief normal map on wood floors and furniture.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'tex/wood', {
        id: 'wood',
        position: { x: 0, y: 0 },
        inputValues: {
          light_color: [0.72, 0.50, 0.30, 1],
          dark_color: [0.38, 0.22, 0.13, 1],
          centre: [-0.3, 0.5],
          ring_count: 24,
          ring_distortion: 1,
          ring_width: 0.3,
          grain_strength: 0.05,
          grain_scale: 30,
          distortion_scale: 2,
          sharpness: 0.05,
          seed: 0,
          resolution: 512,
        },
      });
      return { graph: g, rootNodeId: 'wood' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const light = inputs.light_color as [number, number, number, number];
    const dark = inputs.dark_color as [number, number, number, number];
    const centre = inputs.centre as [number, number];
    const ringCount = inputs.ring_count as number;
    const ringDistortion = inputs.ring_distortion as number;
    const ringWidth = inputs.ring_width as number;
    const grainStrength = inputs.grain_strength as number;
    const grainScale = inputs.grain_scale as number;
    const distortionScale = inputs.distortion_scale as number;
    const sharpness = inputs.sharpness as number;
    const seed = inputs.seed as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'wood-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec4 light (16) + vec4 dark (16) + vec2 centre (8) + 9 × f32 (36) =
    // 76 bytes, aligned up to 80.
    const uniformData = new Float32Array(20);
    uniformData.set(light, 0);
    uniformData.set(dark, 4);
    uniformData[8] = centre[0];
    uniformData[9] = centre[1];
    uniformData[10] = ringCount;
    uniformData[11] = ringDistortion;
    uniformData[12] = ringWidth;
    uniformData[13] = grainStrength;
    uniformData[14] = grainScale;
    uniformData[15] = distortionScale;
    uniformData[16] = sharpness;
    uniformData[17] = seed;

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
        label: 'wood-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'wood-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'wood-pass',
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
