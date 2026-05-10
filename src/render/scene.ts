import type {
  GeometryValue,
  MaterialValue,
  SceneEntity,
  SceneValue,
  Texture2DValue,
} from '../core/resources.js';
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

// Tangent-space "no perturbation": (0, 0, 1) → (0.5, 0.5, 1.0) when packed
// into rgba8unorm. Used as the normal-map binding for materials that don't
// carry one, so the bind group layout stays uniform.
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

interface Batch {
  geometry: GeometryValue;
  bindGroup: GPUBindGroup;
  instanceBuffer: GPUBuffer;
  instanceCount: number;
}

// Per-instance vertex buffer: 16 floats matrix + 4 floats RGBA tint = 20 floats = 80 bytes.
const INSTANCE_FLOATS = 20;

export function createSceneRenderer(
  device: GPUDevice,
  format: GPUTextureFormat,
  scene: SceneValue,
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

  let flatNormal: Texture2DValue | null = null;

  // Group entities by (geometry, material) reference equality. Entities that
  // share both end up as one instanced draw call. Per-entity tint goes
  // alongside the transform in the instance buffer, so different tints don't
  // fragment the batch.
  const groupsByGeometry = new Map<GeometryValue, Map<MaterialValue, SceneEntity[]>>();
  for (const entity of scene.entities) {
    let byMaterial = groupsByGeometry.get(entity.geometry);
    if (!byMaterial) {
      byMaterial = new Map();
      groupsByGeometry.set(entity.geometry, byMaterial);
    }
    let entities = byMaterial.get(entity.material);
    if (!entities) {
      entities = [];
      byMaterial.set(entity.material, entities);
    }
    entities.push(entity);
  }

  const batches: Batch[] = [];
  for (const [geometry, byMaterial] of groupsByGeometry) {
    for (const [material, entities] of byMaterial) {
      // Pack [transform (16f), tint (4f)] per instance into one buffer.
      const instanceCount = entities.length;
      const instanceData = new Float32Array(instanceCount * INSTANCE_FLOATS);
      for (let i = 0; i < instanceCount; i++) {
        const e = entities[i]!;
        instanceData.set(e.transform, i * INSTANCE_FLOATS);
        instanceData.set(e.tint, i * INSTANCE_FLOATS + 16);
      }
      const instanceBuffer = device.createBuffer({
        size: instanceData.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(instanceBuffer, 0, instanceData as BufferSource);

      const matBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const matData = new Float32Array(4);
      matData[0] = material.roughness;
      matData[1] = material.metallic;
      device.queue.writeBuffer(matBuffer, 0, matData as BufferSource);

      let normalTex = material.normal;
      if (!normalTex) {
        if (!flatNormal) flatNormal = createFlatNormalTexture(device);
        normalTex = flatNormal;
      }

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: sceneUniformBuffer } },
          { binding: 1, resource: material.basecolor.view },
          { binding: 2, resource: sampler },
          { binding: 3, resource: { buffer: matBuffer } },
          { binding: 4, resource: normalTex.view },
        ],
      });

      batches.push({ geometry, bindGroup, instanceBuffer, instanceCount });
    }
  }

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
          // Reverse-Z: clear to 0 (the "far" depth value) so 'greater' compare
          // accepts incoming fragments by default.
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      pass.setPipeline(pipeline);
      for (const b of batches) {
        pass.setBindGroup(0, b.bindGroup);
        pass.setVertexBuffer(0, b.geometry.positionBuffer);
        pass.setVertexBuffer(1, b.geometry.normalBuffer);
        pass.setVertexBuffer(2, b.geometry.uvBuffer);
        pass.setVertexBuffer(3, b.instanceBuffer);
        pass.setIndexBuffer(b.geometry.indexBuffer, b.geometry.indexFormat);
        pass.drawIndexed(b.geometry.indexCount, b.instanceCount);
      }
      pass.end();
    },
  };
}
