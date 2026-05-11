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

export interface SceneRenderer {
  render(params: {
    encoder: GPUCommandEncoder;
    colorView: GPUTextureView;
    depthView: GPUTextureView;
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
  const kinds = new Map<MaterialValue['kind'], MaterialKindImpl>([
    ['pbr', createPbrKind(device, format, sceneBindGroupLayout)],
    ['terrain-splat', createTerrainSplatKind(device, format, sceneBindGroupLayout)],
  ]);

  // Sky stays its own private pipeline — it isn't a material kind, it's a
  // pre-pass step before scene geometry.
  const skyPipeline = createSkyPipeline(device, format);
  const skyUniformBuffer = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const skyBindGroup = device.createBindGroup({
    layout: skyPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: skyUniformBuffer } }],
  });
  const skyScratch = new Float32Array(8);

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
    render({ encoder, colorView, depthView, modelView, projection, cameraTarget, lighting }) {
      // Light view+projection. Eye sits along the light direction from the
      // camera target so the shadow box tracks the user. lookAt with up=+Y
      // works for any light angle that isn't straight overhead; demos use
      // slanted sun so no fallback needed yet.
      const ld = lighting.direction;
      const ldLen = Math.hypot(ld[0], ld[1], ld[2]);
      const eye: [number, number, number] = [
        cameraTarget[0] + (ld[0] / ldLen) * SHADOW_EYE_DISTANCE,
        cameraTarget[1] + (ld[1] / ldLen) * SHADOW_EYE_DISTANCE,
        cameraTarget[2] + (ld[2] / ldLen) * SHADOW_EYE_DISTANCE,
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
      lightingScratch[0]  = lighting.direction[0];
      lightingScratch[1]  = lighting.direction[1];
      lightingScratch[2]  = lighting.direction[2];
      lightingScratch[4]  = lighting.color[0];
      lightingScratch[5]  = lighting.color[1];
      lightingScratch[6]  = lighting.color[2];
      lightingScratch[8]  = lighting.ambient[0];
      lightingScratch[9]  = lighting.ambient[1];
      lightingScratch[10] = lighting.ambient[2];
      lightingScratch[12] = lighting.fogColor[0];
      lightingScratch[13] = lighting.fogColor[1];
      lightingScratch[14] = lighting.fogColor[2];
      lightingScratch[15] = lighting.fogDensity;
      device.queue.writeBuffer(sceneUniformBuffer, 192, lightingScratch as BufferSource);

      device.queue.writeBuffer(shadowUniformBuffer, 0, lightViewProj as BufferSource);

      skyScratch[0] = lighting.skyTop[0];
      skyScratch[1] = lighting.skyTop[1];
      skyScratch[2] = lighting.skyTop[2];
      skyScratch[4] = lighting.skyBottom[0];
      skyScratch[5] = lighting.skyBottom[1];
      skyScratch[6] = lighting.skyBottom[2];
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

      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: colorView,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: depthView,
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
    },
  };
}
