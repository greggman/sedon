import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { getRenderPipeline, getShaderModule } from '../render/gpu-cache.js';
import shader from './path-mask.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

// Procedural path/road coverage mask. Default output is INVERTED (white
// off the path, dark on it) so it multiplies into a density map to leave
// the path bare — e.g. grass density × path-mask = no grass on the road.
// Set invert=false to get the road surface itself (white on path).
export const pathMaskNode: NodeDef = {
  id: 'core/path-mask',
  category: 'Texture/Generators',
  inputs: [
    { name: 'angle', type: 'Float', default: 20, description: 'Path direction, degrees.' },
    { name: 'offset', type: 'Float', default: 0.5, description: 'Position across the texture (0..1).' },
    { name: 'width', type: 'Float', default: 0.07, description: 'Half-width of the path (UV units).' },
    { name: 'waviness', type: 'Float', default: 0.08, description: 'How much the path meanders.' },
    { name: 'waveScale', type: 'Float', default: 2, description: 'Meander frequency along the path.' },
    { name: 'softness', type: 'Float', default: 0.025, description: 'Edge feather width.' },
    {
      name: 'invert',
      type: 'Bool',
      default: true,
      description: 'true = white OFF path (multiply into density to carve it); false = white ON path.',
    },
    { name: 'resolution', type: 'Int', default: 256 },
  ],
  outputs: [{ name: 'texture', type: 'Texture2D' }],
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const angle = inputs.angle as number;
    const offset = inputs.offset as number;
    const width = inputs.width as number;
    const waviness = inputs.waviness as number;
    const waveScale = inputs.waveScale as number;
    const softness = inputs.softness as number;
    const invert = inputs.invert as boolean;
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

    // cfg0: angle(rad), offset, width, waviness | cfg1: waveScale, softness, invert, pad
    const uniformData = new Float32Array(8);
    uniformData[0] = (angle * Math.PI) / 180;
    uniformData[1] = offset;
    uniformData[2] = width;
    uniformData[3] = waviness;
    uniformData[4] = waveScale;
    uniformData[5] = softness;
    uniformData[6] = invert ? 1 : 0;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

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
      [uniformBuffer],
      () => [{ binding: 0, resource: uniformBuffer }],
    );

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: out.texture, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
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
