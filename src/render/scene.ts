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
  render(params: {
    encoder: GPUCommandEncoder;
    /** Final swapchain view — the composite pass writes here. */
    colorView: GPUTextureView;
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
}

interface Batch {
  kindId: MaterialValue['kind'];
  geometry: GeometryValue;
  materialBindGroup: GPUBindGroup;
  /**
   * Pipeline chosen for this batch by the kind's `pickPipeline` (or its
   * default `pipeline` when the kind doesn't implement the picker).
   * Captured at batch-build time so the render loop never re-decides.
   * `null` means "use kind.pipeline / kind.pipelineBlended depending on
   * flatPreview" — preserves prior behavior for kinds that don't
   * differentiate per material.
   */
  pipeline: GPURenderPipeline | null;
  instanceBuffer: GPUBuffer;
  instanceCount: number;
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

export function createSceneRenderer(
  device: GPUDevice,
  format: GPUTextureFormat,
  scene: SceneValue,
): SceneRenderer {
  // Shared resources used by every material kind.
  const sceneBindGroupLayout = createSceneBindGroupLayout(device);
  const sampler = createSharedSampler(device);
  const shadowSampler = createShadowSampler(device);

  // Shadow map texture — depth-only, written by the shadow pass, sampled
  // by every kind's color shader.
  const shadowTexture = device.createTexture({
    size: [SHADOW_MAP_SIZE, SHADOW_MAP_SIZE],
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const shadowView = shadowTexture.createView();

  // 256 bytes: three mat4x4f (modelView, projection, lightViewProj) +
  // three vec3-with-padding lighting blocks (lightDirWorld, lightColor,
  // ambient) + one vec4 fog. lightViewProj is shared with the shadow
  // pass; rather than reading the same matrix from two buffers we keep
  // separate copies (64 bytes duplicated, negligible).
  const sceneUniformBuffer = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const lightingScratch = new Float32Array(16);

  // Single scene bind group, set once per pass — shared across every kind's
  // pipeline because the scene bind-group layout is shared.
  const sceneBindGroup = device.createBindGroup({
    layout: sceneBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: sceneUniformBuffer } },
      { binding: 1, resource: sampler },
      { binding: 2, resource: shadowView },
      { binding: 3, resource: shadowSampler },
    ],
  });

  // Shadow pass owns its own pipeline + bind group + small uniform buffer.
  // The shadow vertex shader only needs lightViewProj; sharing the 256-byte
  // scene buffer here would force the shadow shader to declare padding for
  // bytes 0..127, which is uglier than just duplicating one mat4.
  const shadowBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' },
      },
    ],
  });
  const shadowUniformBuffer = device.createBuffer({
    size: 64, // single mat4x4f
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const shadowBindGroup = device.createBindGroup({
    layout: shadowBindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: shadowUniformBuffer } }],
  });
  const shadowPipeline = createShadowPipeline(device, shadowBindGroupLayout);

  // Material-kind registry. Each kind owns its shader, pipeline, and a
  // function that builds a @group(1) bind group from its material variant.
  // Kinds target the HDR scene texture, NOT the swapchain — the composite
  // pass downstream is where pixels finally land in the swapchain.
  const kinds = new Map<MaterialValue['kind'], MaterialKindImpl>([
    ['pbr', createPbrKind(device, HDR_FORMAT, sceneBindGroupLayout)],
    ['terrain-splat', createTerrainSplatKind(device, HDR_FORMAT, sceneBindGroupLayout)],
  ]);

  // Sky stays its own private pipeline — it isn't a material kind, it's a
  // pre-pass step before scene geometry. Also targets HDR now.
  //
  // Sky uniform layout (80 bytes, 5 × vec4f):
  //   cameraRight.xyz | tan(fov_y/2)
  //   cameraUp.xyz    | aspect (w/h)
  //   cameraForward   | sun_intensity (HDR scalar)
  //   sunDir.xyz      | (pad)
  //   fogColor.xyz    | (pad)
  // Camera basis is the rows of the modelView rotation block, derived
  // each frame so the atmosphere reacts to user rotation. Sun direction
  // and intensity are duplicated from lighting because the sky has its
  // own bind group; the cost is 80 bytes and one extra writeBuffer.
  // fogColor is also duplicated so the sky can blend toward it near
  // the horizon — matches the PBR shader's fog so scene + sky meet at
  // a consistent color at distance.
  const skyPipeline = createSkyPipeline(device, HDR_FORMAT);
  const flatBackgroundPipeline = createFlatBackgroundPipeline(device, HDR_FORMAT);
  const skyUniformBuffer = device.createBuffer({
    size: 80,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const skyBindGroup = device.createBindGroup({
    layout: skyPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: skyUniformBuffer } }],
  });
  const skyScratch = new Float32Array(20);

  // Sun intensity (linear HDR) — controls both the disc brightness and
  // the overall scattering brightness. ~22 makes daytime sky and lit
  // surfaces roughly match what users author for sRGB display, while
  // keeping the sun disc bright enough to bloom strongly.
  const SUN_INTENSITY = 22;

  // Post-process: bright-pass + bloom pyramid + composite. Bright-pass,
  // downsample, and upsample share the same "single input texture +
  // sampler + uniform" bind-group layout. Composite has its own
  // (two-input) layout. Only the upsample pipeline uses additive blend.
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

  // Bloom samples with clamp-to-edge so the kernel doesn't smear in
  // pixels from the opposite edge of the texture.
  const postSampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  // Bloom uniforms are written per-frame from lighting now (threshold +
  // soft knee for bright-pass, intensity for composite). 16-byte
  // padding because that's the minimum UBO size in WebGPU.
  const brightPassUniform = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const compositeUniform = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bloomScratch = new Float32Array(4);

  // Per-frame intermediates, (re)allocated when size changes:
  //   depthTexture  — main pass depth attachment
  //   hdrColor      — scene HDR target (sampled by bright-pass + composite)
  //   bloomMips[i]  — bloom pyramid level i (0 = half res, 5 = 1/64)
  //   bloomMipParamBuffers[i] — uniform with src_texel for that level
  let depthTexture: GPUTexture | null = null;
  let hdrColor: GPUTexture | null = null;
  let hdrColorView: GPUTextureView | null = null;
  let bloomMips: GPUTexture[] = [];
  let bloomMipViews: GPUTextureView[] = [];
  // Each mip i needs a (1/w, 1/h) uniform used by both downsample (when
  // it's the SOURCE) and upsample (when it's the SOURCE again). One
  // buffer per mip is enough.
  let bloomMipParamBuffers: GPUBuffer[] = [];
  // Bright-pass reads hdrColor → mip[0]. Downsample reads mip[i] → mip[i+1].
  // Upsample reads mip[i+1] → mip[i] additively. One bind group per
  // (source mip + uniform) pair.
  let brightPassBindGroup: GPUBindGroup | null = null;
  let pyramidBindGroups: GPUBindGroup[] = []; // index i: source = mip[i]
  let compositeBindGroup: GPUBindGroup | null = null;
  let lastWidth = 0;
  let lastHeight = 0;

  function rebuildIntermediates(width: number, height: number) {
    depthTexture?.destroy();
    hdrColor?.destroy();
    for (const t of bloomMips) t.destroy();
    bloomMips = [];
    bloomMipViews = [];
    bloomMipParamBuffers = [];
    pyramidBindGroups = [];

    depthTexture = device.createTexture({
      size: [width, height],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    hdrColor = device.createTexture({
      size: [width, height],
      format: HDR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    hdrColorView = hdrColor.createView();

    // Build the mip chain. mip i is at 1/(2^(i+1)) of canvas resolution,
    // so mip 0 is half, mip (count-1) is the smallest.
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
      bloomMipViews.push(tex.createView());
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

    // Bind groups: one per source-mip, used both by downsample (when
    // sampling mip i to write mip i+1) and upsample (when sampling mip
    // i to write mip i-1 additively).
    for (let i = 0; i < BLOOM_MIP_COUNT; i++) {
      pyramidBindGroups.push(device.createBindGroup({
        layout: singleInputLayout,
        entries: [
          { binding: 0, resource: bloomMipViews[i]! },
          { binding: 1, resource: postSampler },
          { binding: 2, resource: { buffer: bloomMipParamBuffers[i]! } },
        ],
      }));
    }

    // Bright pass: reads hdrColor, writes mip 0. The uniform here is
    // the bright-pass threshold (NOT a texel-step), so reuse the static
    // brightPassUniform buffer.
    brightPassBindGroup = device.createBindGroup({
      layout: singleInputLayout,
      entries: [
        { binding: 0, resource: hdrColorView },
        { binding: 1, resource: postSampler },
        { binding: 2, resource: { buffer: brightPassUniform } },
      ],
    });

    // Composite: reads hdrColor + mip 0 (the accumulated bloom).
    compositeBindGroup = device.createBindGroup({
      layout: compositeLayout,
      entries: [
        { binding: 0, resource: hdrColorView },
        { binding: 1, resource: bloomMipViews[0]! },
        { binding: 2, resource: postSampler },
        { binding: 3, resource: { buffer: compositeUniform } },
      ],
    });

    lastWidth = width;
    lastHeight = height;
  }

  // Group entities by (kind, geometry, material) reference equality. Sorting
  // by kind first means we minimize pipeline switches in the render loop.
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

  const batches: Batch[] = [];
  for (const [kindId, byGeometry] of groupsByKind) {
    const kind = kinds.get(kindId);
    if (!kind) {
      throw new Error(`unknown material kind: ${kindId}`);
    }
    for (const [geometry, byMaterial] of byGeometry) {
      for (const [material, entities] of byMaterial) {
        const instanceCount = entities.length;
        const instanceData = new Float32Array(instanceCount * INSTANCE_FLOATS);
        for (let i = 0; i < instanceCount; i++) {
          const e = entities[i]!;
          instanceData.set(e.transform, i * INSTANCE_FLOATS);
          instanceData.set(e.tint, i * INSTANCE_FLOATS + 16);
        }
        const instanceBuffer = device.createBuffer({
          size: instanceData.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(instanceBuffer, 0, instanceData as BufferSource);

        const materialBindGroup = (
          kind.buildBindGroup as (m: MaterialValue) => GPUBindGroup
        )(material);

        const picker = kind.pickPipeline as
          | ((m: MaterialValue) => GPURenderPipeline)
          | undefined;
        const pipeline = picker ? picker(material) : null;

        batches.push({
          kindId,
          geometry,
          materialBindGroup,
          pipeline,
          instanceBuffer,
          instanceCount,
        });
      }
    }
  }

  return {
    render({ encoder, colorView, size, modelView, projection, cameraTarget, lighting, flatPreview = false }) {
      const [width, height] = size;
      if (width !== lastWidth || height !== lastHeight) {
        rebuildIntermediates(width, height);
      }

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
          view: shadowView,
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      shadowPass.setPipeline(shadowPipeline);
      shadowPass.setBindGroup(0, shadowBindGroup);
      for (const b of batches) {
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
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: depthTexture!.createView(),
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
      // pipeline switches when kindId changes, material bind group switches
      // per batch. Batches were sorted by kindId so all draws of one kind
      // run consecutively.
      //
      // In flat-preview mode we pick each kind's alpha-blended variant
      // when it provides one — that's how a texture with a transparent
      // alpha channel (a leaf shape, an SDF mask, anything authored
      // with cutout) composites over the checkerboard instead of
      // punching through it as fully opaque.
      pass.setBindGroup(0, sceneBindGroup);
      let activePipeline: GPURenderPipeline | null = null;
      for (const b of batches) {
        const kind = kinds.get(b.kindId)!;
        // Priority: flat-preview wants the blended variant (so authored
        // alpha composites over the checkerboard); otherwise use the
        // per-batch picked pipeline; otherwise the kind's default.
        const pipelineForPass =
          flatPreview && kind.pipelineBlended
            ? kind.pipelineBlended
            : (b.pipeline ?? kind.pipeline);
        if (pipelineForPass !== activePipeline) {
          pass.setPipeline(pipelineForPass);
          activePipeline = pipelineForPass;
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
          { view: bloomMipViews[0]!, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
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
            { view: bloomMipViews[i + 1]!, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
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
            { view: bloomMipViews[i - 1]!, loadOp: 'load', storeOp: 'store' },
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
          { view: colorView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' },
        ],
      });
      composite.setPipeline(compositePipeline);
      composite.setBindGroup(0, compositeBindGroup!);
      composite.draw(3);
      composite.end();
    },
  };
}
