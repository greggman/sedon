import type { PbrMaterial, Texture2DValue } from '../../core/resources.js';
import {
  getBindGroupLayout,
  getPipelineLayout,
  getRenderPipeline,
  getShaderModule,
  gpuObjectId,
} from '../gpu-cache.js';
import {
  ALPHA_BLEND_STATE,
  createFlatBlackTexture,
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
  const materialBindGroupLayout = getBindGroupLayout(device, {
    entries: [
      // basecolor
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      // material params (roughness, metallic, detailScale, detailStrength,
      // unlit, alphaCutoff, emissiveIntensity)
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
      // emissive (self-illumination, added on top of lit color)
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    ],
  });

  const pipelineLayout = getPipelineLayout(device, {
    bindGroupLayouts: [sceneBindGroupLayout, materialBindGroupLayout],
  });

  // Concatenate shared shadow PCF + the kind-specific shader. WGSL has
  // no #include but a string concat at module-creation time is enough
  // — `sample_shadow` forward-references `uniforms` / `shadow_map` /
  // `shadow_samp` from the host shader.
  const module = getShaderModule(device, `${shadowPcfCode}\n${shaderCode}`);
  const pipeline = getRenderPipeline(device, {
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'vs_main', buffers: instanceVertexBuffers() },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { cullMode: 'back' },
    depthStencil: DEPTH_STENCIL,
  });

  // Alpha-blended variant of the same pipeline for the flat-preview
  // path. The fragment shader already writes basecolor.a as its output
  // alpha (both the unlit and lit branches), so all the blended
  // pipeline needs is the blend state on the color target. Same
  // layout / shader / depth — only the blend state and (for safety)
  // back-face culling differ: leaf-textured cards are intentionally
  // two-sided since the user wants to see the silhouette from either
  // side during authoring.
  const pipelineBlended = getRenderPipeline(device, {
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'vs_main', buffers: instanceVertexBuffers() },
    fragment: {
      module,
      entryPoint: 'fs_main',
      targets: [{ format, blend: ALPHA_BLEND_STATE }],
    },
    primitive: { cullMode: 'none' },
    depthStencil: DEPTH_STENCIL,
  });

  // Alpha-cutout variant: cull-none so cards are two-sided, NO blend
  // state — the shader's `discard` handles transparency, and binary
  // cutout doesn't need back-to-front sorting. Selected per-batch when
  // a material's `alphaCutoff > 0` (leaf cards, fronds, decals).
  const pipelineCutout = getRenderPipeline(device, {
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'vs_main', buffers: instanceVertexBuffers() },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { cullMode: 'none' },
    depthStencil: DEPTH_STENCIL,
  });

  // Lazy-create placeholder textures for materials without authored
  // normal / detail / emissive inputs. Flat-half (0.5 grey) is the
  // albedo-detail no-op; flat-normal ((0, 0, 1) in tangent space) is
  // the normal no-op; flat-black is the emissive no-op.
  let flatNormal: Texture2DValue | null = null;
  let flatHalf: Texture2DValue | null = null;
  let flatBlack: Texture2DValue | null = null;

  return {
    id: 'pbr',
    pipeline,
    pipelineBlended,
    pipelineCutout,
    pickPipeline(material) {
      // Cutout materials get the two-sided no-blend pipeline; the shader
      // handles transparency via `discard`. Everything else uses the
      // standard opaque pipeline.
      if ((material.alphaCutoff ?? 0) > 0) return pipelineCutout;
      return pipeline;
    },
    // Structural key: just the texture handle identities (or `none` for
    // unwired optionals + their flat-placeholder substitutes, since the
    // bind group's contents depend on which set of textures end up at
    // each binding). Scalars are NOT included — they're written into
    // the cached paramBuffer via writeMaterialParams instead.
    materialStructuralKey(material) {
      const basecolor = gpuObjectId(material.basecolor.texture);
      const normal = material.normal ? gpuObjectId(material.normal.texture) : 'flat';
      const detailB = material.detailBasecolor
        ? gpuObjectId(material.detailBasecolor.texture)
        : 'flat';
      const detailN = material.detailNormal
        ? gpuObjectId(material.detailNormal.texture)
        : 'flat';
      const emissive = material.emissive ? gpuObjectId(material.emissive.texture) : 'flat';
      return `pbr|${basecolor}|${normal}|${detailB}|${detailN}|${emissive}`;
    },
    writeMaterialParams(material, paramBuffer) {
      const paramData = new Float32Array(8);
      paramData[0] = material.roughness;
      paramData[1] = material.metallic;
      paramData[2] = material.detailScale ?? 4;
      paramData[3] = material.detailStrength ?? 1;
      paramData[4] = material.unlit ? 1 : 0;
      paramData[5] = material.alphaCutoff ?? 0;
      paramData[6] = material.emissiveIntensity ?? 1;
      device.queue.writeBuffer(paramBuffer, 0, paramData as BufferSource);
    },
    buildBindGroup(material) {
      const normalTex = material.normal ?? (flatNormal ??= createFlatNormalTexture(device));
      const detailBasecolorTex =
        material.detailBasecolor ?? (flatHalf ??= createFlatHalfTexture(device));
      const detailNormalTex =
        material.detailNormal ?? (flatNormal ??= createFlatNormalTexture(device));
      const emissiveTex = material.emissive ?? (flatBlack ??= createFlatBlackTexture(device));

      // 7 floats used, padded to 32 bytes (next 16-byte boundary for
      // WGSL UBO). Layout: roughness, metallic, detailScale,
      // detailStrength, unlit, alphaCutoff, emissiveIntensity.
      const paramBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.writeMaterialParams(material, paramBuffer);

      const bindGroup = device.createBindGroup({
        layout: materialBindGroupLayout,
        entries: [
          { binding: 0, resource: material.basecolor.texture },
          { binding: 1, resource: paramBuffer },
          { binding: 2, resource: normalTex.texture },
          { binding: 3, resource: detailBasecolorTex.texture },
          { binding: 4, resource: detailNormalTex.texture },
          { binding: 5, resource: emissiveTex.texture },
        ],
      });
      return { bindGroup, paramBuffer };
    },
  };
}
