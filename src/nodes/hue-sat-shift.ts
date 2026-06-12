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
import shader from './hue-sat-shift.wgsl';

const UNIFORM_TEX_SAMP_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'hue-sat-shift-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const hueSatShiftNode: NodeDef = {
  id: 'tex/hue-sat-shift',
  category: 'Texture/Filters',
  inputs: [
    {
      name: 'input',
      type: 'Texture2D',
      description: 'source texture to shift',
    },
    {
      name: 'hue',
      type: 'Float',
      default: 0,
      description: 'hue shift in turns. 0 = no change; 0.5 = swap complementary; values wrap around the colour wheel',
    },
    {
      name: 'saturation',
      type: 'Float',
      default: 1,
      min: 0,
      description: 'saturation multiplier. 1 = unchanged; 0 = fully greyscale; > 1 boosts',
    },
    {
      name: 'value',
      type: 'Float',
      default: 1,
      min: 0,
      description: 'value (brightness) multiplier. 1 = unchanged; < 1 darkens; > 1 brightens',
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
      description: 'the input with each pixel converted to HSV, shifted, then back to RGB',
    },
  ],
  doc: {
    summary: 'Hue / saturation / value adjustment in HSV space.',
    description: `
Per-pixel RGB → HSV → shift → RGB. The classic colour-correction trio:

- \`hue\` rotates around the colour wheel (in turns, so 0.5 = swap to the
  opposite hue)
- \`saturation\` desaturates (0 = greyscale) or boosts (> 1 over-saturates)
- \`value\` brightens or darkens

For a non-multiplicative brightness adjustment (additive shift), or to
control mid-tones via a gamma curve, reach for [tex/levels](../../tex/levels)
instead. Hue shift in particular is the easy way to retune a palette
without re-authoring the colour stops.
`,
    sampleGraph: () => {
      const g = createGraph();
      const src = addNode(g, 'tex/linear-gradient', {
        id: 'src',
        position: { x: 0, y: 0 },
        inputValues: {
          color_a: [0.95, 0.20, 0.20, 1],
          color_b: [0.20, 0.60, 0.95, 1],
          angle: 0,
          smoothness: 0,
          resolution: 512,
        },
      });
      const hs = addNode(g, 'tex/hue-sat-shift', {
        id: 'hs',
        position: { x: 280, y: 0 },
        inputValues: { hue: 0.15, saturation: 1.2, value: 1, resolution: 512 },
      });
      addEdge(g, { node: src.id, socket: 'texture' }, { node: hs.id, socket: 'input' });
      return { graph: g, rootNodeId: 'hs' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const src = inputs.input as Texture2DValue;
    const hue = inputs.hue as number;
    const sat = inputs.saturation as number;
    const val = inputs.value as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'hue-sat-shift-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    const uniformData = new Float32Array(4);
    uniformData[0] = hue;
    uniformData[1] = sat;
    uniformData[2] = val;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const sampler = getSampler(device, {
      label: 'hue-sat-shift-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });

    const module = getShaderModule(device, shader);
    const { bindGroupLayout: bgl, pipeline } = getPipelineWithLayout(
      device,
      UNIFORM_TEX_SAMP_BGL,
      (layout) => ({
        label: 'hue-sat-shift-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'hue-sat-shift-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'hue-sat-shift-pass',
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
