import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableTexture,
} from '../core/resources.js';
import { ShaderStage, getPipelineWithLayout, getSampler, getShaderModule } from '../render/gpu-cache.js';

const TWO_TEX_SAMP_BGL: GPUBindGroupLayoutDescriptor = {
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ],
};
import shader from './colorize.wgsl';

// Remap a single-channel input through a 1D RAMP TEXTURE. Pairs with
// `core/ramp` for authored gradients, but any Nx1 RGBA texture works
// as the palette source — e.g. a sampled brand-colour strip, a heat
// map LUT, etc.
//
// The shader does the half-texel sample-uv correction so a 2-pixel
// ramp behaves like a clean 0→1 lerp, not a "stuck at endpoint until
// 0.25" step — see colorize.wgsl. Authors using `core/ramp` get the
// expected linear behaviour by default; authors using an arbitrary
// LUT texture get the same correction for free.

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const colorizeNode: NodeDef = {
  id: 'core/colorize',
  category: 'Texture/Filters',
  inputs: [
    {
      name: 'factor',
      type: 'Texture2D',
      description: 'single-channel input. Its red value at each pixel is the parameter t ∈ [0,1] that samples the ramp; e.g. a perlin texture becomes a ramp-coloured noise pattern',
    },
    {
      name: 'ramp',
      type: 'Texture2D',
      description: 'Nx1 colour palette texture (typically from `core/ramp`). Sampled by the per-pixel factor value to produce the output colour. Any Texture2D works — but ramps are 1-row wide because only the U axis matters',
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
      description: 'the factor texture remapped through the ramp: each input pixel\'s luminance picks the colour from the corresponding spot along the ramp',
    },
  ],
  doc: {
    summary: 'Photoshop-style Gradient Map — remap a texture through a 1D colour ramp.',
    description: `
For each pixel in \`factor\`, compute its Rec. 709 luminance (so a colour
image weighs green > red > blue, matching perception; a single-channel mask
just passes its red value through), use that as t ∈ [0, 1], and sample
\`ramp\` at uv = (t, 0.5) for the output colour.

The classic procedural-texture pattern: noise → colorize. A
[core/perlin](../../core/perlin) noise on its own is just greyscale wash.
Pipe it through colorize with a hand-tuned [core/ramp](../../core/ramp) (or
one built from a [core/palette](../../core/palette) node taking
subgraph-input colours) and you get a tinted, gradient-mapped result with
all the structure of the noise but the colour of the ramp. Works just as
well on [core/worley](../../core/worley),
[core/ridged-noise](../../core/ridged-noise),
[core/distance-transform](../../core/distance-transform) — anything that
ends up in the [0, 1] range.
`,
    sampleGraph: () => {
      const g = createGraph();
      const noise = addNode(g, 'core/perlin', {
        id: 'noise',
        position: { x: 0, y: 0 },
        inputValues: { scale: [4, 4], octaves: 5, lacunarity: 2, gain: 0.5, seed: 0, resolution: 512 },
      });
      const ramp = addNode(g, 'core/ramp', {
        id: 'ramp',
        position: { x: 0, y: 220 },
        inputValues: {
          gradient: [
            { position: 0, color: [0.10, 0.18, 0.40, 1] },
            { position: 0.5, color: [0.85, 0.55, 0.20, 1] },
            { position: 1, color: [0.98, 0.92, 0.70, 1] },
          ],
          interpolation: 0,
          resolution: 256,
        },
      });
      const colorize = addNode(g, 'core/colorize', {
        id: 'colorize',
        position: { x: 280, y: 110 },
        inputValues: { resolution: 512 },
      });
      addEdge(g, { node: noise.id, socket: 'texture' }, { node: colorize.id, socket: 'factor' });
      addEdge(g, { node: ramp.id, socket: 'texture' }, { node: colorize.id, socket: 'ramp' });
      return { graph: g, rootNodeId: 'colorize' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const factor = inputs.factor as Texture2DValue;
    const ramp = inputs.ramp as Texture2DValue;
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

    // Linear filtering covers both the factor sample (smooth across
    // the input) and the ramp sample (smooth between adjacent stop
    // colours). Repeat addressing for factor only affects authoring
    // edge cases; clamp would also be fine here.
    const sampler = getSampler(device, {
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });

    const module = getShaderModule(device, shader);
    const { bindGroupLayout: bgl, pipeline } = getPipelineWithLayout(
      device,
      TWO_TEX_SAMP_BGL,
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
      [factor.texture, ramp.texture, sampler],
      () => [
        { binding: 0, resource: factor.texture },
        { binding: 1, resource: ramp.texture },
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

    return { texture: out, __bindGroup: bindGroup };
  },
};
