import type {
  GeometryValue,
  LightingValue,
  MaterialValue,
  SceneEntity,
  SceneValue,
} from '../core/resources.js';
import { lookAt, multiply, orthographic, type Mat4 } from './mat4.js';
import {
  createSceneBindGroupLayout,
  createShadowSampler,
  createSharedSampler,
  instanceVertexBuffers,
  type MaterialKindImpl,
} from './material-kind.js';
import { createPbrKind } from './materials/pbr-kind.js';
import { createTerrainSplatKind } from './materials/terrain-splat-kind.js';
import { debug } from '../core/debug.js';
import { getSampler, gpuObjectId } from './gpu-cache.js';
import bloomDownsampleShaderCode from './bloom-downsample.wgsl';
import bloomUpsampleShaderCode from './bloom-upsample.wgsl';
import brightPassShaderCode from './bright-pass.wgsl';
import compositeShaderCode from './composite.wgsl';
import flatBackgroundShaderCode from './flat-background.wgsl';
import shadowShaderCode from './shadow.wgsl';
import skyShaderCode from './sky.wgsl';

// Shadow pass constants. A fixed ortho extent that comfortably covers the
// forest demo's 100×100m terrain plus tree heights. Smaller previews use
// the same extent — wastes resolution but no correctness issue. The shadow
// box is centered on the camera target each frame so the user can navigate
// without falling out of the shadowed region.
const SHADOW_MAP_SIZE = 2048;

