import type { TerrainMultiLayerMaterial, Texture2DValue } from '../../core/resources.js';
import {
  getBindGroupLayout,
  getPipelineLayout,
  getRenderPipeline,
  getSampler,
  getShaderModule,
  gpuObjectId,
} from '../gpu-cache.js';
import {
  createFlatHalfTexture,
  createFlatNormalTexture,
  DEPTH_STENCIL,
  instanceVertexBuffers,
  type MaterialKindImpl,
} from '../material-kind.js';
import shaderCode from '../terrain-multi-layer.wgsl';
import shadowPcfCode from '../shadow-pcf.wgsl';

// Maximum number of layers the v1 shader supports. The shader unrolls
// exactly this many textureSample calls per channel; growing it means
// editing the WGSL and increasing the array depth here in lockstep.
// Bumping past 4 also needs a chained-splat input (one RGBA per 4
// layers) on the node side.
const MAX_LAYERS = 4;

// Tiny blit shader used to copy / resize each layer's source texture
// into the matching slot of the corresponding texture-2d-array. Inline
// because there's only one consumer of this — the kind impl. Uses
// linear sampling so a 1×1 default and a 512² source both work without
// special-casing.
const BLIT_SHADER = /* wgsl */ `
struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};
@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
  let x = f32(i & 1u) * 4.0 - 1.0;
  let y = f32(i >> 1u) * 4.0 - 1.0;
  var out: VsOut;
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  return textureSample(src, samp, in.uv);
}
`;

interface DefaultLayerTextures {
  /** Black (0,0,0,1). Slots whose splat weight is 0 contribute nothing. */
  albedo: Texture2DValue;
  /** Flat tangent normal (128,128,255). */
  normal: Texture2DValue;
  /** Mid-grey (R = 0.5) — neutral in the height-weighted blend. */
  height: Texture2DValue;
  /** Mid-grey (R = ~0.6) — sensible default surface roughness. */
  roughness: Texture2DValue;
}

const defaultsByDevice = new WeakMap<GPUDevice, DefaultLayerTextures>();

function ensureDefaults(device: GPUDevice): DefaultLayerTextures {
  const cached = defaultsByDevice.get(device);
  if (cached) return cached;
  const format: GPUTextureFormat = 'rgba8unorm';
  const make = (rgba: [number, number, number, number]): Texture2DValue => {
    const texture = device.createTexture({
      label: 'terrain-multi-layer-default-1x1',
      size: [1, 1],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture },
      new Uint8Array(rgba) as BufferSource,
      { bytesPerRow: 4 },
      [1, 1],
    );
    return { texture, format, width: 1, height: 1, revision: 0 };
  };
  const result: DefaultLayerTextures = {
    albedo: make([0, 0, 0, 255]),
    normal: createFlatNormalTexture(device),
    height: createFlatHalfTexture(device),
    // ~0.6 → 153 in 8-bit unorm.
    roughness: make([153, 153, 153, 255]),
  };
  defaultsByDevice.set(device, result);
  return result;
}

