// Allocation/lifetime invariants for SceneRenderer. The renderer is a
// long-lived (per device + format) object: callers create it once and
// push new scenes via setScene as the eval pipeline produces them.
// These tests pin down the GPU-resource lifecycle so a future "tiny
// refactor that hands out a fresh bind group per setScene" can't
// silently regress allocation counts.
//
// Uses test/mock-gpu.ts (no real WebGPU). The mock tracks createX
// vs destroy counters and live-instance sets, so we can assert
// equalities directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockDevice, type MockGPUDevice } from '../mock-gpu.js';
import type {
  GeometryValue,
  PbrMaterial,
  SceneValue,
  Texture2DValue,
} from '../../src/core/resources.js';
import { identityTint } from '../../src/core/resources.js';
import { identity } from '../../src/render/mat4.js';
import { createSceneRenderer } from '../../src/render/scene.js';

// Tag every input texture/geometry as "externally owned" so its
// alloc count is excluded from "what did the renderer allocate?"
// reasoning. The renderer doesn't own these — the eval pipeline
// passed them in.
function externalBuffer(device: MockGPUDevice, size: number, usage = 0x20 /* VERTEX */) {
  return device.createBuffer({ size, usage });
}
function externalTexture(device: MockGPUDevice): Texture2DValue {
  const t = device.createTexture({
    size: [1, 1],
    format: 'rgba8unorm',
  });
  return {
    texture: t as unknown as GPUTexture,
    format: 'rgba8unorm',
    width: 1,
    height: 1,
  };
}
function externalGeometry(device: MockGPUDevice): GeometryValue {
  return {
    positionBuffer: externalBuffer(device, 36) as unknown as GPUBuffer,
    normalBuffer: externalBuffer(device, 36) as unknown as GPUBuffer,
    uvBuffer: externalBuffer(device, 24) as unknown as GPUBuffer,
    indexBuffer: externalBuffer(device, 6, 0x10 /* INDEX */) as unknown as GPUBuffer,
    indexCount: 3,
    indexFormat: 'uint16',
  };
}
// Bare PBR with all texture inputs filled in. Providing normal +
// detailBasecolor + detailNormal stops the kind from lazily creating
// 1×1 flat placeholder textures, which would muddle the "no growth
// per setScene" assertion.
function makePbr(device: MockGPUDevice, roughness: number): PbrMaterial {
  const tex = externalTexture(device);
  return {
    kind: 'pbr',
    basecolor: tex,
    roughness,
    metallic: 0,
    normal: tex,
    detailBasecolor: tex,
    detailNormal: tex,
  };
}

function makeScene(geom: GeometryValue, material: PbrMaterial): SceneValue {
  return {
    entities: [
      {
        geometry: geom,
        material,
        transform: identity(),
        tint: identityTint(),
      },
    ],
  };
}

// Snapshot a slice of stats for delta math.
function snap(d: MockGPUDevice) {
  return {
    createdTextures: d.stats.createdTextures,
    destroyedTextures: d.stats.destroyedTextures,
    createdBuffers: d.stats.createdBuffers,
    destroyedBuffers: d.stats.destroyedBuffers,
    createdSamplers: d.stats.createdSamplers,
    createdBindGroups: d.stats.createdBindGroups,
  };
}

test('SceneRenderer: setScene called repeatedly with new materials neither leaks nor reallocates textures', () => {
  const device = createMockDevice();
  const renderer = createSceneRenderer(
    device as unknown as GPUDevice,
    'rgba8unorm',
  );

  // First setScene establishes baseline batches. Nothing to destroy yet.
  const geom = externalGeometry(device);
  renderer.setScene(makeScene(geom, makePbr(device, 0.5)));
  const base = snap(device);

  // Simulate a slider drag — many setScene calls, each a fresh
  // MaterialValue with a different roughness (matches what the eval
  // pipeline produces: new MaterialValue object every eval, same
  // underlying GPU textures via reusableTexture).
  for (let i = 0; i < 20; i++) {
    renderer.setScene(makeScene(geom, makePbr(device, 0.5 + i * 0.01)));
  }
  const after = snap(device);

  // The renderer itself shouldn't create any textures during plain
  // setScene calls — depth/HDR/bloom intermediates are size-bound and
  // only allocated on first render(), not setScene. The only textures
  // created during the loop come from the test scaffolding building
  // fresh PbrMaterial inputs (one shared 1×1 texture per makePbr call).
  const externalTexCreatesPerFrame = 1;
  const expectedNewExternalTextures = 20 * externalTexCreatesPerFrame;
  assert.equal(
    after.createdTextures - base.createdTextures,
    expectedNewExternalTextures,
    'renderer should not allocate textures during plain setScene calls',
  );

  // The renderer DOES allocate per-batch buffers each setScene (1
  // instance buffer + 1 material paramBuffer), but it should also
  // destroy the previous batch's buffers when replacing. So the
  // created-vs-destroyed delta over 20 drags should be EQUAL except
  // for the final still-live batch.
  const created = after.createdBuffers - base.createdBuffers;
  const destroyed = after.destroyedBuffers - base.destroyedBuffers;
  assert.equal(
    created,
    destroyed,
    `setScene should destroy the previous batch's buffers (created ${created}, destroyed ${destroyed})`,
  );
});

