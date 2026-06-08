import type { TerrainSplatMaterial, Texture2DValue } from '../../core/resources.js';
import {
  getBindGroupLayout,
  getPipelineLayout,
  getRenderPipeline,
  getShaderModule,
  gpuObjectId,
} from '../gpu-cache.js';
import {
  createFlatNormalTexture,
  DEPTH_STENCIL,
  instanceVertexBuffers,
  type MaterialKindImpl,
} from '../material-kind.js';
import shaderCode from '../terrain-splat.wgsl';
import shadowPcfCode from '../shadow-pcf.wgsl';

export function createTerrainSplatKind(
  device: GPUDevice,
  format: GPUTextureFormat,
  sceneBindGroupLayout: GPUBindGroupLayout,
): MaterialKindImpl<TerrainSplatMaterial> {
  const materialBindGroupLayout = getBindGroupLayout(device, {
    label: 'terrain-splat-material-bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // layerA basecolor
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // layerB basecolor
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // mask
      // params (roughnessA, roughnessB, tile_scale)
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // layerA normal
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // layerB normal
    ],
  });

  const pipelineLayout = getPipelineLayout(device, {
    label: 'terrain-splat-pipeline-layout',
    bindGroupLayouts: [sceneBindGroupLayout, materialBindGroupLayout],
  });

  // Concatenate shared shadow PCF + the kind-specific shader. WGSL has
  // no #include but a string concat at module-creation time is enough
  // — `sample_shadow` forward-references `uniforms` / `shadow_map` /
  // `shadow_samp` from the host shader.
  const module = getShaderModule(device, `${shadowPcfCode}\n${shaderCode}`);
  const pipeline = getRenderPipeline(device, {
    label: 'terrain-splat-color-pipeline',
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'vs_main', buffers: instanceVertexBuffers() },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { cullMode: 'back' },
    depthStencil: DEPTH_STENCIL,
  });

  // Lazy-init shared flat-normal placeholder for layers that don't supply
  // a normal map — keeps the bind-group layout uniform without forcing
  // every TerrainSplatMaterial to construct flat normals up front.
  let flatNormal: Texture2DValue | null = null;
  const ensureFlat = () => (flatNormal ??= createFlatNormalTexture(device));

  return {
    id: 'terrain-splat',
    pipeline,
    materialStructuralKey(material) {
      const layerA = gpuObjectId(material.layerA.texture);
      const layerB = gpuObjectId(material.layerB.texture);
      const mask = gpuObjectId(material.mask.texture);
      const normalA = material.normalA ? gpuObjectId(material.normalA.texture) : 'flat';
      const normalB = material.normalB ? gpuObjectId(material.normalB.texture) : 'flat';
      return `terrain-splat|${layerA}|${layerB}|${mask}|${normalA}|${normalB}`;
    },
    writeMaterialParams(material, paramBuffer) {
      const paramData = new Float32Array(4);
      paramData[0] = material.roughnessA;
      paramData[1] = material.roughnessB;
      paramData[2] = material.tileScale[0];
      paramData[3] = material.tileScale[1];
      device.queue.writeBuffer(paramBuffer, 0, paramData as BufferSource);
    },
    buildBindGroup(material) {
      // Layout: roughnessA, roughnessB at offsets 0/4; tile_scale vec2f at
      // offset 8 (naturally aligned) — total 16 bytes.
      const paramBuffer = device.createBuffer({
        label: 'terrain-splat-material-params',
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.writeMaterialParams(material, paramBuffer);

      const normalA = material.normalA ?? ensureFlat();
      const normalB = material.normalB ?? ensureFlat();

      const bindGroup = device.createBindGroup({
        label: 'terrain-splat-material-bg',
        layout: materialBindGroupLayout,
        entries: [
          { binding: 0, resource: material.layerA.texture },
          { binding: 1, resource: material.layerB.texture },
          { binding: 2, resource: material.mask.texture },
          { binding: 3, resource: paramBuffer },
          { binding: 4, resource: normalA.texture },
          { binding: 5, resource: normalB.texture },
        ],
      });
      return { bindGroup, paramBuffer };
    },
  };
}
