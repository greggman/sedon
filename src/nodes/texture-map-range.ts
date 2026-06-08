import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type {
  ReusableBindGroup,
  Texture2DValue,
} from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { ShaderStage, getPipelineWithLayout, getSampler, getShaderModule } from '../render/gpu-cache.js';

const UNIFORM_TEX_SAMP_BGL: GPUBindGroupLayoutDescriptor = {
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ],
};
import shader from './texture-map-range.wgsl';

// Per-pixel linear remap: textures-shaped counterpart to
// `core/map-range`. Each output pixel's RGB is computed from the
// input's RGB by the same formula:
//
//     t = (value - in_min) / (in_max - in_min)
//     out = out_min + t * (out_max - out_min)
//
// Optionally clamped to [out_min, out_max] when `clamp` is true.
// Alpha passes through.
//
// The canonical terrain-authoring use: a perlin noise emits values in
// [0, 1]; pipe through this with in_min=0, in_max=1, out_min=0,
// out_max=50 to get a heightfield with altitudes in [0, 50] metres.
// Because the output format matches the input, you'd typically run
// the noise through `core/texture-convert` to rgba16float FIRST so
// the post-remap values aren't clipped to [0, 1] by the rgba8unorm
// format.

export const textureMapRangeNode: NodeDef = {
  id: 'core/texture-map-range',
  category: 'Texture/Filters',
  inputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'source texture; RGB channels are remapped, alpha is passed through. For values that need to exceed [0, 1] (heightfields, signed data), the source must be rgba16float — use [core/texture-convert](../../core/texture-convert) to upgrade format first',
    },
    {
      name: 'in_min',
      type: 'Float',
      default: 0,
      description: 'lower bound of the input range — gets mapped to out_min',
    },
    {
      name: 'in_max',
      type: 'Float',
      default: 1,
      description: 'upper bound of the input range — gets mapped to out_max',
    },
    {
      name: 'out_min',
      type: 'Float',
      default: 0,
      description: 'lower bound of the output range',
    },
    {
      name: 'out_max',
      type: 'Float',
      default: 1,
      description: 'upper bound of the output range',
    },
    {
      name: 'clamp',
      type: 'Bool',
      default: false,
      description: 'if true, output is bounded to [out_min, out_max]; if false, values outside [in_min, in_max] extrapolate linearly past the output range',
    },
  ],
  outputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'the input texture with every RGB pixel linearly remapped. Format and dimensions match the input',
    },
  ],
  doc: {
    summary: 'Per-pixel linear remap of a texture — same shape as [core/map-range](../../core/map-range) but for textures.',
    description: `
For each pixel \`(r, g, b, a)\` in the source, compute \`t = (rgb -
in_min) / (in_max - in_min)\`, then \`out_rgb = out_min + t · (out_max
- out_min)\`. Alpha passes through unchanged. When \`clamp\` is true
the output is bounded to \`[out_min, out_max]\`; when false, values
outside the input range extrapolate.

The canonical terrain-authoring use: a Perlin noise emits values in
[0, 1]; pipe through this with \`out_min=0, out_max=50\` to get
altitudes in [0, 50] metres. The values exceed [0, 1] so the texture
needs to be rgba16float — run through
[core/texture-convert](../../core/texture-convert) first to upgrade
the format, then map-range, then feed the result into
[core/texture-to-heightfield-mesh](../../core/texture-to-heightfield-mesh)
or [terrain/renderer](../../terrain/renderer).

For Float-to-Float remapping see [core/map-range](../../core/map-range).
`,
    sampleGraph: () => {
      const g = createGraph();
      const noise = addNode(g, 'core/perlin', {
        id: 'noise',
        position: { x: 0, y: 0 },
        inputValues: { scale: [3, 3], octaves: 5, lacunarity: 2, gain: 0.5, seed: 0, resolution: 256 },
      });
      const toFloat = addNode(g, 'core/texture-convert', {
        id: 'toFloat',
        position: { x: 280, y: 0 },
        inputValues: { format: 1 },
      });
      const remap = addNode(g, 'core/texture-map-range', {
        id: 'remap',
        position: { x: 560, y: 0 },
        inputValues: { in_min: 0, in_max: 1, out_min: 0, out_max: 50, clamp: false },
      });
      addEdge(g, { node: noise.id, socket: 'texture' }, { node: toFloat.id, socket: 'texture' });
      addEdge(g, { node: toFloat.id, socket: 'texture' }, { node: remap.id, socket: 'texture' });
      return { graph: g, rootNodeId: 'remap' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const src = inputs.texture as Texture2DValue;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;

    // Output preserves the input's format. That's the key behaviour
    // for terrain authoring — feed in an rgba16float, get an
    // rgba16float back with the values remapped.
    const out = reusableTexture(device, prev?.texture, {
      width: src.width,
      height: src.height,
      format: src.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // Uniforms: 5 floats + 3 pad → 32 bytes (8-float alignment).
    const uniformData = new Float32Array(8);
    uniformData[0] = inputs.in_min as number;
    uniformData[1] = inputs.in_max as number;
    uniformData[2] = inputs.out_min as number;
    uniformData[3] = inputs.out_max as number;
    uniformData[4] = (inputs.clamp as boolean) ? 1 : 0;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const sampler = getSampler(device, {
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
        layout,
        vertex: { module },
        fragment: { module, targets: [{ format: src.format }] },
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

    return { texture: out, __uniformBuffer: uniformBuffer, __bindGroup: bindGroup };
  },
};
