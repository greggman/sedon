import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { ShaderStage, getPipelineWithLayout, getSampler, getShaderModule } from '../render/gpu-cache.js';
import shader from './tile-with-jitter.wgsl';

const UNIFORM_TEX_SAMP_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'tile-with-jitter-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const tileWithJitterNode: NodeDef = {
  id: 'tex/tile-with-jitter',
  category: 'Texture/Filters',
  inputs: [
    {
      name: 'stamp',
      type: 'Texture2D',
      description: 'the per-tile stamp texture, e.g. a single pebble, leaf, or brick to scatter in a grid',
    },
    {
      name: 'divisions',
      type: 'Vec2',
      default: [8, 8],
      description: 'grid divisions: tiles across × tiles down',
    },
    {
      name: 'position_jitter',
      type: 'Float',
      default: 0.3,
      min: 0,
      max: 1,
      description: 'per-tile position offset within its cell. 0 = perfectly aligned grid; 1 = tile may shift up to ±0.5 cell',
    },
    {
      name: 'rotation_jitter',
      type: 'Float',
      default: 0.5,
      min: 0,
      max: 1,
      description: 'per-tile random rotation. 0 = none; 1 = ±π (full rotation)',
    },
    {
      name: 'scale_jitter',
      type: 'Float',
      default: 0.2,
      min: 0,
      max: 1,
      description: 'per-tile scale variation. 0 = uniform size; 1 = ±100% (some tiles tiny, some huge)',
    },
    {
      name: 'hue_jitter',
      type: 'Float',
      default: 0,
      min: 0,
      max: 1,
      description: 'per-tile hue shift in turns. 0 = no shift; 0.2 = ±0.1 turn around the colour wheel; 1 = full wheel',
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0,
      description: 'changes the random pattern. Same seed = same layout',
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
      description: 'the stamp tiled across the output with per-tile random offset, rotation, scale, and hue',
    },
  ],
  doc: {
    summary: 'Tile a stamp texture across the output with per-cell random offset, rotation, scale, and hue.',
    description: `
A small "tile sampler" — like Substance Designer's, but minimal. The input
\`stamp\` is the per-cell texture (often a single object on transparent
background); each grid cell gets independently-hashed random transforms
applied. With \`hue_jitter\` > 0, the stamp also gets per-tile hue rotation
in HSV space.

Common uses:

- scatter a single pebble texture into a procedural gravel layer
- arrange a single leaf into a forest-floor mass
- tile a brick stamp with rotation jitter for an irregular cobblestone look

For a fixed-grid hex pattern instead, use
[tex/hex-tile](../../tex/hex-tile). For a single stamp at a precise UV
transform, use [tex/transform](../../tex/transform).
`,
    sampleGraph: () => {
      const g = createGraph();
      // A radial gradient as the stamp — visible jitter without
      // needing an external image.
      const stamp = addNode(g, 'tex/radial-gradient', {
        id: 'stamp',
        position: { x: 0, y: 0 },
        inputValues: {
          inner_color: [0.95, 0.55, 0.20, 1],
          outer_color: [0.05, 0.07, 0.12, 1],
          centre: [0.5, 0.5],
          radius: 0.45,
          smoothness: 1,
          resolution: 256,
        },
      });
      const tile = addNode(g, 'tex/tile-with-jitter', {
        id: 'tile',
        position: { x: 280, y: 0 },
        inputValues: {
          divisions: [8, 8],
          position_jitter: 0.3,
          rotation_jitter: 0.5,
          scale_jitter: 0.2,
          hue_jitter: 0.1,
          seed: 0,
          resolution: 512,
        },
      });
      addEdge(g, { node: stamp.id, socket: 'texture' }, { node: tile.id, socket: 'stamp' });
      return { graph: g, rootNodeId: 'tile' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const src = inputs.stamp as Texture2DValue;
    const divisions = inputs.divisions as [number, number];
    const positionJitter = inputs.position_jitter as number;
    const rotationJitter = inputs.rotation_jitter as number;
    const scaleJitter = inputs.scale_jitter as number;
    const hueJitter = inputs.hue_jitter as number;
    const seed = inputs.seed as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'tile-with-jitter-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec2 divisions (8) + 5 × f32 (20) + pad (4) = 32 bytes.
    const uniformData = new Float32Array(8);
    uniformData[0] = divisions[0];
    uniformData[1] = divisions[1];
    uniformData[2] = positionJitter;
    uniformData[3] = rotationJitter;
    uniformData[4] = scaleJitter;
    uniformData[5] = hueJitter;
    uniformData[6] = seed;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Clamp-to-edge so a rotated/scaled stamp doesn't smear the
    // neighbour cells when its sample uv goes outside [0,1] — the
    // alpha goes to whatever the source has on its edge, typically 0
    // for stamp-on-transparent.
    const sampler = getSampler(device, {
      label: 'tile-with-jitter-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const module = getShaderModule(device, shader);
    const { bindGroupLayout: bgl, pipeline } = getPipelineWithLayout(
      device,
      UNIFORM_TEX_SAMP_BGL,
      (layout) => ({
        label: 'tile-with-jitter-pipeline',
        layout,
        vertex: { module },
        fragment: { module, targets: [{ format: TEXTURE_FORMAT }] },
      }),
    );

    const bindGroup = reusableBindGroup(
      device,
      prev?.__bindGroup,
      bgl,
      [uniformBuffer, src.texture, sampler],
      () => [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: src.texture },
        { binding: 2, resource: sampler },
      ],
    );

    const encoder = device.createCommandEncoder({ label: 'tile-with-jitter-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'tile-with-jitter-pass',
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