export function createTerrainMultiLayerKind(
  device: GPUDevice,
  format: GPUTextureFormat,
  sceneBindGroupLayout: GPUBindGroupLayout,
): MaterialKindImpl<TerrainMultiLayerMaterial> {
  const materialBindGroupLayout = getBindGroupLayout(device, {
    label: 'terrain-multi-layer-material-bgl',
    entries: [
      // 4 texture-2d-arrays — one per channel, depth = MAX_LAYERS.
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
      // Splat mask (RGBA weights).
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      // tile_scale, metallic, height_blend_sharpness.
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });

  const pipelineLayout = getPipelineLayout(device, {
    label: 'terrain-multi-layer-pipeline-layout',
    bindGroupLayouts: [sceneBindGroupLayout, materialBindGroupLayout],
  });

  const module = getShaderModule(device, `${shadowPcfCode}\n${shaderCode}`);
  const pipeline = getRenderPipeline(device, {
    label: 'terrain-multi-layer-color-pipeline',
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'vs_main', buffers: instanceVertexBuffers() },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { cullMode: 'back' },
    depthStencil: DEPTH_STENCIL,
  });

  // Blit pipeline used at material-build time to fill each array slice
  // from its corresponding source (or default) texture. Owned by the
  // kind so the layout / pipeline are created once and reused for every
  // material instance.
  const blitGroupLayout = device.createBindGroupLayout({
    label: 'terrain-multi-layer-blit-bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });
  const blitModule = getShaderModule(device, BLIT_SHADER);
  const blitPipeline = device.createRenderPipeline({
    label: 'terrain-multi-layer-blit-pipeline',
    layout: device.createPipelineLayout({
      label: 'terrain-multi-layer-blit-pipeline-layout',
      bindGroupLayouts: [blitGroupLayout],
    }),
    vertex: { module: blitModule, entryPoint: 'vs_main' },
    fragment: {
      module: blitModule,
      entryPoint: 'fs_main',
      targets: [{ format: 'rgba8unorm' }],
    },
  });
  const blitSampler = getSampler(device, {
    label: 'terrain-multi-layer-blit-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  return {
    id: 'terrain-multi-layer',
    pipeline,
    materialStructuralKey(material) {
      // Include the SOURCE Texture2DValue's content revision in
      // each per-layer key. Without revision, two materials whose
      // layers reuse the SAME underlying GPUTexture (via
      // reusableTexture) but with newly-written content collide on
      // the same structural key — the cached bind group is reused
      // and the one-time blit-into-array (in buildBindGroup) is
      // NEVER re-run, so the rendered terrain stays stuck on the
      // old content. The revision bumps every reusableTexture call,
      // so a producer-node re-eval forces a fresh structural key
      // here and the array re-blit happens.
      const texKey = (t: { texture: GPUTexture; revision: number }) =>
        `${gpuObjectId(t.texture)}#${t.revision}`;
      const layerIds = material.layers
        .map((layer, i) => {
          const a = texKey(layer.albedo);
          const n = layer.normal ? texKey(layer.normal) : 'flat';
          const h = layer.height ? texKey(layer.height) : 'flat';
          const r = layer.roughness ? texKey(layer.roughness) : 'flat';
          return `${i}:${a}|${n}|${h}|${r}`;
        })
        .join(',');
      const splatId = texKey(material.splat);
      return `terrain-multi-layer|${material.layers.length}|${layerIds}|splat=${splatId}`;
    },
    writeMaterialParams(material, paramBuffer) {
      // tile_scale (vec2f at offset 0–7), metallic (offset 8–11),
      // height_blend_sharpness (offset 12–15). 16 bytes total.
      const data = new Float32Array(4);
      data[0] = material.tileScale[0];
      data[1] = material.tileScale[1];
      data[2] = material.metallic;
      data[3] = material.heightBlendSharpness;
      device.queue.writeBuffer(paramBuffer, 0, data as BufferSource);
    },
    buildBindGroup(material) {
      // Pick target dims = the largest source across all wired channels.
      // Blit handles resize, so mismatched sizes work without a hard
      // error — just one pass that linearly samples up/down. (Sedon's
      // procedural textures are typically all the same resolution, so
      // this is a no-op in practice.) Falls back to 1×1 when literally
      // nothing is wired (impossible — albedo is required).
      let targetW = 1;
      let targetH = 1;
      for (const layer of material.layers) {
        targetW = Math.max(targetW, layer.albedo.width);
        targetH = Math.max(targetH, layer.albedo.height);
        if (layer.normal) {
          targetW = Math.max(targetW, layer.normal.width);
          targetH = Math.max(targetH, layer.normal.height);
        }
        if (layer.height) {
          targetW = Math.max(targetW, layer.height.width);
          targetH = Math.max(targetH, layer.height.height);
        }
        if (layer.roughness) {
          targetW = Math.max(targetW, layer.roughness.width);
          targetH = Math.max(targetH, layer.roughness.height);
        }
      }

      const arrayFormat: GPUTextureFormat = 'rgba8unorm';
      const makeArray = (label: string): GPUTexture =>
        device.createTexture({
          label,
          size: [targetW, targetH, MAX_LAYERS],
          format: arrayFormat,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        });
      const albedoArr = makeArray('terrain-multi-layer-albedo-array');
      const normalArr = makeArray('terrain-multi-layer-normal-array');
      const heightArr = makeArray('terrain-multi-layer-height-array');
      const roughArr  = makeArray('terrain-multi-layer-roughness-array');

      const defaults = ensureDefaults(device);

      // For each layer slot 0..MAX_LAYERS-1, pick the source texture
      // for each channel (wired source if present, else default), and
      // blit it into the matching array slice. One render pass per
      // (slot, channel) — MAX_LAYERS * 4 passes total per material
      // build. Material-build runs on cache miss only.
      const encoder = device.createCommandEncoder({ label: 'terrain-multi-layer-blit-encoder' });
      const blit = (
        targetArr: GPUTexture,
        slot: number,
        source: Texture2DValue,
      ) => {
        const view = targetArr.createView({
          dimension: '2d',
          baseArrayLayer: slot,
          arrayLayerCount: 1,
        });
        const bg = device.createBindGroup({
          label: 'terrain-multi-layer-blit-bg',
          layout: blitGroupLayout,
          entries: [
            { binding: 0, resource: source.texture },
            { binding: 1, resource: blitSampler },
          ],
        });
        const pass = encoder.beginRenderPass({
          label: 'terrain-multi-layer-blit-pass',
          colorAttachments: [{
            view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          }],
        });
        pass.setPipeline(blitPipeline);
        pass.setBindGroup(0, bg);
        pass.draw(3);
        pass.end();
      };
      for (let i = 0; i < MAX_LAYERS; i++) {
        const layer = material.layers[i];
        blit(albedoArr, i, layer?.albedo ?? defaults.albedo);
        blit(normalArr, i, layer?.normal ?? defaults.normal);
        blit(heightArr, i, layer?.height ?? defaults.height);
        blit(roughArr,  i, layer?.roughness ?? defaults.roughness);
      }
      device.queue.submit([encoder.finish()]);

      const paramBuffer = device.createBuffer({
        label: 'terrain-multi-layer-material-params',
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.writeMaterialParams(material, paramBuffer);

      const bindGroup = device.createBindGroup({
        label: 'terrain-multi-layer-material-bg',
        layout: materialBindGroupLayout,
        entries: [
          {
            binding: 0,
            resource: albedoArr.createView({ dimension: '2d-array' }),
          },
          {
            binding: 1,
            resource: normalArr.createView({ dimension: '2d-array' }),
          },
          {
            binding: 2,
            resource: heightArr.createView({ dimension: '2d-array' }),
          },
          {
            binding: 3,
            resource: roughArr.createView({ dimension: '2d-array' }),
          },
          { binding: 4, resource: material.splat.texture },
          { binding: 5, resource: paramBuffer },
        ],
      });
      return { bindGroup, paramBuffer };
    },
  };
}
