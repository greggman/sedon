import type { MaterialValue, Texture2DValue } from '../core/resources.js';
import { getSampler } from './gpu-cache.js';

// Per-material-kind extension point. A kind owns its shader, its pipeline,
// and the function that builds a @group(1) bind group for one of its
// materials. The renderer dispatches per kind: it sets the shared @group(0)
// scene bind group once, then for each batch it switches pipeline + sets
// the kind-specific @group(1).
//
// All kinds share:
//   - The vertex layout (position, normal, uv, instance matrix, instance tint)
//   - The scene bind group at @group(0)
//   - The depth attachment (reverse-Z)
//
// To add a new kind:
//   1. Add a new variant to MaterialValue in core/resources.ts.
//   2. Write its shader (own bind-group layout for @group(1)).
//   3. Implement a factory like createPbrKind that returns a
//      MaterialKindImpl.
//   4. Register it in scene.ts's `kinds` map.
//   5. Author a node that produces the value.
export interface MaterialKindImpl<M extends MaterialValue = MaterialValue> {
  /** Discriminator — must match `MaterialValue.kind` for materials of this kind. */
  readonly id: M['kind'];
  /** The pipeline state object for this kind. Created once per scene-renderer. */
  readonly pipeline: GPURenderPipeline;
  /**
   * Optional alpha-blended variant of the same pipeline. Used by the
   * flat-preview path so a texture with an alpha channel composites
   * over the checkerboard backdrop rather than punching through it as
   * opaque. Same shader, same bind groups — only the target's blend
   * state differs.
   *
   * When undefined, the renderer falls back to the opaque pipeline
   * even in flat-preview (kinds that don't need alpha don't need to
   * pay for a second pipeline).
   */
  readonly pipelineBlended?: GPURenderPipeline;
  /**
   * Optional alpha-cutout variant. Two-sided, no blend — the shader's
   * `discard` handles transparency. Selected by `pickPipeline` for
   * materials with `alphaCutoff > 0` (leaf cards, fronds, decals).
   */
  readonly pipelineCutout?: GPURenderPipeline;
  /**
   * Optional per-material pipeline selection (cutout vs opaque). When
   * absent, the renderer uses `pipeline` directly. The flat-preview
   * blended override is applied by the renderer separately and is not
   * the responsibility of this hook.
   */
  pickPipeline?(material: M): GPURenderPipeline;
  /**
   * Structural fingerprint of a material — everything that determines
   * the BIND GROUP's content (texture identities, kind discriminators).
   * Two materials with the same structural key can share a bind group;
   * only their scalar uniform values may differ, and those get written
   * unconditionally via `writeMaterialParams` into the shared
   * `paramBuffer`. Lets the renderer's per-setScene material cache
   * reuse bind groups across eval rounds — the slider-scrub case
   * (same textures, different roughness) becomes one writeBuffer with
   * no createBuffer / createBindGroup churn.
   */
  materialStructuralKey(material: M): string;
  /**
   * Write the per-material scalar uniform data into `paramBuffer`. Used
   * both on the cache-hit path (rewriting scalars over a reused buffer)
   * and from buildBindGroup's freshly-allocated buffer. Must match the
   * layout the kind's shader expects.
   */
  writeMaterialParams(material: M, paramBuffer: GPUBuffer): void;
  /**
   * Build a @group(1) bind group for one material instance. Called on
   * cache misses inside the renderer's `setScene`. Returns the bind
   * group + the writable scalar uniform buffer the renderer caches as
   * `paramBuffer` (and writes new scalars into on slider scrubs).
   */
  buildBindGroup(material: M): { bindGroup: GPUBindGroup; paramBuffer: GPUBuffer };
}

/**
 * Standard pre-multiplied-alpha blend state — `srcAlpha` × src + (1 −
 * srcAlpha) × dst for color, and `1 × src + (1 − srcAlpha) × dst` for
 * alpha so a fully-opaque drawing leaves the dst alpha at 1 and a
 * fully-transparent drawing preserves the dst alpha untouched. Used by
 * kinds that want an alpha-blended variant of their opaque pipeline.
 */
export const ALPHA_BLEND_STATE: GPUBlendState = {
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
};

// Explicitly created scene bind-group layout — shared across every kind's
// pipeline. With this declared, all kind pipelines have the same @group(0)
// layout, so a single sceneBindGroup can be set once per pass.
//
// Bindings:
//   0: scene uniforms (modelView, projection, lightViewProj, lighting, fog)
//   1: shared color sampler (linear, repeat)
//   2: shadow map (depth texture filled by the shadow pass)
//   3: shadow comparison sampler (linear filter → free 2×2 PCF)
export function createSceneBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: {},
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'depth' },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'comparison' },
      },
    ],
  });
}

// Both samplers route through the gpu-cache so repeated SceneRenderer
// rebuilds (one per scene change — e.g. every material edit) reuse the
// same GPUSampler. createSampler is cheap but it's also the most
// visible "WebGPU work" the user sees when watching for allocations
// during edit-time scrubbing, and there's no reason these vary at all.
export function createSharedSampler(device: GPUDevice): GPUSampler {
  return getSampler(device, {
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });
}

