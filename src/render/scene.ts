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

  const sceneUniformBuffer = device.createBuffer({
    size: 128, // two mat4x4f
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Material uniforms: { roughness: f32, metallic: f32 }. Pad to 16 bytes for
  // the WebGPU uniform-buffer minimum.
  const materialUniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const materialData = new Float32Array(4);
  materialData[0] = material.roughness;
  materialData[1] = material.metallic;
  device.queue.writeBuffer(materialUniformBuffer, 0, materialData as BufferSource);

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: sceneUniformBuffer } },
      { binding: 1, resource: material.basecolor.view },
      { binding: 2, resource: sampler },
      { binding: 3, resource: { buffer: materialUniformBuffer } },
    ],
  });

  return {
    render({ encoder, colorView, depthView, clearColor, modelView, projection }) {
      device.queue.writeBuffer(sceneUniformBuffer, 0, modelView as BufferSource);
      device.queue.writeBuffer(sceneUniformBuffer, 64, projection as BufferSource);

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