// Per-device singleton for the shadow map. Its size is fixed, it's
// fully overwritten each shadow pass (no carryover state), and only
// one SceneRenderer is active per device at a time — so reusing the
// same GPUTexture across renderer rebuilds is safe and avoids a
// 2048² depth-texture allocation on every scene change.
const shadowTextureCache = new WeakMap<GPUDevice, GPUTexture>();
function getShadowTexture(device: GPUDevice): GPUTexture {
  let tex = shadowTextureCache.get(device);
  if (!tex) {
    tex = device.createTexture({
      size: [SHADOW_MAP_SIZE, SHADOW_MAP_SIZE],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    shadowTextureCache.set(device, tex);
  }
  return tex;
}
const SHADOW_HALF_EXTENT = 75;       // ortho XY half-size (150m total each axis)
const SHADOW_EYE_DISTANCE = 200;     // light "eye" offset from target along light dir
const SHADOW_NEAR = 50;
const SHADOW_FAR = 350;

// Sky + scene geometry render into this format, not into the swapchain.
// 16-bit float per channel preserves the HDR range (sun-lit surfaces can
// hit values > 1) that bloom needs to threshold against. The composite
// pass at the end tone-maps + sRGB-encodes into the swapchain.
const HDR_FORMAT: GPUTextureFormat = 'rgba16float';

// Multi-mip pyramid bloom (the AAA approach used by UE, Unity, COD AW).
//
// We build BLOOM_MIP_COUNT progressively-smaller HDR mips of the
// bright-pass output (mip 0 = half res, each subsequent mip halves
// again). Downsample chain populates the pyramid; upsample chain walks
// back up additively, so by the time we reach mip 0 it contains a sum
// of blurred contributions at every scale. The smallest mips contribute
// the widest, softest halo; the larger ones preserve the tight core.
//
// 6 mips covers a half-screen-wide blur — enough for cinematic glow.
const BLOOM_MIP_COUNT = 6;

// Bloom shape (threshold / soft knee) and intensity are now authored
// per-scene on core/output and travel through LightingValue. Defaults
// live in defaultLighting() (resources.ts).

export interface SceneRenderer {
  /**
   * Update the per-scene batch list. Called whenever the SceneValue
   * coming from the eval pipeline changes (every material edit, every
   * topology change). Cheap compared to recreating the renderer:
   * pipelines, samplers, layouts, shadow texture, post-process
   * intermediates all stay alive — only the per-entity instance
   * buffers and per-material bind groups get rebuilt.
   */
  setScene(scene: SceneValue): void;
  render(params: {
    encoder: GPUCommandEncoder;
    /** Final swapchain view — the composite pass writes here. */
    colorView: GPUTextureView | GPUTexture;
    /**
     * Canvas backing-buffer size. The renderer manages depth + HDR scene
     * + bloom textures internally and (re)allocates them when this
     * changes.
     */
    size: [number, number];
    modelView: Mat4;
    projection: Mat4;
    /** Orbit target in world space — center of the shadow region. */
    cameraTarget: [number, number, number];
    lighting: LightingValue;
    /**
     * Flat-preview mode for "inspect the asset" tiles (texture /
     * heightfield previews). When true:
     *   - the background pass draws a gray checkerboard instead of
     *     the atmospheric sky (so transparency reads obviously and
     *     the sky doesn't compete with the asset)
     *   - composite skips Khronos Neutral tonemap so authored values
     *     round-trip identity through srgb_to_linear ↔ linear_to_srgb
     *
     * Defaults to false; normal scenes get sky + tonemap as before.
     */
    flatPreview?: boolean;
  }): void;
  /**
   * Free the renderer's owned GPU resources (depth + HDR + bloom mip
   * textures). Call when the renderer is being discarded — e.g. on
   * PreviewTile unmount. Cached device-level resources (samplers,
   * pipelines, etc.) survive because they're shared.
   */
  destroy(): void;
}

interface Batch {
  kindId: MaterialValue['kind'];
  material: MaterialValue;
  geometry: GeometryValue;
  materialBindGroup: GPUBindGroup;
  instanceBuffer: GPUBuffer;
  instanceCount: number;
  /**
   * The material's structural-fingerprint string. Lets setScene look
   * the batch up by (geometry, structuralKey, instanceCount) when
   * rebuilding so the instance buffer can be reused across editing
   * gestures that don't change the entity layout.
   */
  structuralKey: string;
}

interface CachedMaterial {
  bindGroup: GPUBindGroup;
  /**
   * The per-material uniform buffer the bind group points at. Cached
   * setScene calls write new scalar values into this buffer instead of
   * allocating a new one — slider scrubs become a writeBuffer per
   * frame, no createBuffer / createBindGroup churn.
   */
  paramBuffer: GPUBuffer;
}

// Module-level shared state. The app holds a single GPUDevice for its
// lifetime, and almost everything the SceneRenderer needs (pipelines,
// layouts, samplers, renderer-internal uniform buffers + their bind
// groups, the material-kind registry) is fully determined by
// (device, format) and doesn't depend on the scene or the renderer
// instance. Hoisting this state out of the per-renderer closure means
// a freshly-mounted ScenePreview's first setScene allocates nothing
// new for content already rendered by another renderer.
//
// Three reference-counted pools at module scope plus one always-alive
// SharedRendererState singleton:
//
//   • materialCacheGlobal — paramBuffer + bind group per material
//     structural key.
//   • intermediatesByKey — depth + HDR + bloom mip textures keyed by
//     `${width}x${height}`.
//   • instanceBufferPool — per-batch instance buffers keyed by
//     (geometry positionBuffer id, material structural key, instance
//     count).
//
// The reference counts are per-renderer-instance: each SceneRenderer
// records the pool keys it's currently holding. setScene/render/
// destroy adjust the counts via the acquire / release helpers below.
// When a count drops to zero, the entry is removed and its GPU
// resources destroyed (safe even with pending GPU work — WebGPU defers
// physical destruction until in-flight submits complete).
//
// Why this matters: without refcounting, a slider scrub on something
// that changes the GEOMETRY (sphere segments, terrain resolution,
// scatter count) produces new positionBuffer ids per tick → new
// batch keys → new pool entries; old keys are never visited again
// and their instance buffers leak forever. Same for material slider
// scrubs that change a texture handle and for canvas resize creating
// new (w,h) intermediates.

interface PoolEntry<T> {
  value: T;
  refs: number;
}

const materialCacheGlobal = new Map<string, PoolEntry<CachedMaterial>>();

function acquireMaterial(
  key: string,
  build: () => CachedMaterial,
): CachedMaterial {
  let entry = materialCacheGlobal.get(key);
  if (!entry) {
    debug('[pool MATERIAL BUILD]', key);
    entry = { value: build(), refs: 0 };
    materialCacheGlobal.set(key, entry);
  }
  entry.refs++;
  return entry.value;
}

function releaseMaterial(key: string): void {
  const entry = materialCacheGlobal.get(key);
  if (!entry) return;
  entry.refs--;
  // Don't destroy here. A renderer remount in React looks like:
  // useEffect cleanup (destroy → release) immediately followed by
  // the new mount (setScene → acquire). If we destroyed at refs=0
  // we'd evict the entry the next acquire needs. Instead, leave
  // refs=0 entries alive and let an external sweep (or the app's
  // per-frame tick) call `flushUnusedPools` when convenient.
}

interface SharedRendererState {
  device: GPUDevice;
  format: GPUTextureFormat;
  sceneBindGroupLayout: GPUBindGroupLayout;
  shadowBindGroupLayout: GPUBindGroupLayout;
  singleInputLayout: GPUBindGroupLayout;
  compositeLayout: GPUBindGroupLayout;
  sampler: GPUSampler;
  shadowSampler: GPUSampler;
  postSampler: GPUSampler;
  shadowTexture: GPUTexture;
  shadowPipeline: GPURenderPipeline;
  skyPipeline: GPURenderPipeline;
  flatBackgroundPipeline: GPURenderPipeline;
  brightPassPipeline: GPURenderPipeline;
  downsamplePipeline: GPURenderPipeline;
  upsamplePipeline: GPURenderPipeline;
  compositePipeline: GPURenderPipeline;
  sceneUniformBuffer: GPUBuffer;
  shadowUniformBuffer: GPUBuffer;
  skyUniformBuffer: GPUBuffer;
  brightPassUniform: GPUBuffer;
  compositeUniform: GPUBuffer;
  sceneBindGroup: GPUBindGroup;
  shadowBindGroup: GPUBindGroup;
  skyBindGroup: GPUBindGroup;
  kinds: Map<MaterialValue['kind'], MaterialKindImpl>;
}

let sharedState: SharedRendererState | null = null;
function ensureSharedRendererState(
  device: GPUDevice,
  format: GPUTextureFormat,
): SharedRendererState {
  if (sharedState && sharedState.device === device && sharedState.format === format) {
    return sharedState;
  }
  const sceneBindGroupLayout = createSceneBindGroupLayout(device);
  const sampler = createSharedSampler(device);
  const shadowSampler = createShadowSampler(device);
  const shadowTexture = getShadowTexture(device);
  const sceneUniformBuffer = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const sceneBindGroup = device.createBindGroup({
    layout: sceneBindGroupLayout,
    entries: [
      { binding: 0, resource: sceneUniformBuffer },
      { binding: 1, resource: sampler },
      { binding: 2, resource: shadowTexture },
      { binding: 3, resource: shadowSampler },
    ],
  });
  const shadowBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
    ],
  });
  const shadowUniformBuffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const shadowBindGroup = device.createBindGroup({
    layout: shadowBindGroupLayout,
    entries: [{ binding: 0, resource: shadowUniformBuffer }],
  });
  const shadowPipeline = createShadowPipeline(device, shadowBindGroupLayout);
  const kinds = new Map<MaterialValue['kind'], MaterialKindImpl>([
    ['pbr', createPbrKind(device, HDR_FORMAT, sceneBindGroupLayout)],
    ['terrain-splat', createTerrainSplatKind(device, HDR_FORMAT, sceneBindGroupLayout)],
  ]);
  const skyPipeline = createSkyPipeline(device, HDR_FORMAT);
  const flatBackgroundPipeline = createFlatBackgroundPipeline(device, HDR_FORMAT);
  const skyUniformBuffer = device.createBuffer({
    size: 80,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const skyBindGroup = device.createBindGroup({
    layout: skyPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: skyUniformBuffer }],
  });
  const singleInputLayout = createSingleInputLayout(device);
  const compositeLayout = createCompositeLayout(device);
  const brightPassPipeline = createPostProcessPipeline(
    device, singleInputLayout, brightPassShaderCode, HDR_FORMAT,
  );
  const downsamplePipeline = createPostProcessPipeline(
    device, singleInputLayout, bloomDownsampleShaderCode, HDR_FORMAT,
  );
  const upsamplePipeline = createPostProcessPipeline(
    device, singleInputLayout, bloomUpsampleShaderCode, HDR_FORMAT,
    { additive: true },
  );
  const compositePipeline = createPostProcessPipeline(
    device, compositeLayout, compositeShaderCode, format,
  );
  const postSampler = getSampler(device, {
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const brightPassUniform = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const compositeUniform = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  sharedState = {
    device, format,
    sceneBindGroupLayout, shadowBindGroupLayout, singleInputLayout, compositeLayout,
    sampler, shadowSampler, postSampler, shadowTexture,
    shadowPipeline, skyPipeline, flatBackgroundPipeline,
    brightPassPipeline, downsamplePipeline, upsamplePipeline, compositePipeline,
    sceneUniformBuffer, shadowUniformBuffer, skyUniformBuffer,
    brightPassUniform, compositeUniform,
    sceneBindGroup, shadowBindGroup, skyBindGroup,
    kinds,
  };
  return sharedState;
}

interface SizeIntermediates {
  width: number;
  height: number;
  depthTexture: GPUTexture;
  hdrColor: GPUTexture;
  hdrColorView: GPUTextureView | GPUTexture;
  bloomMips: GPUTexture[];
  bloomMipViews: (GPUTextureView | GPUTexture)[];
  bloomMipParamBuffers: GPUBuffer[];
  pyramidBindGroups: GPUBindGroup[];
  brightPassBindGroup: GPUBindGroup;
  compositeBindGroup: GPUBindGroup;
}

const intermediatesByKey = new Map<string, PoolEntry<SizeIntermediates>>();

function acquireIntermediates(
  shared: SharedRendererState,
  width: number,
  height: number,
): { key: string; value: SizeIntermediates } {
  const key = `${width}x${height}`;
  let entry = intermediatesByKey.get(key);
  if (!entry) {
    debug('[pool INTERMEDIATES BUILD]', key);
    entry = { value: buildIntermediates(shared, width, height), refs: 0 };
    intermediatesByKey.set(key, entry);
  }
  entry.refs++;
  return { key, value: entry.value };
}

function releaseIntermediates(key: string): void {
  const entry = intermediatesByKey.get(key);
  if (!entry) return;
  entry.refs--;
  // See releaseMaterial — eviction is deferred to flushUnusedPools so
  // a canvas resize back to a recent size still reuses the entry.
}

function buildIntermediates(
  shared: SharedRendererState,
  width: number,
  height: number,
): SizeIntermediates {
  const { device } = shared;
  const depthTexture = device.createTexture({
    size: [width, height],
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const hdrColor = device.createTexture({
    size: [width, height],
    format: HDR_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const hdrColorView = hdrColor;
  const bloomMips: GPUTexture[] = [];
  const bloomMipViews: (GPUTextureView | GPUTexture)[] = [];
  const bloomMipParamBuffers: GPUBuffer[] = [];
  for (let i = 0; i < BLOOM_MIP_COUNT; i++) {
    const scale = 1 << (i + 1);
    const w = Math.max(1, Math.floor(width / scale));
    const h = Math.max(1, Math.floor(height / scale));
    const tex = device.createTexture({
      size: [w, h],
      format: HDR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    bloomMips.push(tex);
    bloomMipViews.push(tex);
    const buf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      buf, 0,
      new Float32Array([1 / w, 1 / h, 0, 0]) as BufferSource,
    );
    bloomMipParamBuffers.push(buf);
  }
  const pyramidBindGroups: GPUBindGroup[] = [];
  for (let i = 0; i < BLOOM_MIP_COUNT; i++) {
    pyramidBindGroups.push(device.createBindGroup({
      layout: shared.singleInputLayout,
      entries: [
        { binding: 0, resource: bloomMipViews[i]! },
        { binding: 1, resource: shared.postSampler },
        { binding: 2, resource: bloomMipParamBuffers[i]! },
      ],
    }));
  }
  const brightPassBindGroup = device.createBindGroup({
    layout: shared.singleInputLayout,
    entries: [
      { binding: 0, resource: hdrColorView },
      { binding: 1, resource: shared.postSampler },
      { binding: 2, resource: shared.brightPassUniform },
    ],
  });
  const compositeBindGroup = device.createBindGroup({
    layout: shared.compositeLayout,
    entries: [
      { binding: 0, resource: hdrColorView },
      { binding: 1, resource: bloomMipViews[0]! },
      { binding: 2, resource: shared.postSampler },
      { binding: 3, resource: shared.compositeUniform },
    ],
  });
  return {
    width, height,
    depthTexture, hdrColor, hdrColorView,
    bloomMips, bloomMipViews, bloomMipParamBuffers,
    pyramidBindGroups, brightPassBindGroup, compositeBindGroup,
  };
}

// Per-batch instance buffer pool. Reuses across renderer remounts AND
// across renderers that happen to draw the same (geometry, material,
// instance count) batch. writeBuffer serialization on the queue means
// each consumer's render() sees the data IT wrote, even if another
// consumer writes the same buffer in between setScene calls — the
// renders happen synchronously inside a single render() call, queued
// atomically.
const instanceBufferPool = new Map<string, PoolEntry<GPUBuffer>>();

function acquireInstanceBuffer(
  device: GPUDevice,
  key: string,
  byteLength: number,
): GPUBuffer {
  let entry = instanceBufferPool.get(key);
  if (entry && entry.value.size !== byteLength) {
    // Same key but the entity count changed — instance count is part
    // of the key so this shouldn't normally happen, but defensive.
    try { entry.value.destroy(); } catch { /* */ }
    entry = undefined;
  }
  if (!entry) {
    debug('[pool INSTANCE BUILD]', key, byteLength);
    entry = {
      value: device.createBuffer({
        size: byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      }),
      refs: 0,
    };
    instanceBufferPool.set(key, entry);
  }
  entry.refs++;
  return entry.value;
}

function releaseInstanceBuffer(key: string): void {
  const entry = instanceBufferPool.get(key);
  if (!entry) return;
  entry.refs--;
  // Instance-buffer pool keys include the renderer id, so when refs
  // hit 0 NO other renderer can ever match this key. Destroy it
  // immediately rather than waiting for flushUnusedPools — avoids
  // accumulating stale entries across renderer create/destroy
  // cycles. (Materials/intermediates differ: they're keyed by
  // structural content, so a future renderer can legitimately
  // re-acquire them; their eviction stays deferred.)
  if (entry.refs <= 0) {
    try { entry.value.destroy(); } catch { /* */ }
    instanceBufferPool.delete(key);
  }
}

/**
 * Destroy every pool entry currently at refs == 0 across the
 * materialCache, intermediates, and instance buffer pools. Called by
 * the app's per-frame tick (or any other "now is a good time to
 * cleanup" trigger) to reclaim memory used by content that's no
 * longer in any active scene — e.g. mesh-segment slider scrubs that
 * produce a new positionBuffer id each tick.
 *
 * Safe even with pending GPU work — WebGPU's buffer.destroy() /
 * texture.destroy() defer physical destruction until any in-flight
 * submits referencing the resource complete.
 */
export function flushUnusedPools(): void {
  for (const [key, entry] of materialCacheGlobal) {
    if (entry.refs <= 0) {
      debug('[pool EVICTED MATERIAL]', key);
      try { entry.value.paramBuffer.destroy(); } catch { /* */ }
      materialCacheGlobal.delete(key);
    }
  }
  for (const [key, entry] of instanceBufferPool) {
    if (entry.refs <= 0) {
      debug('[pool EVICTED INSTANCE]', key);
      try { entry.value.destroy(); } catch { /* */ }
      instanceBufferPool.delete(key);
    }
  }
  for (const [key, entry] of intermediatesByKey) {
    if (entry.refs <= 0) {
      debug('[pool EVICTED INTERMEDIATES]', key);
      try { entry.value.depthTexture.destroy(); } catch { /* */ }
      try { entry.value.hdrColor.destroy(); } catch { /* */ }
      for (const t of entry.value.bloomMips) {
        try { t.destroy(); } catch { /* */ }
      }
      for (const b of entry.value.bloomMipParamBuffers) {
        try { b.destroy(); } catch { /* */ }
      }
      intermediatesByKey.delete(key);
    }
  }
}

// Per-instance vertex buffer: 16 floats matrix + 4 floats RGBA tint = 20 floats = 80 bytes.
const INSTANCE_FLOATS = 20;

function createShadowPipeline(
  device: GPUDevice,
  shadowBindGroupLayout: GPUBindGroupLayout,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: shadowShaderCode });
  const layout = device.createPipelineLayout({
    bindGroupLayouts: [shadowBindGroupLayout],
  });
  // No fragment stage — we only care about depth output. cullMode 'none'
  // because heightfield meshes are single-sided; if we culled back faces,
  // terrain would vanish from the shadow map.
  return device.createRenderPipeline({
    layout,
    vertex: { module, entryPoint: 'vs_main', buffers: instanceVertexBuffers() },
    primitive: { cullMode: 'none' },
    depthStencil: {
      format: 'depth32float',
      depthWriteEnabled: true,
      depthCompare: 'greater', // reverse-Z, same convention as color pass
    },
  });
}

function createSkyPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: skyShaderCode });
  return device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: {
      format: 'depth32float',
      depthWriteEnabled: false,
      depthCompare: 'always',
    },
  });
}

