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
): MaterialKindImpl<WaterMaterial> {
  const materialBindGroupLayout = getBindGroupLayout(device, {
    entries: [
      // Uniform visible to both stages — vertex shader reads wave
      // params for vertical displacement; fragment reads colour +
      // wave normal + foam params.
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });
  const pipelineLayout = getPipelineLayout(device, {
    bindGroupLayouts: [sceneBindGroupLayout, materialBindGroupLayout],
  });
  const module = getShaderModule(device, shaderCode);
  const pipeline = getRenderPipeline(device, {
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
    flatHeight = { texture: tex, format: 'rgba8unorm', width: 1, height: 1 };
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
      const htex = material.heightfield ? gpuObjectId(material.heightfield.texture.texture) : 'none';
      return `water|${htex}`;
    },
    writeMaterialParams(material, paramBuffer) {
      // Layout matches WaterParams in water.wgsl. 64 bytes total.
      //   offset 0  vec4 color
      //   offset 16 vec4 (waveStrength, waveScale, waveSpeed, roughness)
      //   offset 32 vec4 (worldSizeX, worldSizeZ, heightMin, heightMax)
      //   offset 48 vec4 (foamWidth, foamEnabled, pad, pad)
      const data = new Float32Array(16);
      data[0] = material.color[0];
      data[1] = material.color[1];
      data[2] = material.color[2];
      data[3] = material.color[3];
      data[4] = material.waveStrength;
      data[5] = material.waveScale;
      data[6] = material.waveSpeed;
      data[7] = material.roughness;
      const hf = material.heightfield;
      data[8]  = hf ? hf.worldSize[0]   : 1;
      data[9]  = hf ? hf.worldSize[1]   : 1;
      data[10] = hf ? hf.heightRange[0] : 0;
      data[11] = hf ? hf.heightRange[1] : 1;
      data[12] = material.foamWidth;
      data[13] = hf ? 1 : 0; // foam enabled
      data[14] = 0;
      data[15] = 0;
      device.queue.writeBuffer(paramBuffer, 0, data as BufferSource);
    },
    buildBindGroup(material) {
      const paramBuffer = device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.writeMaterialParams(material, paramBuffer);
      const heightTex = material.heightfield?.texture ?? ensureFlatHeight();
      const bindGroup = device.createBindGroup({
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
