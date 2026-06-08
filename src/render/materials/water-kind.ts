import type { Texture2DValue, WaterMaterial } from '../../core/resources.js';
import {
  getBindGroupLayout,
  getPipelineLayout,
  getRenderPipeline,
  getSampler,
  getShaderModule,
  gpuObjectId,
} from '../gpu-cache.js';
import {
  DEPTH_STENCIL,
  instanceVertexBuffers,
  type MaterialKindImpl,
} from '../material-kind.js';
import shaderCode from '../water.wgsl';

// Water material kind — animated procedural surface with optional
// shoreline-foam sampling against a heightfield. Pipeline is the
// same vertex-instancing scheme as PBR / terrain-splat; @group(1)
// adds a heightfield texture binding so the fragment can read terrain
// Y at each pixel and fade toward foam-white near the shoreline.
//
// Time + camera comes from the shared scene uniform buffer (offset
// 272 for time, derived camera world pos isn't needed for shading
// since modelView gives view-space directions).
export function createWaterKind(
  device: GPUDevice,
  format: GPUTextureFormat,
  sceneBindGroupLayout: GPUBindGroupLayout,
  waterExtrasBindGroupLayout: GPUBindGroupLayout,
): MaterialKindImpl<WaterMaterial> {
  const materialBindGroupLayout = getBindGroupLayout(device, {
    label: 'water-material-bgl',
    entries: [
      // Uniform visible to both stages — vertex shader reads wave
      // params for vertical displacement; fragment reads colour +
      // wave normal + foam params.
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });
  // Pipeline has THREE bind groups: scene (0) + material (1) +
  // water-extras (2: opaque-depth copy + opaque-colour copy). Group
  // 2's layout is owned by the scene renderer because its bind
  // group is per-canvas-size, not per-material. The caller of
  // pass.setBindGroup(2, ...) at draw time is scene.ts's main
  // render loop (right before each water draw).
  const pipelineLayout = getPipelineLayout(device, {
    label: 'water-pipeline-layout',
    bindGroupLayouts: [sceneBindGroupLayout, materialBindGroupLayout, waterExtrasBindGroupLayout],
  });
  const module = getShaderModule(device, shaderCode);
  const pipeline = getRenderPipeline(device, {
    label: 'water-color-pipeline',
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'vs_main', buffers: instanceVertexBuffers() },
    fragment: {
      module,
      entryPoint: 'fs_main',
      targets: [{
        format,
        // Standard "over" blend (non-premultiplied alpha). Water
        // draws AFTER terrain so the dst pixel is the terrain
        // colour; src.a controls how much the water tint shows
        // through vs how clearly the terrain reads underneath.
        blend: {
          color: {
            srcFactor: 'src-alpha',
            dstFactor: 'one-minus-src-alpha',
            operation: 'add',
          },
          alpha: {
            srcFactor: 'one',
            dstFactor: 'one-minus-src-alpha',
            operation: 'add',
          },
        },
      }],
    },
    primitive: { cullMode: 'back' },
    depthStencil: DEPTH_STENCIL,
  });

  const heightSampler = getSampler(device, {
    label: 'water-height-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  // 1×1 black placeholder for materials with no heightfield wired —
  // the shader treats foam_width<=0 OR enable=0 as "no foam" so the
  // texture's contents don't actually matter, but the binding still
  // has to be a valid GPUTexture.
  let flatHeight: Texture2DValue | null = null;
  const ensureFlatHeight = (): Texture2DValue => {
    if (flatHeight) return flatHeight;
    const tex = device.createTexture({
      label: 'water-flat-height-1x1',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: tex },
      new Uint8Array([0, 0, 0, 255]) as BufferSource,
      { bytesPerRow: 4 },
      [1, 1],
    );
    flatHeight = { texture: tex, format: 'rgba8unorm', width: 1, height: 1, revision: 0 };
    return flatHeight;
  };

  return {
    id: 'water',
    pipeline,
    materialStructuralKey(material) {
      // Bind group reuse keys on the heightfield texture identity —
      // a different heightfield (different texture handle) requires
      // a fresh bind group. Wave / colour / foam-width scalars are
      // rewritten via writeMaterialParams.
      const htex = material.heightTexture ? gpuObjectId(material.heightTexture.texture) : 'none';
      return `water|${htex}`;
    },
    writeMaterialParams(material, paramBuffer) {
      // Layout matches WaterParams in water.wgsl. 128 bytes total.
      //   offset 0   vec4 color
      //   offset 16  vec4 (waveStrength, waveScale, waveSpeed, roughness)
      //   offset 32  vec4 (worldSizeX, worldSizeZ, _unused0, _unused1)
      //                   — heightfield R = world Y in metres directly
      //   offset 48  vec4 (foamWidth, foamEnabled, pad, pad)
      //   offset 64  vec4 (rippleStrength, rippleScale, rippleSpeed, pad)
      //   offset 80  vec4 (absorption, pad, pad, pad)
      //   offset 96  vec4 (ringSpacing, ringSpeed, ringDecay, pad)
      //   offset 112 vec4 foam_color (sRGB; alpha unused)
      const data = new Float32Array(32);
      data[0] = material.color[0];
      data[1] = material.color[1];
      data[2] = material.color[2];
      data[3] = material.color[3];
      data[4] = material.waveStrength;
      data[5] = material.waveScale;
      data[6] = material.waveSpeed;
      data[7] = material.roughness;
      const hasField = material.heightTexture !== undefined && material.heightWorldSize !== undefined;
      data[8]  = hasField ? material.heightWorldSize![0] : 1;
      data[9]  = hasField ? material.heightWorldSize![1] : 1;
      data[10] = 0;
      data[11] = 0;
      data[12] = material.foamWidth;
      data[13] = hasField ? 1 : 0; // foam enabled
      data[14] = 0;
      data[15] = 0;
      data[16] = material.rippleStrength;
      data[17] = material.rippleScale;
      data[18] = material.rippleSpeed;
      data[19] = 0;
      data[20] = material.absorption;
      data[21] = 0;
      data[22] = 0;
      data[23] = 0;
      data[24] = material.ringSpacing;
      data[25] = material.ringSpeed;
      data[26] = material.ringDecay;
      data[27] = 0;
      data[28] = material.foamColor[0];
      data[29] = material.foamColor[1];
      data[30] = material.foamColor[2];
      data[31] = material.foamColor[3];
      device.queue.writeBuffer(paramBuffer, 0, data as BufferSource);
    },
    buildBindGroup(material) {
      const paramBuffer = device.createBuffer({
        label: 'water-material-params',
        size: 128,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.writeMaterialParams(material, paramBuffer);
      const heightTex = material.heightTexture ?? ensureFlatHeight();
      const bindGroup = device.createBindGroup({
        label: 'water-material-bg',
        layout: materialBindGroupLayout,
        entries: [
          { binding: 0, resource: paramBuffer },
          { binding: 1, resource: heightTex.texture },
          { binding: 2, resource: heightSampler },
        ],
      });
      return { bindGroup, paramBuffer };
    },
  };
}
