import type {
  GeometryValue,
  LightingValue,
  MaterialValue,
  SceneEntity,
  SceneValue,
  Texture2DValue,
} from '../core/resources.js';
import type { Mat4 } from './mat4.js';
import { createScenePipeline } from './pipeline.js';
import shaderCode from './shader.wgsl';
import skyShaderCode from './sky.wgsl';

export interface SceneRenderer {
  render(params: {
    encoder: GPUCommandEncoder;
    colorView: GPUTextureView;
    depthView: GPUTextureView;
    modelView: Mat4;
    projection: Mat4;
    lighting: LightingValue;
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

function createSkyPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: skyShaderCode });
  return device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    // Depth attachment is shared with the scene pass; we don't write or test
    // against it. depthCompare 'always' lets the sky pass through unchanged
    // and depthWriteEnabled false keeps the depth buffer clean for geometry.
    depthStencil: {
      format: 'depth32float',
      depthWriteEnabled: false,
      depthCompare: 'always',
    },
  });
}

export function createSceneRenderer(
  device: GPUDevice,
  format: GPUTextureFormat,
  scene: SceneValue,
): SceneRenderer {
  const pipeline = createScenePipeline(device, format, shaderCode);
  const skyPipeline = createSkyPipeline(device, format);

  const sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });

  // 128 bytes for two mat4x4f (modelView, projection) + 48 bytes for three
  // vec3f-with-16-byte-stride lighting params (lightDirWorld, lightColor,
  // ambient) = 176 bytes total. Each vec3f's trailing 4 bytes are padding
  // to satisfy WGSL's 16-byte alignment for the next member.
  const sceneUniformBuffer = device.createBuffer({
    size: 176,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // Reused per-frame scratch for the lighting block. 12 floats = 3 vec3 ×
  // (3 floats + 1 padding).
  const lightingScratch = new Float32Array(12);

  // Sky uniform buffer + bind group + scratch. Layout: vec3 top, vec3 bottom,
  // each padded to 16 bytes (32 bytes total / 8 floats).
  const skyUniformBuffer = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const skyBindGroup = device.createBindGroup({
    layout: skyPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: skyUniformBuffer } }],
  });
  const skyScratch = new Float32Array(8);

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
    render({ encoder, colorView, depthView, modelView, projection, lighting }) {
      device.queue.writeBuffer(sceneUniformBuffer, 0, modelView as BufferSource);
      device.queue.writeBuffer(sceneUniformBuffer, 64, projection as BufferSource);
      lightingScratch[0]  = lighting.direction[0];
      lightingScratch[1]  = lighting.direction[1];
      lightingScratch[2]  = lighting.direction[2];
      // [3] padding
      lightingScratch[4]  = lighting.color[0];
      lightingScratch[5]  = lighting.color[1];
      lightingScratch[6]  = lighting.color[2];
      // [7] padding
      lightingScratch[8]  = lighting.ambient[0];
      lightingScratch[9]  = lighting.ambient[1];
      lightingScratch[10] = lighting.ambient[2];
      // [11] padding
      device.queue.writeBuffer(sceneUniformBuffer, 128, lightingScratch as BufferSource);

      skyScratch[0] = lighting.skyTop[0];
      skyScratch[1] = lighting.skyTop[1];
      skyScratch[2] = lighting.skyTop[2];
      // [3] padding
      skyScratch[4] = lighting.skyBottom[0];
      skyScratch[5] = lighting.skyBottom[1];
      skyScratch[6] = lighting.skyBottom[2];
      // [7] padding
      device.queue.writeBuffer(skyUniformBuffer, 0, skyScratch as BufferSource);

      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: colorView,
            // Sky pass below overdraws this clear; the value just protects
            // against the (currently impossible) case where sky doesn't run.
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
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

      // Sky first — fullscreen triangle, no depth interactions, fills the
      // background gradient. Geometry overdraws wherever it's nearer.
      pass.setPipeline(skyPipeline);
      pass.setBindGroup(0, skyBindGroup);
      pass.draw(3);

      // Scene geometry on top.
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
