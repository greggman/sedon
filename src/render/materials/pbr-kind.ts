import type { PbrMaterial, Texture2DValue } from '../../core/resources.js';
import {
  createFlatHalfTexture,
  createFlatNormalTexture,
  DEPTH_STENCIL,
  instanceVertexBuffers,
  type MaterialKindImpl,
} from '../material-kind.js';
import shaderCode from '../pbr.wgsl';
import shadowPcfCode from '../shadow-pcf.wgsl';

export function createPbrKind(
  device: GPUDevice,
  format: GPUTextureFormat,
  sceneBindGroupLayout: GPUBindGroupLayout,
): MaterialKindImpl<PbrMaterial> {
  const materialBindGroupLayout = device.createBindGroupLayout({
    entries: [
      // basecolor
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      // material params (roughness, metallic, detailScale, detailStrength)
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
      // normal map
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      // detail basecolor (greyscale modulator)
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      // detail normal map
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [sceneBindGroupLayout, materialBindGroupLayout],
  });

  // Concatenate shared shadow PCF + the kind-specific shader. WGSL has
  // no #include but a string concat at module-creation time is enough
  // — `sample_shadow` forward-references `uniforms` / `shadow_map` /
  // `shadow_samp` from the host shader.
  const module = device.createShaderModule({ code: `${shadowPcfCode}\n${shaderCode}` });
  const pipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'vs_main', buffers: instanceVertexBuffers() },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { cullMode: 'back' },
    depthStencil: DEPTH_STENCIL,
  });

  // Lazy-create placeholder textures for materials without authored
  // normal / detail inputs. Flat-half (0.5 grey) is the albedo-detail
  // no-op; flat-normal ((0, 0, 1) in tangent space) is the normal no-op.
  let flatNormal: Texture2DValue | null = null;
  let flatHalf: Texture2DValue | null = null;

  return {
    id: 'pbr',
    pipeline,
    buildBindGroup(material) {
      const normalTex = material.normal ?? (flatNormal ??= createFlatNormalTexture(device));
      const detailBasecolorTex =
        material.detailBasecolor ?? (flatHalf ??= createFlatHalfTexture(device));
      const detailNormalTex =
        material.detailNormal ?? (flatNormal ??= createFlatNormalTexture(device));

      const paramBuffer = device.createBuffer({
        // 4 + 1 floats, padded to 32 (next 16-byte boundary for WGSL UBO).
        // Layout: roughness, metallic, detailScale, detailStrength, unlit.
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const paramData = new Float32Array(8);
      paramData[0] = material.roughness;
      paramData[1] = material.metallic;
      paramData[2] = material.detailScale ?? 4;
      paramData[3] = material.detailStrength ?? 1;
      paramData[4] = material.unlit ? 1 : 0;
      device.queue.writeBuffer(paramBuffer, 0, paramData as BufferSource);

      return device.createBindGroup({
        layout: materialBindGroupLayout,
        entries: [
          { binding: 0, resource: material.basecolor.view },
          { binding: 1, resource: { buffer: paramBuffer } },
          { binding: 2, resource: normalTex.view },
          { binding: 3, resource: detailBasecolorTex.view },
          { binding: 4, resource: detailNormalTex.view },
        ],
      });
    },
  };
}
