import type { GeometryValue, MaterialValue, Texture2DValue } from '../core/resources.js';
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

// Tangent-space "no perturbation": (0, 0, 1) → (0.5, 0.5, 1.0) when packed into
// rgba8unorm. The shader unpacks via `n*2-1` so this maps back to (0, 0, 1).
function createFlatNormalTexture(device: GPUDevice): Texture2DValue {
  const format: GPUTextureFormat = 'rgba8unorm';
  const texture = device.createTexture({
    size: [1, 1],
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const pixel = new Uint8Array([128, 128, 255, 255]);
  device.queue.writeTexture(
    { texture },
    pixel as BufferSource,
    { bytesPerRow: 4 },
    [1, 1],
  );
  return {
    texture,
    view: texture.createView(),
    format,
    width: 1,
    height: 1,
  };
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

  // Material uniforms: { roughness: f32, metallic: f32 }. Pad to 16.
  const materialUniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const materialData = new Float32Array(4);
  materialData[0] = material.roughness;
  materialData[1] = material.metallic;
  device.queue.writeBuffer(materialUniformBuffer, 0, materialData as BufferSource);

  // If the user didn't wire a normal map, plug in a 1×1 flat-normal default so
  // the bind group always has a binding and the shader doesn't need a branch.
  const normalTexture = material.normal ?? createFlatNormalTexture(device);

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: sceneUniformBuffer } },
      { binding: 1, resource: material.basecolor.view },
      { binding: 2, resource: sampler },
      { binding: 3, resource: { buffer: materialUniformBuffer } },
      { binding: 4, resource: normalTexture.view },
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
