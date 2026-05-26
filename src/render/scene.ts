import type {
  GeometryValue,
  GrassFieldValue,
  LightingValue,
  MaterialValue,
  SceneEntity,
  SceneValue,
  TerrainFieldValue,
} from '../core/resources.js';
import { createGrassSystem, type GrassSystem } from './grass.js';
import { ATMOSPHERIC_SUN_INTENSITY } from './sky-sample.js';
import { lookAt, multiply, orthographic, type Mat4 } from './mat4.js';
import {
  createSceneBindGroupLayout,
  createShadowSampler,
  createSharedSampler,
  instanceVertexBuffers,
  type MaterialKindImpl,
} from './material-kind.js';
import { createPbrKind } from './materials/pbr-kind.js';
import { createTerrainMultiLayerKind } from './materials/terrain-multi-layer-kind.js';
import { createTerrainSplatKind } from './materials/terrain-splat-kind.js';
import { createWaterKind } from './materials/water-kind.js';
import { createTerrainSystem, type TerrainSystem } from './terrain-render.js';
import { debug } from '../core/debug.js';
import { getSampler, gpuObjectId } from './gpu-cache.js';
import bloomDownsampleShaderCode from './bloom-downsample.wgsl';
import bloomUpsampleShaderCode from './bloom-upsample.wgsl';
import brightPassShaderCode from './bright-pass.wgsl';
import compositeShaderCode from './composite.wgsl';
import flatBackgroundShaderCode from './flat-background.wgsl';
import shadowShaderCode from './shadow.wgsl';
import skyShaderCode from './sky.wgsl';
import pickShaderCode from './pick.wgsl';
import outlineShaderCode from './outline.wgsl';
import { pickProjection as buildPickProjection } from './mat4.js';

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
    /**
     * Elapsed seconds, fed into the grass wind animation. Advances
     * only while the user has animation playing; frozen (constant)
     * otherwise, so paused previews show static grass. Defaults to 0.
     */
    time?: number;
  }): void;
  /**
   * Free the renderer's owned GPU resources (depth + HDR + bloom mip
   * textures). Call when the renderer is being discarded — e.g. on
   * PreviewTile unmount. Cached device-level resources (samplers,
   * pipelines, etc.) survive because they're shared.
   */
  destroy(): void;
  /**
   * GPU picking. Renders ONLY the pixel at (`x`, `y`) (in the same
   * viewport-pixel space as the colour render) into a 1×1 R32Uint
   * target and reads back the id. Resolves to the pickId at that
   * pixel — `0` for "miss" (no geometry; sky / clear). The off-centre
   * `pickProjection` constructed from the click pixel reduces this to a
   * normal-cost vertex pass with the same model-view as colour
   * rendering; CPU/GPU culling against this 1×1 frustum drops most
   * geometry before vertex work. Pair the result with `getPickInfo`.
   */
  pickAt(params: {
    x: number;
    y: number;
    viewportWidth: number;
    viewportHeight: number;
    modelView: Mat4;
    fovYRadians: number;
    aspect: number;
    zNear: number;
    zFar: number;
  }): Promise<number>;
  /**
   * Resolve a pickId from `pickAt` back to its source entity's
   * provenance + world transform, or `null` if the id is unknown
   * (miss, or the scene changed since the click was issued).
   */
  getPickInfo(id: number): { provenance: NonNullable<SceneEntity['provenance']> | undefined; transform: Float32Array } | null;
  /**
   * Set the current selection — any subsequent `render()` calls will
   * draw an outline around every batch instance that matches it.
   * `null` clears the selection.
   *
   * Match rules:
   *  - `kind: 'placement'` highlights every entity whose deepest
   *    placement is (`distributeNodeId`, `pointIndex`). That lines up
   *    with what the F-key and Frame-menu items target — clicking a
   *    leaf and pressing F outlines the whole tree (trunk + foliage),
   *    not just the leaf cluster.
   *  - `kind: 'origin'` highlights every entity whose
   *    `provenance.originNodeId` matches. Used for non-scattered
   *    entities (a single-mesh terrain, an authored object).
   */
  setSelection(sel: SceneSelection | null): void;
  /**
   * World-space bounding sphere of the union of every entity that
   * matches `sel` — center and radius. Used by Frame Selected to pick
   * a camera target that's the actual MIDDLE of (say) the whole tree
   * rather than the placement origin (which is often at the base/foot
   * of a tree subgraph and would put the camera looking at the ground
   * with the tree off-screen above). Returns `null` if no entities
   * match or the selection is null. Entities whose geometry has no
   * CPU mesh (purely GPU-generated) are skipped — they contribute
   * no bounds, but a single-mesh terrain returns the terrain's bounds
   * because its geometry carries its CpuMeshRef.
   */
  getSelectionBounds(sel: SceneSelection): { center: [number, number, number]; radius: number } | null;
}

