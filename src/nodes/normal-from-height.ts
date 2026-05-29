import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { getRenderPipeline, getSampler, getShaderModule } from '../render/gpu-cache.js';
import shader from './normal-from-height.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const normalFromHeightNode: NodeDef = {
  id: 'core/normal-from-height',
  category: 'Texture/Filters',
  inputs: [
    {
      name: 'height',
      type: 'Texture2D',
      description: 'greyscale heightfield: the R channel is read as height. Brighter pixels stand higher',
    },
    {
      name: 'strength',
      type: 'Float',
      default: 4,
      description: 'vertical exaggeration. >0 reads bright = raised; <0 inverts so bright = sunken (good for carved-in features like leaf veins or stone fractures)',
    },
    {
      name: 'resolution',
      type: 'Int',
      default: 512,
      description: 'output texture width and height in pixels',
    },
  ],
  outputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'tangent-space normal map encoded as RGB: (nx, ny, nz) stored in the standard (rgb · 0.5 + 0.5) encoding. Plug into a material\'s normal slot',
    },
  ],
  doc: {
    summary: 'Convert a heightfield texture into a tangent-space normal map.',
    description:
      'Samples the input height\'s slope using a central-difference filter (one tap left, ' +
      'one right, one up, one down), builds the per-pixel surface tangent and bitangent, ' +
      'cross-products them to get the normal, and encodes the result into RGB.\n\n' +
      'Negative strength flips the apparent direction — useful for "carved" features like ' +
      'leaf veins where the dark pixels in the height map should read as valleys not ridges. ' +
      'Pair with the output of Perlin / Worley / Distance-Transform / Levels chains to get ' +
      'surface micro-detail "for free" without modelling geometry.',
    sampleGraph: () => {
      const g = createGraph();
      const src = addNode(g, 'core/perlin', {
        id: 'src',
        position: { x: 0, y: 0 },
        inputValues: { scale: [6, 6], octaves: 4, lacunarity: 2, gain: -0.75, seed: 0, resolution: 512 },
      });
      const nfh = addNode(g, 'core/normal-from-height', {
        id: 'normal',
        position: { x: 280, y: 0 },
        inputValues: { strength: 4, resolution: 512 },
      });
      addEdge(g, { node: src.id, socket: 'texture' }, { node: nfh.id, socket: 'height' });
      return { graph: g, rootNodeId: 'normal' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const height = inputs.height as Texture2DValue;
    const strength = inputs.strength as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
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

    const uniformData = new Float32Array(4);
    uniformData[0] = strength;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

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
      [uniformBuffer, height.texture, sampler],
      () => [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: height.texture },
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
