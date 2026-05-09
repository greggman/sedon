import type { GeometryValue, MaterialValue } from '../core/resources.js';
import type { Mat4 } from './mat4.js';
import { createScenePipeline } from './pipeline.js';
import shaderCode from './shader.wgsl';

export interface SceneRenderer {
  render(params: {
    encoder: GPUCommandEncoder;
    colorView: GPUTextureView;
    depthView: GPUTextureView;
    clearColor: GPUColorDict;
    modelView: Mat4;
    projection: Mat4;
  }): void;
}

export function createSceneRenderer(
  device: GPUDevice,
  format: GPUTextureFormat,
  geometry: GeometryValue,
  material: MaterialValue,
): SceneRenderer {
  const pipeline = createScenePipeline(device, format, shaderCode);

  const sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });

  const uniformBuffer = device.createBuffer({
    size: 128, // two mat4x4f
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: material.basecolor.view },
      { binding: 2, resource: sampler },
    ],
  });

  return {
    render({ encoder, colorView, depthView, clearColor, modelView, projection }) {
      device.queue.writeBuffer(uniformBuffer, 0, modelView as BufferSource);
      device.queue.writeBuffer(uniformBuffer, 64, projection as BufferSource);

      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: colorView, clearValue: clearColor, loadOp: 'clear', storeOp: 'store' },
        ],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setVertexBuffer(0, geometry.positionBuffer);
      pass.setVertexBuffer(1, geometry.normalBuffer);
      pass.setVertexBuffer(2, geometry.uvBuffer);
      pass.setIndexBuffer(geometry.indexBuffer, geometry.indexFormat);
      pass.drawIndexed(geometry.indexCount);
      pass.end();
    },
  };
}