// Background pipeline for flat-preview tiles. Same depth/format setup
// as the sky pipeline (so the renderer can swap one for the other in
// the main pass without other changes), but draws a screen-space
// checkerboard with no uniforms — auto layout gives it an empty bind
// group that we never bind.
function createFlatBackgroundPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: flatBackgroundShaderCode });
  return device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: {
      format: 'depth32float',
      depthWriteEnabled: false,
      depthCompare: 'always',
    },
  });
}

// Shared "texture + sampler + uniform" bind-group layout used by the
// bright-pass, downsample, and upsample pipelines. The composite
// pipeline needs an extra texture binding (scene + bloom), so it has
// its own layout below.
function createSingleInputLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
}

function createCompositeLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
}

function createPostProcessPipeline(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  code: string,
  outputFormat: GPUTextureFormat,
  options: { additive?: boolean } = {},
): GPURenderPipeline {
  const module = device.createShaderModule({ code });
  // Upsample chain blends additively so each pyramid level's
  // contribution sums into the larger mip rather than overwriting.
  // The bright-pass and downsample pipelines do plain replace.
  const target: GPUColorTargetState = options.additive
    ? {
        format: outputFormat,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        },
      }
    : { format: outputFormat };
  return device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [target] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  });
}

// Monotonic per-process counter used to namespace each SceneRenderer's
// instance-buffer pool keys. Material bind groups can be shared across
// renderers because their contents are structural (texture handles +
// scalar params written every frame). Instance buffers CANNOT be
// shared: they hold the scene's per-entity transforms + tints, which
// differ between consumers. Two renderers showing the same (geometry,
// material, instanceCount) batch but DIFFERENT scenes (e.g. the
// "Branch Palm" subgraph preview vs the main Tree & Bush scene where
// the palm has been scattered to some other world position) would
// otherwise fight over the buffer's contents — last setScene wins,
// and the loser draws its trunk at the winner's coordinates.
let nextRendererId = 0;

