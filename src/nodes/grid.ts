import type { NodeDef } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import gridShader from './grid.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const gridNode: NodeDef = {
  id: 'core/grid',
  category: 'Texture/Generators',
  inputs: [
    { name: 'fg', type: 'Color', default: [0, 0, 0, 1] },
    { name: 'bg', type: 'Color', default: [1, 1, 1, 1] },
    { name: 'divisions', type: 'Vec2i', default: [8, 8] },
    { name: 'line_width', type: 'Float', default: 0.05 },
    { name: 'resolution', type: 'Int', default: 512 },
  ],
  outputs: [{ name: 'texture', type: 'Texture2D' }],
  evaluate(ctx, inputs): { texture: Texture2DValue } {
    const device = requireDevice(ctx);
    const fg = inputs.fg as [number, number, number, number];
    const bg = inputs.bg as [number, number, number, number];
    const divisions = inputs.divisions as [number, number];
    const lineWidth = inputs.line_width as number;
    const resolution = inputs.resolution as number;

    const texture = device.createTexture({
      size: [resolution, resolution],
      format: TEXTURE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    // 16-byte aligned uniform: vec4 fg, vec4 bg, vec2 divisions, f32 line_width, f32 pad.
    const uniformData = new Float32Array(12);
    uniformData.set(fg, 0);
    uniformData.set(bg, 4);
    uniformData[8] = divisions[0];
    uniformData[9] = divisions[1];
    uniformData[10] = lineWidth;
    uniformData[11] = 0;

    const uniformBuffer = device.createBuffer({
      size: uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformData as BufferSource);

    const module = device.createShaderModule({ code: gridShader });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module },
      fragment: { module, targets: [{ format: TEXTURE_FORMAT }] },
    });

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);

    return {
      texture: {
        texture,
        view: texture.createView(),
        format: TEXTURE_FORMAT,
        width: resolution,
        height: resolution,
      },
    };
  },
};
