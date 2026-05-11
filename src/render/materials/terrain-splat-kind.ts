import type { TerrainSplatMaterial } from '../../core/resources.js';
import {
  DEPTH_STENCIL,
  instanceVertexBuffers,
  type MaterialKindImpl,
} from '../material-kind.js';
import shaderCode from '../terrain-splat.wgsl';

export function createTerrainSplatKind(
  device: GPUDevice,
  format: GPUTextureFormat,
  sceneBindGroupLayout: GPUBindGroupLayout,
): MaterialKindImpl<TerrainSplatMaterial> {
  const materialBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // layerA
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // layerB
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // mask
      // params (roughnessA, roughnessB)
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [sceneBindGroupLayout, materialBindGroupLayout],
  });

  const module = device.createShaderModule({ code: shaderCode });
  const pipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'vs_main', buffers: instanceVertexBuffers() },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { cullMode: 'back' },
    depthStencil: DEPTH_STENCIL,
  });

  return {
    id: 'terrain-splat',
    pipeline,
    buildBindGroup(material) {
      const paramBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      // Layout: roughnessA, roughnessB at offsets 0/4; tile_scale vec2f at
      // offset 8 (naturally aligned) — total 16 bytes.
      const paramData = new Float32Array(4);
      paramData[0] = material.roughnessA;
      paramData[1] = material.roughnessB;
      paramData[2] = material.tileScale[0];
      paramData[3] = material.tileScale[1];
      device.queue.writeBuffer(paramBuffer, 0, paramData as BufferSource);

      return device.createBindGroup({
        layout: materialBindGroupLayout,
        entries: [
          { binding: 0, resource: material.layerA.view },
          { binding: 1, resource: material.layerB.view },
          { binding: 2, resource: material.mask.view },
          { binding: 3, resource: { buffer: paramBuffer } },
        ],
      });
    },
  };
}