export function createSceneRenderer(
  device: GPUDevice,
  format: GPUTextureFormat,
): SceneRenderer {
  const rendererId = nextRendererId++;
  // All format-stable shared resources (pipelines, layouts, samplers,
  // uniform buffers, bind groups, kind registry) come from module-
  // scoped storage. The first createSceneRenderer call builds them;
  // every subsequent call reuses. The renderer instance itself
  // contributes only `batches` (per-call mutable state for the
  // currently-set scene).
  const shared = ensureSharedRendererState(device, format);
  // Scratch arrays — module-scope-stable would be fine too, but
  // they're cheap (small Float32Arrays). Keeping per-renderer to
  // avoid any cross-renderer aliasing if render() ever became async.
  const lightingScratch = new Float32Array(16);
  const skyScratch = new Float32Array(20);
  const bloomScratch = new Float32Array(4);
  const SUN_INTENSITY = 22;

  // Per-scene state. Empty until setScene is first called — render()
  // is a no-op for the scene pass in that case (sky/composite still
  // run). Two caches survive across setScene calls:
  //
  //   • materialCache — keyed on the kind's structural fingerprint
  //     (texture identities + kind discriminators). Same-structure
  //     materials reuse the bind group and the per-material uniform
  //     buffer; only the scalar contents get rewritten via
  //     writeMaterialParams, and only when the scalar fingerprint
  //     actually differs. The slider-scrub case (one material, same
  //     textures, dragging roughness) becomes a single writeBuffer per
  //     frame with zero create/destroy churn.
  //
  //   • instance buffers — kept alive on the previous Batch and
  //     reused across setScene calls when (geometry, structuralKey,
  //     instanceCount) matches. Same matching produces zero buffer
  //     alloc and a single writeBuffer; mismatches destroy + realloc.
  let batches: Batch[] = [];
  // Per-renderer ref tracking. Each setScene call updates these to the
  // CURRENT set of pool keys this renderer is holding refs on. The diff
  // against the previous round tells us which pool entries to release
  // (potentially evicting them when their refs hit zero) and which new
  // ones to acquire. destroy() releases whatever's left.
  let currentMaterialKeys = new Set<string>();
  let currentInstanceKeys = new Set<string>();
  let currentSizeKey: string | null = null;

  function setScene(scene: SceneValue): void {
    // Group entities by (kind, geometry, material) reference equality.
    // Sorting by kind first means we minimize pipeline switches in the
    // render loop.
    const groupsByKind = new Map<
      MaterialValue['kind'],
      Map<GeometryValue, Map<MaterialValue, SceneEntity[]>>
    >();
    for (const entity of scene.entities) {
      const k = entity.material.kind;
      let byGeometry = groupsByKind.get(k);
      if (!byGeometry) {
        byGeometry = new Map();
        groupsByKind.set(k, byGeometry);
      }
      let byMaterial = byGeometry.get(entity.geometry);
      if (!byMaterial) {
        byMaterial = new Map();
        byGeometry.set(entity.geometry, byMaterial);
      }
      let entities = byMaterial.get(entity.material);
      if (!entities) {
        entities = [];
        byMaterial.set(entity.material, entities);
      }
      entities.push(entity);
    }

    // Index the previous batches by their reuse key so we can pull
    // out a matching instance buffer for each new batch in O(1).
    // Anything we don't claim by the end of the loop is destroyed.
    //
    // The geometry identity is keyed on its `positionBuffer` GPUBuffer
    // handle, NOT the outer GeometryValue object — `uploadMeshToGpu`
    // returns a fresh GeometryValue literal each call even when the
    // inner GPU buffers are reused via `reusableBuffer`. The GPUBuffer
    // handles are what's actually stable across evals; keying on the
    // wrapper would miss on every eval round and rebuild every
    // instance buffer in the scene.
    const prevBatchByKey = new Map<string, Batch>();
    for (const b of batches) {
      const key = `${gpuObjectId(b.geometry.positionBuffer as object)}|${b.structuralKey}|${b.instanceCount}`;
      prevBatchByKey.set(key, b);
    }

    const next: Batch[] = [];
    const usedMaterialKeys = new Set<string>();
    const usedInstanceKeys = new Set<string>();

    for (const [kindId, byGeometry] of groupsByKind) {
      const kind = shared.kinds.get(kindId);
      if (!kind) {
        throw new Error(`unknown material kind: ${kindId}`);
      }
      for (const [geometry, byMaterial] of byGeometry) {
        for (const [material, entities] of byMaterial) {
          // Material side: cache lookup / build / always rewrite
          // scalars. We deliberately don't fingerprint the scalars to
          // skip the write — writeBuffer for ~16-32 bytes is cheap
          // enough that the comparison's not worth its keep.
          const structuralKey = (
            kind.materialStructuralKey as (m: MaterialValue) => string
          )(material);
          const cacheKey = `${kindId}:${structuralKey}`;
          usedMaterialKeys.add(cacheKey);
          // Acquire (or reuse) the material entry. If the entry was
          // already in the pool from this OR another renderer, just
          // increment refs and reuse — but ALWAYS rewrite the scalar
          // uniforms because they're per-material-instance state, not
          // per-structural-key.
          const wasCached = materialCacheGlobal.has(cacheKey);
          const cached = acquireMaterial(cacheKey, () => {
            const built = (
              kind.buildBindGroup as (m: MaterialValue) => {
                bindGroup: GPUBindGroup;
                paramBuffer: GPUBuffer;
              }
            )(material);
            return { bindGroup: built.bindGroup, paramBuffer: built.paramBuffer };
          });
          if (wasCached) {
            (kind.writeMaterialParams as (m: MaterialValue, b: GPUBuffer) => void)(
              material,
              cached.paramBuffer,
            );
          }

          // Instance side: acquire from the per-batch pool. Refs work
          // the same way — repeat calls with the same key just bump
          // the count.
          const instanceCount = entities.length;
          const instanceData = new Float32Array(instanceCount * INSTANCE_FLOATS);
          for (let i = 0; i < instanceCount; i++) {
            const e = entities[i]!;
            instanceData.set(e.transform, i * INSTANCE_FLOATS);
            instanceData.set(e.tint, i * INSTANCE_FLOATS + 16);
          }
          // Renderer-scoped key. See `nextRendererId` declaration for
          // why instance buffers can't be shared across renderers like
          // material bind groups are.
          const instanceKey = `r${rendererId}|${gpuObjectId(geometry.positionBuffer as object)}|${structuralKey}|${instanceCount}`;
          const instanceBuffer = acquireInstanceBuffer(
            device,
            instanceKey,
            instanceData.byteLength,
          );
          device.queue.writeBuffer(instanceBuffer, 0, instanceData as BufferSource);
          usedInstanceKeys.add(instanceKey);

          next.push({
            kindId,
            material,
            geometry,
            materialBindGroup: cached.bindGroup,
            instanceBuffer,
            instanceCount,
            structuralKey,
          });
        }
      }
    }

    // Release the refs this renderer USED to hold but no longer does.
    // Pool entries whose total refs hit zero get destroyed.
    for (const k of currentMaterialKeys) {
      if (!usedMaterialKeys.has(k)) releaseMaterial(k);
    }
    for (const k of currentInstanceKeys) {
      if (!usedInstanceKeys.has(k)) releaseInstanceBuffer(k);
    }
    // The new "currently held" sets are what this round acquired.
    // (acquireMaterial / acquireInstanceBuffer already bumped refs.)
    currentMaterialKeys = usedMaterialKeys;
    currentInstanceKeys = usedInstanceKeys;
    void prevBatchByKey;

    batches = next;
    debug(() => {
      const summary = batches.map((b) =>
        `[${b.kindId} pos#${gpuObjectId(b.geometry.positionBuffer as object)} idx=${b.geometry.indexCount} inst=${b.instanceCount}]`,
      ).join(' ');
      return `[SceneRenderer setScene] batches=${batches.length} ${summary}`;
    });
  }

  function destroy(): void {
    // Release every ref this renderer is currently holding. Pool
    // entries that hit zero refs are physically destroyed; entries
    // still held by other renderers stay alive.
    for (const k of currentMaterialKeys) releaseMaterial(k);
    for (const k of currentInstanceKeys) releaseInstanceBuffer(k);
    if (currentSizeKey !== null) releaseIntermediates(currentSizeKey);
    currentMaterialKeys = new Set();
    currentInstanceKeys = new Set();
    currentSizeKey = null;
    batches = [];
  }

  return {
    setScene,
    destroy,
    render({ encoder, colorView, size, modelView, projection, cameraTarget, lighting, flatPreview = false }) {
      const [width, height] = size;
      // Acquire intermediates for THIS size. If we previously held a
      // different size's ref, release it first so a canvas resize
      // doesn't accumulate stale intermediates forever.
      const acquired = acquireIntermediates(shared, width, height);
      if (currentSizeKey !== null && currentSizeKey !== acquired.key) {
        releaseIntermediates(currentSizeKey);
      } else if (currentSizeKey === acquired.key) {
        // Same size as last render — acquire bumped refs by 1, undo.
        releaseIntermediates(acquired.key);
      }
      currentSizeKey = acquired.key;
      const {
        depthTexture, hdrColorView, bloomMips,
        pyramidBindGroups, brightPassBindGroup, compositeBindGroup,
      } = acquired.value;
      const {
        sceneUniformBuffer, shadowUniformBuffer, skyUniformBuffer,
        brightPassUniform, compositeUniform,
        sceneBindGroup, shadowBindGroup, skyBindGroup,
        shadowTexture, shadowPipeline,
        skyPipeline, flatBackgroundPipeline,
        brightPassPipeline, downsamplePipeline, upsamplePipeline, compositePipeline,
      } = shared;

      // Light view+projection. Eye sits along the light direction from the
      // camera target so the shadow box tracks the user. lookAt with up=+Y
      // works for any light angle that isn't straight overhead; demos use
      // slanted sun so no fallback needed yet.
      // Sun direction in world space, normalized. Single source used by
      // shadow eye, scene-uniform lighting block, and sky uniform.
      const sd = lighting.direction;
      const sdLen = Math.hypot(sd[0], sd[1], sd[2]);
      const sdx = sd[0] / sdLen;
      const sdy = sd[1] / sdLen;
      const sdz = sd[2] / sdLen;
      // Day/night factor based on sun elevation. 0 below the horizon,
      // smoothly rises to 1 over the first ~6° of elevation. Direct
      // sun light and fog color scale by it (both go to 0 at night so
      // the scene goes dark and distant geometry stops fading toward
      // a bright fog tone). Ambient gets a softer curve with a 10%
      // floor — backlit surfaces would otherwise be pure black at
      // night. Without these auto-fades, putting the sun below the
      // floor leaves the scene daylit while the sky goes dark.
      const dayT = Math.max(0, Math.min(1, (sdy + 0.05) / 0.15));
      const dayFactor = dayT * dayT * (3 - 2 * dayT);
      const ambFactor = 0.1 + 0.9 * dayFactor;

      const eye: [number, number, number] = [
        cameraTarget[0] + sdx * SHADOW_EYE_DISTANCE,
        cameraTarget[1] + sdy * SHADOW_EYE_DISTANCE,
        cameraTarget[2] + sdz * SHADOW_EYE_DISTANCE,
      ];
      const lightView = lookAt(eye, cameraTarget, [0, 1, 0]);
      const lightProj = orthographic(
        -SHADOW_HALF_EXTENT, SHADOW_HALF_EXTENT,
        -SHADOW_HALF_EXTENT, SHADOW_HALF_EXTENT,
        SHADOW_NEAR, SHADOW_FAR,
      );
      const lightViewProj = multiply(lightProj, lightView);

      device.queue.writeBuffer(sceneUniformBuffer, 0, modelView as BufferSource);
      device.queue.writeBuffer(sceneUniformBuffer, 64, projection as BufferSource);
      device.queue.writeBuffer(sceneUniformBuffer, 128, lightViewProj as BufferSource);
      lightingScratch[0]  = sdx;
      lightingScratch[1]  = sdy;
      lightingScratch[2]  = sdz;
      lightingScratch[4]  = lighting.color[0] * dayFactor;
      lightingScratch[5]  = lighting.color[1] * dayFactor;
      lightingScratch[6]  = lighting.color[2] * dayFactor;
      lightingScratch[8]  = lighting.ambient[0] * ambFactor;
      lightingScratch[9]  = lighting.ambient[1] * ambFactor;
      lightingScratch[10] = lighting.ambient[2] * ambFactor;
      lightingScratch[12] = lighting.fogColor[0] * dayFactor;
      lightingScratch[13] = lighting.fogColor[1] * dayFactor;
      lightingScratch[14] = lighting.fogColor[2] * dayFactor;
      lightingScratch[15] = lighting.fogDensity;
      device.queue.writeBuffer(sceneUniformBuffer, 192, lightingScratch as BufferSource);

      device.queue.writeBuffer(shadowUniformBuffer, 0, lightViewProj as BufferSource);

      // Bloom uniforms. Written every frame so the user can drag the
      // sliders on core/output and see the change live. flatPreview
      // disables tonemap so the asset's authored values round-trip
      // identity to the display.
      bloomScratch[0] = lighting.bloomThreshold;
      bloomScratch[1] = lighting.bloomSoftKnee;
      device.queue.writeBuffer(brightPassUniform, 0, bloomScratch as BufferSource);
      bloomScratch[0] = lighting.bloomIntensity;
      bloomScratch[1] = flatPreview ? 0 : 1; // tonemap_enabled
      device.queue.writeBuffer(compositeUniform, 0, bloomScratch as BufferSource);

      // Camera basis (world space) = rows of modelView's rotation block.
      // modelView = T(0,0,-d) * R * T(-target); the upper-left 3×3 is R,
      // and rows of R are the world directions of the camera's right /
      // up / -back axes (R⁻¹ = Rᵀ for an orthonormal rotation).
      // Column-major Mat4: m[row + 4*col], so row 0 is m[0], m[4], m[8].
      const m = modelView;
      const rightX = m[0]!,  rightY = m[4]!,  rightZ = m[8]!;
      const upX    = m[1]!,  upY    = m[5]!,  upZ    = m[9]!;
      const fwdX   = -m[2]!, fwdY   = -m[6]!, fwdZ   = -m[10]!;
      // perspective(fov) packs f = tan(π/2 - fov/2) into m[5] and
      // f/aspect into m[0]; recover tan(fov/2) = 1/f and aspect = f / m[0].
      const f = projection[5]!;
      const tanHalfFov = 1 / f;
      const aspect = f / projection[0]!;

      skyScratch[0]  = rightX;  skyScratch[1]  = rightY;  skyScratch[2]  = rightZ;  skyScratch[3]  = tanHalfFov;
      skyScratch[4]  = upX;     skyScratch[5]  = upY;     skyScratch[6]  = upZ;     skyScratch[7]  = aspect;
      skyScratch[8]  = fwdX;    skyScratch[9]  = fwdY;    skyScratch[10] = fwdZ;    skyScratch[11] = SUN_INTENSITY;
      skyScratch[12] = sdx;     skyScratch[13] = sdy;     skyScratch[14] = sdz;     skyScratch[15] = 0;
      // Fog color matches what we just wrote into scene uniforms, so
      // sky's horizon blend uses the same (day/night-faded) color the
      // scene fog fades distant geometry into.
      skyScratch[16] = lighting.fogColor[0] * dayFactor;
      skyScratch[17] = lighting.fogColor[1] * dayFactor;
      skyScratch[18] = lighting.fogColor[2] * dayFactor;
      skyScratch[19] = 0;
      device.queue.writeBuffer(skyUniformBuffer, 0, skyScratch as BufferSource);

      // Shadow pass — depth-only render from the light's POV. Uses the
      // same vertex layout as the color pass so we just rebind the same
      // buffers per batch. No pipeline switch per kind: one shadow shader
      // handles everything.
      const shadowPass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: shadowTexture,
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      shadowPass.setPipeline(shadowPipeline);
      shadowPass.setBindGroup(0, shadowBindGroup);
      for (const b of batches) {
        // Skip empty geometries. An upstream node with zero output (a
        // scatter that filtered everything out, an empty merge, an
        // unwired source) produces a GeometryValue with indexCount=0
        // and placeholder vertex/index buffers. Binding those for a
        // no-op drawIndexed(0, …) is technically a spec-legal no-op,
        // but stricter drivers (some real Chrome WebGPU backends)
        // refuse the setVertexBuffer call because the placeholder
        // buffer is smaller than the pipeline's required stride —
        // and once any command in the pass is invalid, the whole
        // submit fails, taking down OTHER entities (e.g. the palm
        // trunk) along with the empty one.
        if (b.geometry.indexCount === 0) continue;
        shadowPass.setVertexBuffer(0, b.geometry.positionBuffer);
        shadowPass.setVertexBuffer(1, b.geometry.normalBuffer);
        shadowPass.setVertexBuffer(2, b.geometry.uvBuffer);
        shadowPass.setVertexBuffer(3, b.instanceBuffer);
        shadowPass.setIndexBuffer(b.geometry.indexBuffer, b.geometry.indexFormat);
        shadowPass.drawIndexed(b.geometry.indexCount, b.instanceCount);
      }
      shadowPass.end();

      // Main color pass — writes linear-HDR into hdrColor.
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: hdrColorView!,
            clearValue: [0, 0, 0, 1],
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: depthTexture!,
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });

      // Background fill first. Atmosphere sky for normal scenes; flat
      // checkerboard for asset-inspection tiles. flatBackgroundPipeline
      // has no uniforms so we don't bind a group for it.
      if (flatPreview) {
        pass.setPipeline(flatBackgroundPipeline);
        pass.draw(3);
      } else {
        pass.setPipeline(skyPipeline);
        pass.setBindGroup(0, skyBindGroup);
        pass.draw(3);
      }

      // Scene geometry, dispatched per kind. Scene bind group is set once;
      // pipeline + material bind group switch per batch. Batches were
      // sorted by kindId so all draws of one kind run consecutively, but
      // within a kind the pipeline can still differ per batch (opaque vs
      // cutout) — we just skip the setPipeline call when nothing changed.
      //
      // In flat-preview mode we pick each kind's alpha-blended variant
      // when it provides one — that's how a texture with a transparent
      // alpha channel composites over the checkerboard instead of
      // punching through it as fully opaque. Outside flat-preview, a
      // kind's `pickPipeline` (if provided) chooses between opaque and
      // cutout based on the material itself.
      pass.setBindGroup(0, sceneBindGroup);
      let activePipeline: GPURenderPipeline | null = null;
      for (const b of batches) {
        // Same empty-geometry skip as the shadow pass — see the
        // longer comment there for rationale.
        if (b.geometry.indexCount === 0) continue;
        const kind = shared.kinds.get(b.kindId)!;
        const pipelineForBatch =
          flatPreview && kind.pipelineBlended
            ? kind.pipelineBlended
            : kind.pickPipeline
              ? (kind.pickPipeline as (m: MaterialValue) => GPURenderPipeline)(b.material)
              : kind.pipeline;
        if (pipelineForBatch !== activePipeline) {
          pass.setPipeline(pipelineForBatch);
          activePipeline = pipelineForBatch;
        }
        pass.setBindGroup(1, b.materialBindGroup);
        pass.setVertexBuffer(0, b.geometry.positionBuffer);
        pass.setVertexBuffer(1, b.geometry.normalBuffer);
        pass.setVertexBuffer(2, b.geometry.uvBuffer);
        pass.setVertexBuffer(3, b.instanceBuffer);
        pass.setIndexBuffer(b.geometry.indexBuffer, b.geometry.indexFormat);
        pass.drawIndexed(b.geometry.indexCount, b.instanceCount);
      }
      pass.end();

      // Bright-pass: scene HDR → mip 0 (half-res, replace).
      const bright = encoder.beginRenderPass({
        colorAttachments: [
          { view: bloomMips[0]!, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
        ],
      });
      bright.setPipeline(brightPassPipeline);
      bright.setBindGroup(0, brightPassBindGroup!);
      bright.draw(3);
      bright.end();

      // Downsample chain: mip 0 → 1 → 2 → ... → (count-1). Each pass
      // reads the larger mip and writes a fresh smaller one.
      for (let i = 0; i < BLOOM_MIP_COUNT - 1; i++) {
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            { view: bloomMips[i + 1]!, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
          ],
        });
        pass.setPipeline(downsamplePipeline);
        pass.setBindGroup(0, pyramidBindGroups[i]!);
        pass.draw(3);
        pass.end();
      }

      // Upsample chain: mip (count-1) → (count-2) → ... → 0, additively.
      // `loadOp: 'load'` preserves the downsample contribution at each
      // level so the additive blend sums the two. Each upsample step's
      // smaller-mip source is now the SUM of all smaller scales below
      // it, so by the time we land on mip 0 it holds the full pyramid.
      for (let i = BLOOM_MIP_COUNT - 1; i > 0; i--) {
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            { view: bloomMips[i - 1]!, loadOp: 'load', storeOp: 'store' },
          ],
        });
        pass.setPipeline(upsamplePipeline);
        pass.setBindGroup(0, pyramidBindGroups[i]!);
        pass.draw(3);
        pass.end();
      }

      // Composite: scene HDR + mip 0 (accumulated bloom) → swapchain
      // (tone-map + sRGB encode).
      const composite = encoder.beginRenderPass({
        colorAttachments: [
          { view: colorView, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' },
        ],
      });
      composite.setPipeline(compositePipeline);
      composite.setBindGroup(0, compositeBindGroup!);
      composite.draw(3);
      composite.end();
    },
  };
}