/** What `setSelection` interprets as "the selection." */
export type SceneSelection =
  | { kind: 'placement'; distributeNodeId: string; pointIndex: number }
  | { kind: 'origin'; originNodeId: string };

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
  /**
   * First pickId reserved for this batch — the i-th instance's pickId is
   * `pickBaseId + i`, matching the `batch.baseId + @builtin(instance_index)`
   * the pick shader emits. Allocated by setScene as a flat counter across
   * batches; the renderer-owned `pickTable` resolves each id back to a
   * `SceneEntity`'s provenance + transform.
   */
  pickBaseId: number;
  /**
   * Source entities in instance-buffer order. Kept on the batch so the
   * pick path can populate `pickTable` lazily and so we can recover the
   * per-instance world transform (instance index → entity → transform)
   * for the framing math without re-deriving it from the GPU buffer.
   */
  entities: SceneEntity[];
}

/** What a pickId resolves to — used by GPU-picking → "frame this". */
interface PickTableEntry {
  provenance: SceneEntity['provenance'];
  transform: Float32Array;
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
  // GPU picking: one pipeline serves every material kind (we only need
  // positions + the per-instance matrix to project; everything else —
  // normals, uvs, tints, lighting, shadows, fog — is irrelevant for an
  // id-only pass). pickSceneLayout binds the per-frame uniform
  // (modelView + pickProjection); pickBatchLayout's binding 0 uses a
  // DYNAMIC OFFSET so a single buffer can hold every batch's baseId
  // with the offset picked per draw.
  pickSceneLayout: GPUBindGroupLayout;
  pickBatchLayout: GPUBindGroupLayout;
  pickPipeline: GPURenderPipeline;
  /** WebGPU's min uniform-buffer offset alignment (typically 256). */
  pickBatchStride: number;
  // Selection-outline pipelines (see outline.wgsl). Both stable per
  // (device, format); the per-renderer side holds only the R8Unorm
  // mask texture + scene/outline uniform buffers, allocated lazily on
  // the first setSelection that has anything to draw.
  outlineMaskLayout: GPUBindGroupLayout;
  outlineMaskPipeline: GPURenderPipeline;
  outlineCompositeLayout: GPUBindGroupLayout;
  outlineCompositePipeline: GPURenderPipeline;
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
    // 192 (3 mat4) + 80 (lighting block) + 16 (time/pad).
    //
    // Time lands at offset 272 as a single f32 — water.wgsl declares
    // it as part of its `Uniforms` struct so per-pixel ripples can
    // animate without a dedicated bind group. Other shaders don't
    // need to know — WGSL `Uniforms` structs are per-shader and only
    // describe the bytes the shader actually reads, so leaving them
    // unchanged is safe as long as offsets 0..271 stay stable.
    size: 288,
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
    ['terrain-multi-layer', createTerrainMultiLayerKind(device, HDR_FORMAT, sceneBindGroupLayout)],
    ['water', createWaterKind(device, HDR_FORMAT, sceneBindGroupLayout)],
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
  // Pick (GPU-id) pipeline — see pick.wgsl. Same vertex layout as the
  // colour PBR pipeline for position + instance, but ignores normals,
  // uvs, materials, lighting. Reverse-Z depth32float so the closest-on-
  // screen instance wins on overlap, matching the colour pass's depth.
  const pickSceneLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
    ],
  });
  const pickBatchLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform', hasDynamicOffset: true },
      },
    ],
  });
  const pickModule = device.createShaderModule({ code: pickShaderCode });
  const pickPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [pickSceneLayout, pickBatchLayout] }),
    vertex: {
      module: pickModule,
      entryPoint: 'vs_main',
      // Same per-slot layout the colour pipelines use (positions /
      // normals / uvs / per-instance matrix + tint). The pick shader
      // only references @location(0) and @locations(3..6), so declaring
      // the extra attributes is harmless — but declaring empty
      // attribute arrays on slots 1/2 trips WebGPU's draw-time
      // validation in some implementations.
      buffers: instanceVertexBuffers(),
    },
    fragment: {
      module: pickModule,
      entryPoint: 'fs_main',
      targets: [{ format: 'r32uint' }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: {
      format: 'depth32float',
      depthWriteEnabled: true,
      depthCompare: 'greater', // reverse-Z, same as the colour pipeline
    },
  });
  // Match the device's required alignment so dynamic-offset binds are
  // legal. Each batch only stores a u32 baseId so 16 bytes would be
  // enough payload, but the alignment is typically 256.
  const pickBatchStride = Math.max(16, device.limits.minUniformBufferOffsetAlignment);

  // ---- Selection-outline pipelines (see outline.wgsl) ----
  const outlineModule = device.createShaderModule({ code: outlineShaderCode });
  const outlineMaskLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
    ],
  });
  const outlineMaskPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [outlineMaskLayout] }),
    vertex: {
      module: outlineModule,
      entryPoint: 'mask_vs',
      buffers: instanceVertexBuffers(),
    },
    fragment: {
      module: outlineModule,
      entryPoint: 'mask_fs',
      targets: [{ format: 'r8unorm' }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: {
      // Format matches the scene depth so we can pass that attachment
      // through. `depthCompare: 'always'` + write-disabled gives an
      // x-ray outline: the selection shows through occluders. Sharing
      // the scene depth and switching to `greater-equal` for true
      // silhouette tracking is broken in practice — the depths PBR
      // wrote don't round-trip bit-exact through this minimal vertex
      // shader, so equality rejects everything. Most DCC tools use
      // x-ray for selection anyway; revisit with a depth pre-pass +
      // bias if true silhouette tracking is needed.
      format: 'depth32float',
      depthWriteEnabled: false,
      depthCompare: 'always',
    },
  });

  const outlineCompositeLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  const outlineCompositePipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [outlineCompositeLayout] }),
    vertex: { module: outlineModule, entryPoint: 'composite_vs' },
    fragment: {
      module: outlineModule,
      entryPoint: 'composite_fs',
      // No blend state. The fragment shader `discard`s everywhere off
      // the outline ring, so non-outline fragments never write to the
      // swapchain and the underlying PBR-composited pixels are
      // preserved verbatim. Outline-ring fragments overwrite the
      // single-pixel ring with the opaque outline colour.
      targets: [{ format }],
    },
    primitive: { topology: 'triangle-list' },
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
    pickSceneLayout, pickBatchLayout, pickPipeline, pickBatchStride,
    outlineMaskLayout, outlineMaskPipeline,
    outlineCompositeLayout, outlineCompositePipeline,
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
  // 20 floats = 80 bytes: lightDir.xyz+pad, lightColor.xyz+pad,
  // skyColor.xyz+ambientIntensity, groundColor.xyz+pad, fog (rgb+density).
  const lightingScratch = new Float32Array(20);
  const skyScratch = new Float32Array(20);
  const bloomScratch = new Float32Array(4);
  // Single source of truth — also used by sky-sample.ts so deriveLighting
  // samples the atmosphere at the same brightness the rendered sky uses.
  const SUN_INTENSITY = ATMOSPHERIC_SUN_INTENSITY;

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
  // Camera-relative grass. Created LAZILY on the first scene that
  // actually has a grass field — most renderers (in-node previews,
  // texture thumbnails, grass-less scenes) never build the compute /
  // indirect pipelines at all. Lazy creation also keeps the mock-GPU
  // unit tests working: they render grass-less scenes, so they never
  // hit `device.createComputePipeline`. Placement is per-view, so the
  // slot buffers live on the renderer; the pipelines are device-shared.
  let grassSystem: GrassSystem | null = null;
  let grassFields: GrassFieldValue[] = [];
  function ensureGrass(): GrassSystem {
    if (!grassSystem) {
      // HDR format matches the color pass target (grass draws into
      // hdrColor, not the swapchain); depth matches the shared
      // depth32float intermediate.
      grassSystem = createGrassSystem(device, shared.sceneBindGroupLayout, HDR_FORMAT, 'depth32float');
    }
    return grassSystem;
  }
  // Same lazy pattern for terrain (chunked-LOD renderer). Created on
  // first use, never destroyed during the lifetime of the renderer.
  // The material-bind-group layout has to match the terrain-multi-
  // layer kind exactly so a single bind group is shared between the
  // terrain renderer and any scene-entity that also uses the kind.
  let terrainSystem: TerrainSystem | null = null;
  let terrainFields: TerrainFieldValue[] = [];
  function ensureTerrain(): TerrainSystem {
    if (!terrainSystem) {
      const tmlKind = shared.kinds.get('terrain-multi-layer');
      if (!tmlKind) throw new Error('terrain renderer requires the terrain-multi-layer material kind');
      const materialBindGroupLayout = (tmlKind.pipeline.getBindGroupLayout as (i: number) => GPUBindGroupLayout)(1);
      terrainSystem = createTerrainSystem(
        device,
        HDR_FORMAT,
        shared.sceneBindGroupLayout,
        materialBindGroupLayout,
      );
    }
    return terrainSystem;
  }
  // Per-renderer ref tracking. Each setScene call updates these to the
  // CURRENT set of pool keys this renderer is holding refs on. The diff
  // against the previous round tells us which pool entries to release
  // (potentially evicting them when their refs hit zero) and which new
  // ones to acquire. destroy() releases whatever's left.
  let currentMaterialKeys = new Set<string>();
  let currentInstanceKeys = new Set<string>();
  let currentSizeKey: string | null = null;

  // -----------------------------------------------------------------
  // GPU picking — per-renderer state, all LAZILY built.
  // -----------------------------------------------------------------
  // Renderers that never get clicked (texture-thumbnail tiles, headless
  // unit tests that don't touch picking) allocate nothing here, so the
  // existing "fresh renderer allocates exactly N resources" assertions
  // stay accurate. Resources are created on first pickAt and reused
  // forever after.
  interface PickResources {
    colorTex: GPUTexture;
    depthTex: GPUTexture;
    readback: GPUBuffer;
    sceneBuffer: GPUBuffer;
    sceneBindGroup: GPUBindGroup;
    batchBuffer: GPUBuffer;
    batchBindGroup: GPUBindGroup;
    batchCapacity: number;
  }
  let pickResources: PickResources | null = null;
  // pickTable[id] resolves a fragment id back to its source entity.
  // Index 0 is reserved for "miss" (the clear value), so the first
  // real entity gets id 1. Populated in setScene regardless of whether
  // picking has fired yet — it's just a JS array (~24B/entry).
  let pickTable: (PickTableEntry | undefined)[] = [];

  // ---- Selection outline (P4) ----
  // Current selection + the per-batch instance ranges that match. Runs
  // (`firstInstance` + `instanceCount`) are derived in setSelection /
  // setScene by walking each batch's entities and grouping consecutive
  // matching instance indices, so the mask pass uses one drawIndexed
  // per run rather than one per matched instance.
  interface SelectedRun {
    batchIndex: number;
    firstInstance: number;
    instanceCount: number;
  }
  interface OutlineResources {
    width: number;
    height: number;
    mask: GPUTexture;
    sceneBuffer: GPUBuffer;       // mat4 modelView + mat4 projection
    sceneBindGroup: GPUBindGroup;
    uniformBuffer: GPUBuffer;     // texelSize + outline colour
    compositeBindGroup: GPUBindGroup;
  }
  let selection: SceneSelection | null = null;
  let selectedRuns: SelectedRun[] = [];
  let outlineResources: OutlineResources | null = null;

  function rebuildSelectedRuns(): void {
    selectedRuns = [];
    if (!selection) return;
    for (let bi = 0; bi < batches.length; bi++) {
      const b = batches[bi]!;
      let runStart = -1;
      let runLen = 0;
      for (let i = 0; i < b.entities.length; i++) {
        const prov = b.entities[i]!.provenance;
        let match = false;
        if (prov) {
          if (selection.kind === 'placement') {
            const last = prov.placements[prov.placements.length - 1];
            match = !!last
              && last.distributeNodeId === selection.distributeNodeId
              && last.pointIndex === selection.pointIndex;
          } else {
            match = prov.originNodeId === selection.originNodeId;
          }
        }
        if (match) {
          if (runStart === -1) { runStart = i; runLen = 1; }
          else runLen++;
        } else if (runStart !== -1) {
          selectedRuns.push({ batchIndex: bi, firstInstance: runStart, instanceCount: runLen });
          runStart = -1; runLen = 0;
        }
      }
      if (runStart !== -1) {
        selectedRuns.push({ batchIndex: bi, firstInstance: runStart, instanceCount: runLen });
      }
    }
  }

  function ensureOutlineResources(width: number, height: number): OutlineResources {
    if (outlineResources && outlineResources.width === width && outlineResources.height === height) {
      return outlineResources;
    }
    outlineResources?.mask.destroy();
    outlineResources?.sceneBuffer.destroy();
    outlineResources?.uniformBuffer.destroy();
    const mask = device.createTexture({
      label: 'outline mask',
      size: [width, height],
      format: 'r8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const sceneBuffer = device.createBuffer({
      label: 'outline scene uniform',
      size: 128, // mat4 modelView + mat4 projection
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const sceneBindGroup = device.createBindGroup({
      layout: shared.outlineMaskLayout,
      entries: [{ binding: 0, resource: sceneBuffer }],
    });
    const uniformBuffer = device.createBuffer({
      label: 'outline composite uniform',
      // texelSize (vec2) + _pad (vec2) + colour (vec4) = 32 bytes
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const compositeBindGroup = device.createBindGroup({
      layout: shared.outlineCompositeLayout,
      entries: [
        { binding: 0, resource: mask.createView() },
        { binding: 1, resource: shared.sampler },
        { binding: 2, resource: uniformBuffer },
      ],
    });
    outlineResources = { width, height, mask, sceneBuffer, sceneBindGroup, uniformBuffer, compositeBindGroup };
    return outlineResources;
  }

  function setSelection(sel: SceneSelection | null): void {
    selection = sel;
    rebuildSelectedRuns();
  }

  // Local-space AABB of a geometry, cached per GeometryValue. CPU meshes
  // are large enough (tens of thousands of verts) that we don't want to
  // re-scan them every Frame call; the WeakMap keys on the geometry
  // wrapper so it auto-evicts when the geometry's GC'd.
  const localAabbCache = new WeakMap<GeometryValue, { min: [number, number, number]; max: [number, number, number] } | null>();
  function geometryLocalAabb(g: GeometryValue): { min: [number, number, number]; max: [number, number, number] } | null {
    const cached = localAabbCache.get(g);
    if (cached !== undefined) return cached;
    const mesh = g.mesh;
    if (!mesh || mesh.positions.length === 0) {
      localAabbCache.set(g, null);
      return null;
    }
    const pos = mesh.positions;
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i]!, y = pos[i + 1]!, z = pos[i + 2]!;
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    const aabb = { min: [mnx, mny, mnz] as [number, number, number], max: [mxx, mxy, mxz] as [number, number, number] };
    localAabbCache.set(g, aabb);
    return aabb;
  }

  function entityMatchesSelection(prov: SceneEntity['provenance'], sel: SceneSelection): boolean {
    if (!prov) return false;
    if (sel.kind === 'placement') {
      const last = prov.placements[prov.placements.length - 1];
      return !!last
        && last.distributeNodeId === sel.distributeNodeId
        && last.pointIndex === sel.pointIndex;
    }
    return prov.originNodeId === sel.originNodeId;
  }

  function getSelectionBounds(sel: SceneSelection): { center: [number, number, number]; radius: number } | null {
    let any = false;
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (const b of batches) {
      const local = geometryLocalAabb(b.geometry);
      if (!local) continue;
      for (const e of b.entities) {
        if (!entityMatchesSelection(e.provenance, sel)) continue;
        const t = e.transform;
        // Transform all 8 local-AABB corners — needed because the
        // entity's transform might rotate/scale, so the world-space
        // AABB isn't simply (transformed min) → (transformed max).
        for (let c = 0; c < 8; c++) {
          const lx = (c & 1) ? local.max[0] : local.min[0];
          const ly = (c & 2) ? local.max[1] : local.min[1];
          const lz = (c & 4) ? local.max[2] : local.min[2];
          const wx = t[0]! * lx + t[4]! * ly + t[8]!  * lz + t[12]!;
          const wy = t[1]! * lx + t[5]! * ly + t[9]!  * lz + t[13]!;
          const wz = t[2]! * lx + t[6]! * ly + t[10]! * lz + t[14]!;
          if (wx < mnx) mnx = wx; if (wx > mxx) mxx = wx;
          if (wy < mny) mny = wy; if (wy > mxy) mxy = wy;
          if (wz < mnz) mnz = wz; if (wz > mxz) mxz = wz;
          any = true;
        }
      }
    }
    if (!any) return null;
    const cx = (mnx + mxx) * 0.5;
    const cy = (mny + mxy) * 0.5;
    const cz = (mnz + mxz) * 0.5;
    const dx = (mxx - mnx) * 0.5;
    const dy = (mxy - mny) * 0.5;
    const dz = (mxz - mnz) * 0.5;
    return { center: [cx, cy, cz], radius: Math.sqrt(dx * dx + dy * dy + dz * dz) };
  }

  function ensurePickResources(batchCount: number): PickResources {
    if (!pickResources) {
      const sceneBuffer = device.createBuffer({
        label: 'pick scene uniform',
        size: 128, // mat4 modelView + mat4 pickProjection
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const sceneBindGroup = device.createBindGroup({
        layout: shared.pickSceneLayout,
        entries: [{ binding: 0, resource: sceneBuffer }],
      });
      const colorTex = device.createTexture({
        label: 'pick id (1x1 r32uint)',
        size: [1, 1],
        format: 'r32uint',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      const depthTex = device.createTexture({
        label: 'pick depth (1x1)',
        size: [1, 1],
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const readback = device.createBuffer({
        label: 'pick readback',
        size: 256, // copyTextureToBuffer rows are 256-aligned
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const cap = Math.max(16, batchCount);
      const batchBuffer = device.createBuffer({
        label: 'pick batch uniforms',
        size: cap * shared.pickBatchStride,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const batchBindGroup = device.createBindGroup({
        layout: shared.pickBatchLayout,
        entries: [
          { binding: 0, resource: { buffer: batchBuffer, size: 16 } },
        ],
      });
      pickResources = {
        colorTex, depthTex, readback,
        sceneBuffer, sceneBindGroup,
        batchBuffer, batchBindGroup, batchCapacity: cap,
      };
      return pickResources;
    }
    // Already built — grow the per-batch buffer if more batches now fit.
    if (batchCount > pickResources.batchCapacity) {
      pickResources.batchBuffer.destroy();
      const cap = Math.max(pickResources.batchCapacity * 2, batchCount);
      pickResources.batchBuffer = device.createBuffer({
        label: 'pick batch uniforms',
        size: cap * shared.pickBatchStride,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      pickResources.batchBindGroup = device.createBindGroup({
        layout: shared.pickBatchLayout,
        entries: [{ binding: 0, resource: { buffer: pickResources.batchBuffer, size: 16 } }],
      });
      pickResources.batchCapacity = cap;
    }
    return pickResources;
  }

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
            // pickBaseId is assigned below once the full batch list is
            // built — we want one flat id space across batches.
            pickBaseId: 0,
            entities,
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
    // Grass fields are render-time recipes, not batched entities — just
    // hold the list; the per-frame compute/draw in render() consumes it.
    grassFields = scene.grass ?? [];
    // Terrain fields likewise. We also pre-warm the material cache for
    // each field's material so the per-frame draw can just look up the
    // bind group; building it on a frame would do the texture-2d-array
    // assembly (16 render-pass blits) every frame, which would be
    // catastrophic.
    terrainFields = scene.terrain ?? [];
    for (const f of terrainFields) {
      const kindId: MaterialValue['kind'] = f.material.kind;
      const kind = shared.kinds.get(kindId);
      if (!kind) throw new Error(`terrain field references unknown material kind: ${kindId}`);
      const structuralKey = (kind.materialStructuralKey as (m: MaterialValue) => string)(f.material);
      const cacheKey = `${kindId}:${structuralKey}`;
      usedMaterialKeys.add(cacheKey);
      acquireMaterial(cacheKey, () => {
        const built = (
          kind.buildBindGroup as (m: MaterialValue) => { bindGroup: GPUBindGroup; paramBuffer: GPUBuffer }
        )(f.material);
        return { bindGroup: built.bindGroup, paramBuffer: built.paramBuffer };
      });
      (kind.writeMaterialParams as (m: MaterialValue, b: GPUBuffer) => void)(
        f.material,
        materialCacheGlobal.get(cacheKey)!.value.paramBuffer,
      );
    }

    // ----------------------------------------------------------------
    // GPU-picking bookkeeping: assign a contiguous id range to each
    // batch and populate the lookup table. Id 0 = miss (clear value),
    // so the first real instance gets id 1.
    // ----------------------------------------------------------------
    let nextPickId = 1;
    let totalInstances = 0;
    for (const b of batches) totalInstances += b.instanceCount;
    pickTable = new Array(1 + totalInstances);
    for (const b of batches) {
      b.pickBaseId = nextPickId;
      for (let i = 0; i < b.entities.length; i++) {
        const e = b.entities[i]!;
        pickTable[nextPickId + i] = { provenance: e.provenance, transform: e.transform };
      }
      nextPickId += b.instanceCount;
    }
    // (pickResources are lazily allocated on first pickAt — see
    // ensurePickResources. setScene only refreshes the JS-side
    // pickTable above; nothing GPU here.)

    // Selection-outline: the per-entity matching depends on the new
    // batch layout, so re-derive the run list against the new batches.
    // Stays a no-op when nothing's selected.
    rebuildSelectedRuns();
    debug(() => {
      const summary = batches.map((b) =>
        `[${b.kindId} pos#${gpuObjectId(b.geometry.positionBuffer as object)} idx=${b.geometry.indexCount} inst=${b.instanceCount}]`,
      ).join(' ');
      return `[SceneRenderer setScene] batches=${batches.length} grass=${grassFields.length} ${summary}`;
    });
  }

  function destroy(): void {
    // Release every ref this renderer is currently holding. Pool
    // entries that hit zero refs are physically destroyed; entries
    // still held by other renderers stay alive.
    for (const k of currentMaterialKeys) releaseMaterial(k);
    for (const k of currentInstanceKeys) releaseInstanceBuffer(k);
    if (currentSizeKey !== null) releaseIntermediates(currentSizeKey);
    grassSystem?.destroy();
    if (pickResources) {
      pickResources.colorTex.destroy();
      pickResources.depthTex.destroy();
      pickResources.readback.destroy();
      pickResources.sceneBuffer.destroy();
      pickResources.batchBuffer.destroy();
      pickResources = null;
    }
    if (outlineResources) {
      outlineResources.mask.destroy();
      outlineResources.sceneBuffer.destroy();
      outlineResources.uniformBuffer.destroy();
      outlineResources = null;
    }
    pickTable = [];
    selection = null;
    selectedRuns = [];
    currentMaterialKeys = new Set();
    currentInstanceKeys = new Set();
    currentSizeKey = null;
    batches = [];
  }

  // Track an in-flight pick: WebGPU's mapAsync errors hard if the
  // buffer is already mapped, and we don't want to start a second
  // pick before the first's readback finishes. Resolves to 0 (miss)
  // for the concurrent caller — frame-on-double-click is rare enough
  // that "drop the second click" is a fine UX trade.
  let pickInFlight: Promise<number> | null = null;

  async function pickAt(params: {
    x: number; y: number;
    viewportWidth: number; viewportHeight: number;
    modelView: Mat4;
    fovYRadians: number; aspect: number; zNear: number; zFar: number;
  }): Promise<number> {
    if (pickInFlight) return pickInFlight;
    if (batches.length === 0) return 0;
    const pr = ensurePickResources(batches.length);

    const proj = buildPickProjection(
      params.fovYRadians, params.aspect, params.zNear, params.zFar,
      params.x, params.y, params.viewportWidth, params.viewportHeight,
    );
    // Write modelView + pickProjection into the scene uniform.
    const sceneScratch = new Float32Array(32);
    sceneScratch.set(params.modelView, 0);
    sceneScratch.set(proj, 16);
    device.queue.writeBuffer(pr.sceneBuffer, 0, sceneScratch as BufferSource);

    // Pack every batch's baseId into the dynamic-offset uniform. Only
    // the first 16 bytes of each `pickBatchStride`-byte slot carry
    // payload (the rest is alignment padding).
    const batchScratch = new ArrayBuffer(batches.length * shared.pickBatchStride);
    const batchU32 = new Uint32Array(batchScratch);
    const slotU32Stride = shared.pickBatchStride / 4;
    for (let i = 0; i < batches.length; i++) {
      batchU32[i * slotU32Stride] = batches[i]!.pickBaseId;
    }
    device.queue.writeBuffer(pr.batchBuffer, 0, batchScratch);

    const encoder = device.createCommandEncoder({ label: 'pick' });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: pr.colorTex.createView(),
          // clearValue exposes 0 as "miss" — sky / nothing under the
          // pixel resolves to id 0 → null PickTableEntry.
          clearValue: [0, 0, 0, 0],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: pr.depthTex.createView(),
        depthClearValue: 0, // reverse-Z
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    pass.setPipeline(shared.pickPipeline);
    pass.setBindGroup(0, pr.sceneBindGroup);
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i]!;
      if (b.geometry.indexCount === 0) continue;
      pass.setBindGroup(1, pr.batchBindGroup, [i * shared.pickBatchStride]);
      pass.setVertexBuffer(0, b.geometry.positionBuffer);
      pass.setVertexBuffer(1, b.geometry.normalBuffer);
      pass.setVertexBuffer(2, b.geometry.uvBuffer);
      pass.setVertexBuffer(3, b.instanceBuffer);
      pass.setIndexBuffer(b.geometry.indexBuffer, b.geometry.indexFormat);
      pass.drawIndexed(b.geometry.indexCount, b.instanceCount);
    }
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: pr.colorTex },
      { buffer: pr.readback, bytesPerRow: 256 },
      [1, 1, 1],
    );
    device.queue.submit([encoder.finish()]);

    pickInFlight = (async () => {
      try {
        await pr.readback.mapAsync(GPUMapMode.READ);
        const id = new Uint32Array(pr.readback.getMappedRange())[0] ?? 0;
        pr.readback.unmap();
        return id;
      } finally {
        pickInFlight = null;
      }
    })();
    return pickInFlight;
  }

  function getPickInfo(id: number): { provenance: SceneEntity['provenance']; transform: Float32Array } | null {
    if (id === 0) return null;
    return pickTable[id] ?? null;
  }

  return {
    setScene,
    destroy,
    pickAt,
    getPickInfo,
    setSelection,
    getSelectionBounds,
    render({ encoder, colorView, size, modelView, projection, cameraTarget, lighting, flatPreview = false, time = 0 }) {
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
      // (No separate ambient day-factor anymore: skyColor/groundColor are
      // already linear HDR sampled from the atmosphere model, which
      // returns ~0 once the sun is below the horizon — they fade with the
      // sun naturally.)

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
      // skyColor (linear HDR, already derived from atmosphere — zeros at
      // night naturally) packed in xyz, ambientIntensity in w.
      lightingScratch[8]  = lighting.skyColor[0];
      lightingScratch[9]  = lighting.skyColor[1];
      lightingScratch[10] = lighting.skyColor[2];
      lightingScratch[11] = lighting.ambientIntensity;
      lightingScratch[12] = lighting.groundColor[0];
      lightingScratch[13] = lighting.groundColor[1];
      lightingScratch[14] = lighting.groundColor[2];
      lightingScratch[16] = lighting.fogColor[0] * dayFactor;
      lightingScratch[17] = lighting.fogColor[1] * dayFactor;
      lightingScratch[18] = lighting.fogColor[2] * dayFactor;
      lightingScratch[19] = lighting.fogDensity;
      device.queue.writeBuffer(sceneUniformBuffer, 192, lightingScratch as BufferSource);

      // `time` (seconds). Drives water ripples (and any future
      // animation that wants a clock). Stored at the trailing slot
      // of the scene uniform buffer; shaders that don't need it
      // simply omit the field from their `Uniforms` struct.
      const timeScratch = new Float32Array(1);
      timeScratch[0] = time;
      device.queue.writeBuffer(sceneUniformBuffer, 272, timeScratch as BufferSource);

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

      // Grass cull/populate compute — must run before the color pass
      // (which reads the instance buffer it fills) and outside any
      // render pass. Skipped in flat-preview (asset texture tiles have
      // no terrain to plant on). No-op when the scene has no grass.
      if (!flatPreview && grassFields.length > 0) {
        ensureGrass().compute(encoder, grassFields, { modelView, projection, time });
      }
      // Terrain LOD-selection compute — also before the color pass.
      // Picks an LOD per chunk from camera distance and populates the
      // per-LOD chunk-instance buffer + drawArgs that the draw pass
      // below consumes. Material bind groups are resolved from the
      // pre-warmed cache populated in setScene.
      if (!flatPreview && terrainFields.length > 0) {
        const sys = ensureTerrain();
        sys.compute(
          encoder,
          terrainFields,
          { modelView, projection },
          sceneBindGroup,
          (material) => {
            const kindId = material.kind;
            const kind = shared.kinds.get(kindId)!;
            const structuralKey = (kind.materialStructuralKey as (m: MaterialValue) => string)(material);
            const entry = materialCacheGlobal.get(`${kindId}:${structuralKey}`);
            if (!entry) throw new Error('terrain material bind group missing from cache');
            return entry.value.bindGroup;
          },
        );
      }

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

      // Grass: drawIndexedIndirect the blades the compute pass placed,
      // after opaque geometry so they depth-test against the terrain.
      // Scene bind group (group 0) is already set above. Reverse-Z
      // depth-writing pipeline, so grass self-occludes correctly.
      if (!flatPreview && grassFields.length > 0) {
        ensureGrass().draw(pass, grassFields);
      }
      // Terrain draw: indirect-draw per LOD bucket, reading from the
      // chunk-instance + drawArgs buffers the compute pass populated.
      // Material bind group resolved from the same cache as the
      // compute side so structural-key sharing works across the two
      // calls.
      if (!flatPreview && terrainFields.length > 0) {
        ensureTerrain().draw(pass, terrainFields, (material) => {
          const kindId = material.kind;
          const kind = shared.kinds.get(kindId)!;
          const structuralKey = (kind.materialStructuralKey as (m: MaterialValue) => string)(material);
          return materialCacheGlobal.get(`${kindId}:${structuralKey}`)!.value.bindGroup;
        });
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

      // ---- Selection outline (P4) ----
      // Two passes only when something is actually selected; otherwise
      // we don't even allocate the mask texture. (Asset thumbnails and
      // grass-less previews never pay the outline cost.)
      if (selectedRuns.length > 0) {
        const ol = ensureOutlineResources(width, height);
        // Mask pass shares the scene's modelView × projection — no
        // off-centre frustum or anything. NB: the scene depth attachment
        // was written with `depthStoreOp: 'store'` just above; the mask
        // pipeline samples it with `greater-equal` so only the visible
        // silhouette of each selected instance contributes.
        const oScene = new Float32Array(32);
        oScene.set(modelView, 0);
        oScene.set(projection, 16);
        device.queue.writeBuffer(ol.sceneBuffer, 0, oScene as BufferSource);
        // Outline-composite uniform: 1/(w,h) + colour. Hard-coded warm
        // orange — pops against the abyss-themed UI / sky.
        const oU = new Float32Array(8);
        oU[0] = 1 / width; oU[1] = 1 / height;
        oU[2] = 0; oU[3] = 0; // pad
        oU[4] = 1.0; oU[5] = 0.65; oU[6] = 0.15; oU[7] = 1.0;
        device.queue.writeBuffer(ol.uniformBuffer, 0, oU as BufferSource);

        const maskPass = encoder.beginRenderPass({
          colorAttachments: [{
            view: ol.mask, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store',
          }],
          // Depth attached but read-only-never-fails — see the
          // outlineMaskPipeline comment for why we don't try silhouette
          // testing via greater-equal.
          depthStencilAttachment: {
            view: depthTexture!,
            depthLoadOp: 'load',
            depthStoreOp: 'discard',
          },
        });
        maskPass.setPipeline(shared.outlineMaskPipeline);
        maskPass.setBindGroup(0, ol.sceneBindGroup);
        // Bind vertex buffers once per batch (geometry differs by batch),
        // then iterate the runs in order and dispatch each as an
        // instance range starting at `firstInstance`.
        let currentBatchIdx = -1;
        for (const run of selectedRuns) {
          if (run.batchIndex !== currentBatchIdx) {
            const b = batches[run.batchIndex]!;
            if (b.geometry.indexCount === 0) continue;
            maskPass.setVertexBuffer(0, b.geometry.positionBuffer);
            maskPass.setVertexBuffer(1, b.geometry.normalBuffer);
            maskPass.setVertexBuffer(2, b.geometry.uvBuffer);
            maskPass.setVertexBuffer(3, b.instanceBuffer);
            maskPass.setIndexBuffer(b.geometry.indexBuffer, b.geometry.indexFormat);
            currentBatchIdx = run.batchIndex;
          }
          const b = batches[run.batchIndex]!;
          maskPass.drawIndexed(b.geometry.indexCount, run.instanceCount, 0, 0, run.firstInstance);
        }
        maskPass.end();

        // Overlay outline on the already-tonemapped swapchain. loadOp
        // 'load' preserves whatever composite wrote; src-over blend on
        // the pipeline draws the outline ring on top.
        const outlinePass = encoder.beginRenderPass({
          colorAttachments: [
            { view: colorView, loadOp: 'load', storeOp: 'store' },
          ],
        });
        outlinePass.setPipeline(shared.outlineCompositePipeline);
        outlinePass.setBindGroup(0, ol.compositeBindGroup);
        outlinePass.draw(3);
        outlinePass.end();
      }
    },
  };
}
