import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableTexture,
} from '../core/resources.js';
import { getRenderPipeline, getSampler, getShaderModule } from '../render/gpu-cache.js';
import shader from './blend-mask.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

// Per-pixel mask blend: each output texel = mix(a, b, mask.r). Use cases:
// splat-paint terrain (grass × rock keyed by a slope mask), regional color
// swaps, weather effects, etc. The companion `core/blend` uses a uniform
// factor instead of a mask texture.
export const blendMaskNode: NodeDef = {
  id: 'core/blend-mask',
  category: 'Texture/Filters',
  inputs: [
    {
      name: 'a',
      type: 'Texture2D',
      description: 'background texture — shows through where mask is 0',
    },
    {
      name: 'b',
      type: 'Texture2D',
      description: 'foreground texture — shows where mask is 1',
    },
    {
      name: 'mask',
      type: 'Texture2D',
      description: 'per-pixel mix factor sampled from the R channel: 0 = pure a, 1 = pure b, intermediate values lerp linearly',
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
      description: 'per-pixel `mix(a, b, mask.r)` — same shape as core/blend but each pixel\'s factor comes from the mask instead of a uniform value',
    },
  ],
  doc: {
    summary: 'Per-pixel mask blend: mix(a, b, mask.r) per texel.',
    description: `
Same operation as [core/blend](../../core/blend)'s \`mix\` mode, but the blend
factor comes from a mask texture instead of a single Float. Each output
pixel = \`mix(a, b, mask.r)\`.

The classic use is splat-painting terrain — wire a
[core/slope-from-height](../../core/slope-from-height) mask into \`mask\`,
rock into \`b\`, grass into \`a\`, and you get rock on the steeps and grass on
the flats with smooth transitions. Other use cases: regional colour swaps
(paint where a city goes), weather effects (snow accumulation by altitude
mask), or any blend where the strength varies across the texture.
`,
    sampleGraph: () => {
      const g = createGraph();
      const a = addNode(g, 'core/solid-color', {
        id: 'grass',
        position: { x: 0, y: 0 },
        inputValues: { color: [1, 0, 0, 1], resolution: 256 },
      });
      const b = addNode(g, 'core/solid-color', {
        id: 'rock',
        position: { x: 0, y: 180 },
        inputValues: { color: [0, 1, 1, 1], resolution: 256 },
      });
      const mask = addNode(g, 'core/perlin', {
        id: 'mask',
        position: { x: 0, y: 360 },
        inputValues: { scale: [4, 4], octaves: 4, lacunarity: 2, gain: -0.75, seed: 0, resolution: 256 },
      });
      const blendMask = addNode(g, 'core/blend-mask', {
        id: 'blend',
        position: { x: 280, y: 180 },
        inputValues: { resolution: 256 },
      });
      addEdge(g, { node: a.id, socket: 'texture' }, { node: blendMask.id, socket: 'a' });
      addEdge(g, { node: b.id, socket: 'texture' }, { node: blendMask.id, socket: 'b' });
      addEdge(g, { node: mask.id, socket: 'texture' }, { node: blendMask.id, socket: 'mask' });
      return { graph: g, rootNodeId: 'blend' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const a = inputs.a as Texture2DValue;
    const b = inputs.b as Texture2DValue;
    const mask = inputs.mask as Texture2DValue;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    const sampler = getSampler(device, {
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });

    const module = getShaderModule(device, shader);
    const pipeline = getRenderPipeline(device, {
      layout: 'auto',
      vertex: { module },
      fragment: { module, targets: [{ format: TEXTURE_FORMAT }] },
    });

    const bindGroup = reusableBindGroup(
      device,
      prev?.__bindGroup,
      pipeline.getBindGroupLayout(0),
      [a.texture, b.texture, mask.texture, sampler],
      () => [
        { binding: 0, resource: a.texture },
        { binding: 1, resource: b.texture },
        { binding: 2, resource: mask.texture },
        { binding: 3, resource: sampler },
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
