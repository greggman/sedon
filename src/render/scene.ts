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
import brightPassShaderCode from './bright-pass.wgsl';
import blurShaderCode from './blur.wgsl';
import compositeShaderCode from './composite.wgsl';
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

// Bloom runs at half the screen resolution: cheaper, and the down-sample
// is the first "blur" pass — pairs naturally with the Gaussian to give a
// soft glow without needing a multi-mip pyramid (room to grow into that
// later for wider bloom).
const BLOOM_DIVISOR = 2;

// Pixels above this linear-HDR luminance contribute to bloom (with a
// soft knee). With sun intensity 3 and a typical sRGB-→-linear ~0.5
// albedo, lit pixels reach ~1.5; this lets sun-facing surfaces glow
// without bloom on ordinary midtones.
const BLOOM_THRESHOLD = 1.0;
const BLOOM_SOFT_KNEE = 0.5;

// How much of the blurred bloom mixes back into the final image. 0 = no
// bloom, 1 = full add. Subtle is usually right — the eye reads even a
// small glow as "bright light."
const BLOOM_INTENSITY = 0.45;

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
  }): void;
}

interface Batch {
  kindId: MaterialValue['kind'];
  geometry: GeometryValue;
  materialBindGroup: GPUBindGroup;
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

// Single bind-group layout shared by all three post-process pipelines.
// Slot 0 is always the primary input texture; slot 1 the (optional)
// second input; slot 2 the sampler; slot 3 a small uniform buffer with
// per-pass params. Each pipeline binds whichever slots its shader uses.
function createPostProcessLayouts(device: GPUDevice): {
  brightPassLayout: GPUBindGroupLayout;
  blurLayout: GPUBindGroupLayout;
  compositeLayout: GPUBindGroupLayout;
} {
  const brightPassLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  const blurLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  const compositeLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  return { brightPassLayout, blurLayout, compositeLayout };
}

function createPostProcessPipeline(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  code: string,
  outputFormat: GPUTextureFormat,
): GPURenderPipeline {
  const module = device.createShaderModule({ code });
  return device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format: outputFormat }] },
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

  // Post-process: bright-pass + two-pass Gaussian + composite.
  const { brightPassLayout, blurLayout, compositeLayout } =
    createPostProcessLayouts(device);
  const brightPassPipeline = createPostProcessPipeline(
    device, brightPassLayout, brightPassShaderCode, HDR_FORMAT,
  );
  const blurPipeline = createPostProcessPipeline(
    device, blurLayout, blurShaderCode, HDR_FORMAT,
  );
  const compositePipeline = createPostProcessPipeline(
    device, compositeLayout, compositeShaderCode, format,
  );

  // Post-process textures sample with clamp-to-edge so the blur doesn't
  // smear in pixels from the opposite edge.
  const postSampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  // Per-pass uniform buffers. Bright-pass: (threshold, soft_knee). Blur:
  // (dirX, dirY). Composite: (bloom_intensity). All padded up to 16 bytes
  // (minimum uniform buffer offset alignment).
  const brightPassUniform = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(
    brightPassUniform, 0,
    new Float32Array([BLOOM_THRESHOLD, BLOOM_SOFT_KNEE, 0, 0]) as BufferSource,
  );

  const blurUniformH = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const blurUniformV = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const compositeUniform = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(
    compositeUniform, 0,
    new Float32Array([BLOOM_INTENSITY, 0, 0, 0]) as BufferSource,
  );

  // Per-frame intermediates (lazy-allocated, resized on canvas size
  // change). depthTexture is the depth attachment for the main pass;
  // hdrColor receives the linear-HDR scene; bloomA/B ping-pong for the
  // blur passes at half resolution.
  let depthTexture: GPUTexture | null = null;
  let hdrColor: GPUTexture | null = null;
  let hdrColorView: GPUTextureView | null = null;
  let bloomA: GPUTexture | null = null;
  let bloomAView: GPUTextureView | null = null;
  let bloomB: GPUTexture | null = null;
  let bloomBView: GPUTextureView | null = null;
  // Bind groups depend on the texture views, so they're rebuilt whenever
  // the textures are.
  let brightPassBindGroup: GPUBindGroup | null = null;
  let blurBindGroupAB: GPUBindGroup | null = null; // reads A, writes B
  let blurBindGroupBA: GPUBindGroup | null = null; // reads B, writes A
  let compositeBindGroup: GPUBindGroup | null = null;
  let lastWidth = 0;
  let lastHeight = 0;

  function rebuildIntermediates(width: number, height: number) {
    depthTexture?.destroy();
    hdrColor?.destroy();
    bloomA?.destroy();
    bloomB?.destroy();

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

    const bw = Math.max(1, Math.floor(width / BLOOM_DIVISOR));
    const bh = Math.max(1, Math.floor(height / BLOOM_DIVISOR));
    bloomA = device.createTexture({
      size: [bw, bh],
      format: HDR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    bloomAView = bloomA.createView();
    bloomB = device.createTexture({
      size: [bw, bh],
      format: HDR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    bloomBView = bloomB.createView();

    // Bright pass reads scene HDR, writes A. Blur ping-pongs A↔B.
    // Composite reads scene HDR + final bloom (= A after both blurs).
    brightPassBindGroup = device.createBindGroup({
      layout: brightPassLayout,
      entries: [
        { binding: 0, resource: hdrColorView },
        { binding: 1, resource: postSampler },
        { binding: 2, resource: { buffer: brightPassUniform } },
      ],
    });
    blurBindGroupAB = device.createBindGroup({
      layout: blurLayout,
      entries: [
        { binding: 0, resource: bloomAView },
        { binding: 1, resource: postSampler },
        { binding: 2, resource: { buffer: blurUniformH } },
      ],
    });
    blurBindGroupBA = device.createBindGroup({
      layout: blurLayout,
      entries: [
        { binding: 0, resource: bloomBView },
        { binding: 1, resource: postSampler },
        { binding: 2, resource: { buffer: blurUniformV } },
      ],
    });
    compositeBindGroup = device.createBindGroup({
      layout: compositeLayout,
      entries: [
        { binding: 0, resource: hdrColorView },
        { binding: 1, resource: bloomAView },
        { binding: 2, resource: postSampler },
        { binding: 3, resource: { buffer: compositeUniform } },
      ],
    });

    // Blur step distance in UV space = 1 / texture dimension (per-axis).
    // Done at the bloom resolution, so the 9-tap kernel walks one bloom
    // texel per step → ~9 bloom texels = ~18 screen texels at half-res.
    device.queue.writeBuffer(
      blurUniformH, 0,
      new Float32Array([1 / bw, 0, 0, 0]) as BufferSource,
    );
    device.queue.writeBuffer(
      blurUniformV, 0,
      new Float32Array([0, 1 / bh, 0, 0]) as BufferSource,
    );

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

        batches.push({
          kindId,
          geometry,
          materialBindGroup,
          instanceBuffer,
          instanceCount,
        });
      }
    }
  }

  return {
    render({ encoder, colorView, size, modelView, projection, cameraTarget, lighting }) {
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

      // Sky first — fills the background gradient.
      pass.setPipeline(skyPipeline);
      pass.setBindGroup(0, skyBindGroup);
      pass.draw(3);

      // Scene geometry, dispatched per kind. Scene bind group is set once;
      // pipeline switches when kindId changes, material bind group switches
      // per batch. Batches were sorted by kindId so all draws of one kind
      // run consecutively.
      pass.setBindGroup(0, sceneBindGroup);
      let activeKind: MaterialValue['kind'] | null = null;
      for (const b of batches) {
        if (b.kindId !== activeKind) {
          pass.setPipeline(kinds.get(b.kindId)!.pipeline);
          activeKind = b.kindId;
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

      // Bright-pass: scene HDR → bloomA (half-res).
      const bright = encoder.beginRenderPass({
        colorAttachments: [
          { view: bloomAView!, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        ],
      });
      bright.setPipeline(brightPassPipeline);
      bright.setBindGroup(0, brightPassBindGroup!);
      bright.draw(3);
      bright.end();

      // Blur horizontal: bloomA → bloomB.
      const blurH = encoder.beginRenderPass({
        colorAttachments: [
          { view: bloomBView!, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        ],
      });
      blurH.setPipeline(blurPipeline);
      blurH.setBindGroup(0, blurBindGroupAB!);
      blurH.draw(3);
      blurH.end();

      // Blur vertical: bloomB → bloomA.
      const blurV = encoder.beginRenderPass({
        colorAttachments: [
          { view: bloomAView!, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        ],
      });
      blurV.setPipeline(blurPipeline);
      blurV.setBindGroup(0, blurBindGroupBA!);
      blurV.draw(3);
      blurV.end();

      // Composite: scene HDR + bloomA → swapchain (tone-map + sRGB encode).
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
