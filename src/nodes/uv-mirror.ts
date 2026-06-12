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
import shader from './uv-mirror.wgsl';

const UNIFORM_TEX_SAMP_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'uv-mirror-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const uvMirrorNode: NodeDef = {
  id: 'tex/uv-mirror',
  category: 'Texture/Filters',
  inputs: [
    {
      name: 'input',
      type: 'Texture2D',
      description: 'source texture to mirror',
    },
    {
      name: 'mirror_u',
      type: 'Int',
      default: 1,
      description: 'mirror horizontally across the U axis',
      enumOptions: [
        { value: 0, label: 'off' },
        { value: 1, label: 'on' },
      ],
    },
    {
      name: 'mirror_v',
      type: 'Int',
      default: 0,
      description: 'mirror vertically across the V axis',
      enumOptions: [
        { value: 0, label: 'off' },
        { value: 1, label: 'on' },
      ],
    },
    {
      name: 'axis',
      type: 'Vec2',
      default: [0.5, 0.5],
      description: 'mirror axis location in UV units. [0.5, 0.5] = mirror around the image centre. Move this off-centre to mirror around a different line',
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
      description: 'the input mirrored around the chosen axis on the selected sides',
    },
  ],
  doc: {
    summary: 'Kaleidoscope-style UV mirroring around a chosen axis.',
    description: `
For each pixel, sample the input from \`axis + abs(uv − axis)\` on the
mirrored axes. The effect is symmetric: enabling \`mirror_u\` makes the
left half a reflection of the right; both on gives quadrant symmetry.

Useful for:

- making any noise texture seamless / symmetric for tiling
- kaleidoscope effects (chain with [tex/uv-polar](../../tex/uv-polar))
- building decorative wallpaper patterns from a single asymmetric tile
`,
    sampleGraph: () => {
      const g = createGraph();
      const src = addNode(g, 'tex/perlin', {
        id: 'src',
        position: { x: 0, y: 0 },
        inputValues: { scale: [4, 4], octaves: 4, lacunarity: 2, gain: 0.5, seed: 0, resolution: 512 },
      });
      const m = addNode(g, 'tex/uv-mirror', {
        id: 'm',
        position: { x: 280, y: 0 },
        inputValues: { mirror_u: 1, mirror_v: 1, axis: [0.5, 0.5], resolution: 512 },
      });
      addEdge(g, { node: src.id, socket: 'texture' }, { node: m.id, socket: 'input' });
      return { graph: g, rootNodeId: 'm' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const src = inputs.input as Texture2DValue;
    const axis = inputs.axis as [number, number];
    const mu = inputs.mirror_u as number;
    const mv = inputs.mirror_v as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'uv-mirror-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    const uniformData = new Float32Array(4);
    uniformData[0] = axis[0];
    uniformData[1] = axis[1];
    uniformData[2] = mu;
    uniformData[3] = mv;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Mirror reads outside [0,1] are intentional (mirror around an
    // off-centre axis), so clamp-to-edge here so the read doesn't tile
    // the source mirror-of-mirror style. Authors who want repeat after
    // the fold can chain a tex/transform.
    const sampler = getSampler(device, {
      label: 'uv-mirror-sampler',
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
        label: 'uv-mirror-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'uv-mirror-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'uv-mirror-pass',
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
