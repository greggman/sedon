import type { WaterMaterial } from '../../core/resources.js';
import {
  getBindGroupLayout,
  getPipelineLayout,
  getRenderPipeline,
  getShaderModule,
} from '../gpu-cache.js';
import {
  DEPTH_STENCIL,
  instanceVertexBuffers,
  type MaterialKindImpl,
} from '../material-kind.js';
import shaderCode from '../water.wgsl';

// Water material kind — animated procedural surface. Pipeline is the
// same vertex-instancing scheme as PBR / terrain-splat (8-location
// vertex layout, scene bind group at @group(0)); the per-material
// bind group at @group(1) just carries colour + wave params.
//
// Time comes from the scene uniform buffer (offset 272 — set by
// scene.ts each frame), so the kind doesn't need its own per-frame
// hook.
export function createWaterKind(
  device: GPUDevice,
  format: GPUTextureFormat,
  sceneBindGroupLayout: GPUBindGroupLayout,
): MaterialKindImpl<WaterMaterial> {
  const materialBindGroupLayout = getBindGroupLayout(device, {
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  const pipelineLayout = getPipelineLayout(device, {
    bindGroupLayouts: [sceneBindGroupLayout, materialBindGroupLayout],
  });
  const module = getShaderModule(device, shaderCode);
  const pipeline = getRenderPipeline(device, {
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'vs_main', buffers: instanceVertexBuffers() },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { cullMode: 'back' },
    depthStencil: DEPTH_STENCIL,
  });

  return {
    id: 'water',
    pipeline,
    materialStructuralKey(_material) {
      // Pure-scalar material — every WaterMaterial value can share the
      // same bind group (the param buffer holds all per-instance
      // tunables; structural key just picks up the kind tag).
      return 'water';
    },
    writeMaterialParams(material, paramBuffer) {
      // Layout matches WaterParams in water.wgsl: vec4f color + vec4f
      // (waveStrength, waveScale, waveSpeed, roughness).
      const data = new Float32Array(8);
      data[0] = material.color[0];
      data[1] = material.color[1];
      data[2] = material.color[2];
      data[3] = material.color[3];
      data[4] = material.waveStrength;
      data[5] = material.waveScale;
      data[6] = material.waveSpeed;
      data[7] = material.roughness;
      device.queue.writeBuffer(paramBuffer, 0, data as BufferSource);
    },
    buildBindGroup(material) {
      const paramBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.writeMaterialParams(material, paramBuffer);
      const bindGroup = device.createBindGroup({
        layout: materialBindGroupLayout,
        entries: [{ binding: 0, resource: paramBuffer }],
      });
      return { bindGroup, paramBuffer };
    },
  };
}