// Comparison sampler for the shadow map. Linear filtering combined with a
// compare op gives free 2×2 PCF: textureSampleCompare returns the bilinear
// mix of the four comparison results, which softens shadow edges without
// any manual taps. 'greater-equal' is paired with our reverse-Z depth
// (stored = closest to light = highest value): ref ≥ stored → not
// occluded → 1. clamp-to-edge so fragments outside the shadow extent
// don't wrap to garbage.
export function createShadowSampler(device: GPUDevice): GPUSampler {
  return getSampler(device, {
    compare: 'greater-equal',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
}

// Vertex buffer layout shared by every material kind. Position/normal/uv
// are per-vertex; the 4-vec4 instance matrix and vec4 instance tint are
// per-instance, totaling 80 bytes per instance.
export function instanceVertexBuffers(): GPUVertexBufferLayout[] {
  return [
    {
      arrayStride: 12,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
    },
    {
      arrayStride: 12,
      attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }],
    },
    {
      arrayStride: 8,
      attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }],
    },
    {
      arrayStride: 80,
      stepMode: 'instance',
      attributes: [
        { shaderLocation: 3, offset: 0,  format: 'float32x4' },
        { shaderLocation: 4, offset: 16, format: 'float32x4' },
        { shaderLocation: 5, offset: 32, format: 'float32x4' },
        { shaderLocation: 6, offset: 48, format: 'float32x4' },
        { shaderLocation: 7, offset: 64, format: 'float32x4' },
      ],
    },
  ];
}

// Per-device singletons for the 1×1 placeholder textures. They never
// vary — the pixel data is hard-coded — so reusing the same GPUTexture
// across every SceneRenderer rebuild costs nothing and avoids the
// stream of 1×1 createTexture calls visible while debugging edits.
const flatNormalCache = new WeakMap<GPUDevice, Texture2DValue>();
const flatHalfCache = new WeakMap<GPUDevice, Texture2DValue>();
const flatBlackCache = new WeakMap<GPUDevice, Texture2DValue>();

// Tangent-space "no perturbation": (0, 0, 1) → (0.5, 0.5, 1.0) when packed
// into rgba8unorm. PBR materials with no normal map use this so the bind
// group layout stays uniform.
export function createFlatNormalTexture(device: GPUDevice): Texture2DValue {
  const cached = flatNormalCache.get(device);
  if (cached) return cached;
  const format: GPUTextureFormat = 'rgba8unorm';
  const texture = device.createTexture({
    size: [1, 1],
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const pixel = new Uint8Array([128, 128, 255, 255]);
  device.queue.writeTexture(
    { texture },
    pixel as BufferSource,
    { bytesPerRow: 4 },
    [1, 1],
  );
  const result: Texture2DValue = {
    texture,
    format,
    width: 1,
    height: 1,
    revision: 0, // static cached fallback — content never changes
  };
  flatNormalCache.set(device, result);
  return result;
}

// 1×1 mid-grey (R=0.5). Used as the no-op placeholder for detail-basecolor:
// the shader does `1 + (sample - 0.5) * 2 * strength`, so sample=0.5 leaves
// albedo untouched regardless of strength.
export function createFlatHalfTexture(device: GPUDevice): Texture2DValue {
  const cached = flatHalfCache.get(device);
  if (cached) return cached;
  const format: GPUTextureFormat = 'rgba8unorm';
  const texture = device.createTexture({
    size: [1, 1],
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const pixel = new Uint8Array([128, 128, 128, 255]);
  device.queue.writeTexture(
    { texture },
    pixel as BufferSource,
    { bytesPerRow: 4 },
    [1, 1],
  );
  const result: Texture2DValue = {
    texture,
    format,
    width: 1,
    height: 1,
    revision: 0, // static cached fallback — content never changes
  };
  flatHalfCache.set(device, result);
  return result;
}

// 1×1 black. Used as the no-op placeholder for the emissive slot:
// the shader adds `emissive_sample * intensity` to the lit color, so
// (0,0,0) × anything = 0 contribution regardless of intensity.
export function createFlatBlackTexture(device: GPUDevice): Texture2DValue {
  const cached = flatBlackCache.get(device);
  if (cached) return cached;
  const format: GPUTextureFormat = 'rgba8unorm';
  const texture = device.createTexture({
    size: [1, 1],
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const pixel = new Uint8Array([0, 0, 0, 255]);
  device.queue.writeTexture(
    { texture },
    pixel as BufferSource,
    { bytesPerRow: 4 },
    [1, 1],
  );
  const result: Texture2DValue = {
    texture,
    format,
    width: 1,
    height: 1,
    revision: 0,
  };
  flatBlackCache.set(device, result);
  return result;
}

// Common depth-stencil config — reverse-Z float depth, 'greater' compare.
export const DEPTH_STENCIL: GPUDepthStencilState = {
  format: 'depth32float',
  depthCompare: 'greater',
  depthWriteEnabled: true,
};
