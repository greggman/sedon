import type { TerrainSplatMaterial, Texture2DValue } from '../../core/resources.js';
import {
  getBindGroupLayout,
  getPipelineLayout,
  getRenderPipeline,
  getShaderModule,
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

  // Lazy-init shared flat-normal placeholder for layers that don't supply
  // a normal map — keeps the bind-group layout uniform without forcing
  // every TerrainSplatMaterial to construct flat normals up front.
  let flatNormal: Texture2DValue | null = null;
  const ensureFlat = () => (flatNormal ??= createFlatNormalTexture(device));

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

      const normalA = material.normalA ?? ensureFlat();
      const normalB = material.normalB ?? ensureFlat();

      return device.createBindGroup({
        layout: materialBindGroupLayout,
        entries: [
          { binding: 0, resource: material.layerA.view },
          { binding: 1, resource: material.layerB.view },
          { binding: 2, resource: material.mask.view },
          { binding: 3, resource: { buffer: paramBuffer } },
          { binding: 4, resource: normalA.view },
          { binding: 5, resource: normalB.view },
        ],
      });
    },
  };
}