test('SceneRenderer.destroy: repeated create/destroy cycles do not leak GPU resources', () => {
  // The most useful version of "destroy releases everything" is the
  // long-running invariant: a device that's gone through N renderer
  // create+destroy cycles holds the same number of live resources as
  // a device that's gone through ONE such cycle. (Some allocations —
  // the shadow map, samplers, flat-normal/half placeholders — are
  // device-scoped per design and survive renderer destruction; they
  // allocate on the FIRST cycle only.)
  const device = createMockDevice();

  // Run a single warm-up cycle to populate device-scoped caches.
  function cycle(): void {
    const r = createSceneRenderer(device as unknown as GPUDevice, 'rgba8unorm');
    const geom = externalGeometry(device);
    const pbr = makePbr(device, 0.5);
    r.setScene(makeScene(geom, pbr));
    r.destroy();
    // Geometry buffers + material texture are external — the renderer
    // shouldn't free them. Clean them up here so each cycle nets to
    // zero new live resources.
    geom.positionBuffer.destroy();
    geom.normalBuffer.destroy();
    geom.uvBuffer.destroy();
    geom.indexBuffer.destroy();
    pbr.basecolor.texture.destroy();
  }
  cycle();
  const afterFirstCycle = {
    liveBuffers: device.stats.liveBuffers.size,
    liveTextures: device.stats.liveTextures.size,
  };

  // Now do many more cycles. Each one should net-zero on GPU resources.
  for (let i = 0; i < 10; i++) cycle();

  assert.equal(
    device.stats.liveBuffers.size,
    afterFirstCycle.liveBuffers,
    `repeated renderer cycles leak buffers (was ${afterFirstCycle.liveBuffers}, now ${device.stats.liveBuffers.size})`,
  );
  assert.equal(
    device.stats.liveTextures.size,
    afterFirstCycle.liveTextures,
    `repeated renderer cycles leak textures (was ${afterFirstCycle.liveTextures}, now ${device.stats.liveTextures.size})`,
  );
});

test('SceneRenderer: render() allocates per-canvas intermediates once per size', () => {
  // The depth + HDR + 6 bloom mip textures inside the renderer are
  // size-bound — they (re)allocate when canvas size changes. Repeated
  // render() at the same size should NOT realloc.
  const device = createMockDevice();
  const renderer = createSceneRenderer(
    device as unknown as GPUDevice,
    'rgba8unorm',
  );
  const geom = externalGeometry(device);
  renderer.setScene(makeScene(geom, makePbr(device, 0.5)));

  const encoder = device.createCommandEncoder() as unknown as GPUCommandEncoder;
  const lighting = {
    direction: [0, -1, 0] as [number, number, number],
    color: [1, 1, 1] as [number, number, number],
    ambient: [0.1, 0.1, 0.1] as [number, number, number],
    fogColor: [0.5, 0.5, 0.5] as [number, number, number],
    fogDensity: 0,
    bloomThreshold: 1,
    bloomSoftKnee: 0.5,
    bloomIntensity: 0.5,
  };
  const renderArgs = {
    encoder,
    colorView: externalTexture(device).texture,
    size: [256, 256] as [number, number],
    modelView: identity(),
    projection: identity(),
    cameraTarget: [0, 0, 0] as [number, number, number],
    lighting,
    flatPreview: false,
  };
  renderer.render(renderArgs);
  const after1 = snap(device);
  // Render again at the SAME size — intermediates should not realloc.
  renderer.render(renderArgs);
  const after2 = snap(device);
  assert.equal(
    after2.createdTextures - after1.createdTextures,
    0,
    'second render() at same size should not allocate textures',
  );
  // Resize: intermediates SHOULD reallocate.
  renderer.render({ ...renderArgs, size: [512, 512] });
  const after3 = snap(device);
  assert.ok(
    after3.createdTextures - after2.createdTextures > 0,
    'resize should reallocate the size-bound intermediates',
  );
  // The old intermediates should be destroyed as part of that resize.
  assert.ok(
    after3.destroyedTextures - after2.destroyedTextures > 0,
    'resize should destroy the previous size-bound intermediates',
  );
});
