import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type {
  ReusableBindGroup,
  Texture2DValue,
} from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableTexture,
} from '../core/resources.js';
import { ShaderStage, getPipelineWithLayout, getSampler, getShaderModule } from '../render/gpu-cache.js';
import blitShader from '../editor/blit.wgsl';

const TEX_SAMP_BGL: GPUBindGroupLayoutDescriptor = {
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 1, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ],
};

// Convert a Texture2D's format. The two formats we support are:
//   • rgba8unorm — 8-bit per channel, values clamped to [0, 1]. The
//     default everywhere; cheapest in memory; lossy for terrain
//     authoring once you want real altitude ranges.
//   • rgba16float — 16-bit half-float per channel, values can be
//     negative or > 1. The format you upgrade to once you start using
//     a texture as a heightfield in metres (or any pipeline that
//     wants real-valued data through filters).
//
// Implementation is a textureSample blit through the existing
// fragment shader — same one the docs / in-node texture previews use.
// Cost is a single render pass; if formats match we don't even need
// to convert and the node is a passthrough.

const FORMAT_BY_INDEX: Record<number, GPUTextureFormat> = {
  0: 'rgba8unorm',
  1: 'rgba16float',
};

export const textureConvertNode: NodeDef = {
  id: 'tex/convert',
  category: 'Texture/Format',
  inputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'source texture, any supported format',
    },
    {
      name: 'format',
      type: 'Int',
      default: 1,
      description: 'output texture format. rgba8unorm fits values in [0, 1] at 8 bits per channel; rgba16float supports negative values and values > 1 at 16-bit half-float per channel — required for using a texture as a heightfield in metres or for any chain that needs real-valued precision through filters',
      enumOptions: [
        { value: 0, label: 'rgba8unorm' },
        { value: 1, label: 'rgba16float' },
      ],
    },
  ],
  outputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'the input texture re-rendered into the chosen format',
    },
  ],
  doc: {
    summary: 'Convert a texture\'s format — typically rgba8unorm → rgba16float for heightfield authoring.',
    description: `
The escape hatch for picking the texture format explicitly. Most
filter nodes preserve their input's format; this is the node you use
when you need to upgrade (rgba8unorm → rgba16float) or downgrade
(rgba16float → rgba8unorm).

The terrain-authoring pattern: a noise generator emits rgba8unorm
values in [0, 1]; you pipe through this node with \`format:
rgba16float\` to get a float texture, then use
[tex/map-range](../../tex/map-range) to scale the
values to real altitudes (metres). The result feeds straight into
[geom/heightfield-from-texture](../../geom/heightfield-from-texture)
or [terrain/renderer](../../terrain/renderer) — the consumer reads R
as world Y directly, no remap needed.

Implementation is a single fragment-shader blit, so cost is roughly
"one filter pass." If the source format already matches the requested
one this could be a passthrough — today it still re-blits, which is
cheap enough not to bother optimising.
`,
    sampleGraph: () => {
      const g = createGraph();
      const noise = addNode(g, 'tex/perlin', {
        id: 'noise',
        position: { x: 0, y: 0 },
        inputValues: { scale: [3, 3], octaves: 5, lacunarity: 2, gain: 0.5, seed: 0, resolution: 256 },
      });
      const convert = addNode(g, 'tex/convert', {
        id: 'convert',
        position: { x: 280, y: 0 },
        inputValues: { format: 1 },
      });
      addEdge(g, { node: noise.id, socket: 'texture' }, { node: convert.id, socket: 'texture' });
      return { graph: g, rootNodeId: 'convert' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const src = inputs.texture as Texture2DValue;
    const format = FORMAT_BY_INDEX[inputs.format as number] ?? 'rgba16float';

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __bindGroup?: ReusableBindGroup;
    } | undefined;

    const out = reusableTexture(device, prev?.texture, {
      width: src.width,
      height: src.height,
      format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    const sampler = getSampler(device, {
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const module = getShaderModule(device, blitShader);
    const { bindGroupLayout: bgl, pipeline } = getPipelineWithLayout(
      device,
      TEX_SAMP_BGL,
      (layout) => ({
        layout,
        vertex: { module },
        fragment: { module, targets: [{ format }] },
      }),
    );

    const bindGroup = reusableBindGroup(
      device,
      prev?.__bindGroup,
      bgl,
      [src.texture, sampler],
      () => [
        { binding: 0, resource: src.texture },
        { binding: 1, resource: sampler },
      ],
    );

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
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

    return { texture: out, __bindGroup: bindGroup };
  },
};
