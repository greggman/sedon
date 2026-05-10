import type { PbrMaterial, Texture2DValue } from '../../core/resources.js';
import {
  createFlatNormalTexture,
  DEPTH_STENCIL,
  instanceVertexBuffers,
  type MaterialKindImpl,
} from '../material-kind.js';
import shaderCode from '../pbr.wgsl';

export function createPbrKind(
  device: GPUDevice,
  format: GPUTextureFormat,
  sceneBindGroupLayout: GPUBindGroupLayout,
): MaterialKindImpl<PbrMaterial> {
  const materialBindGroupLayout = device.createBindGroupLayout({
    entries: [
      // basecolor
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      // material params (roughness, metallic)
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
      // normal map
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
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

  // Lazy-create the flat-normal placeholder for materials without an
  // authored normal map. The bind-group layout requires a texture binding
  // either way.
  let flatNormal: Texture2DValue | null = null;

  return {
    id: 'pbr',
    pipeline,
    buildBindGroup(material) {
      const normalTex = material.normal ?? (flatNormal ??= createFlatNormalTexture(device));

      const paramBuffer = device.createBuffer({
        size: 16, // vec4 alignment: roughness, metallic + padding
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const paramData = new Float32Array(4);
      paramData[0] = material.roughness;
      paramData[1] = material.metallic;
      device.queue.writeBuffer(paramBuffer, 0, paramData as BufferSource);

      return device.createBindGroup({
        layout: materialBindGroupLayout,
        entries: [
          { binding: 0, resource: material.basecolor.view },
          { binding: 1, resource: { buffer: paramBuffer } },
          { binding: 2, resource: normalTex.view },
        ],
      });
    },
  };
}
