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

test('SceneRenderer: slider-scrub (same textures, different scalars) allocates nothing', () => {
  // The user-facing case this whole optimization exists for. Same
  // texture handles + same geometry, dragging a scalar (roughness)
  // should hit the material cache (bind group reuse) and the instance
  // buffer reuse path; ONLY a writeBuffer per frame for the scalar
  // uniform and a writeBuffer for the (unchanged) instance data.
  const device = createMockDevice();
  const renderer = createSceneRenderer(
    device as unknown as GPUDevice,
    'rgba8unorm',
  );
  const geom = externalGeometry(device);
  const tex = externalTexture(device);
  function pbrAt(roughness: number) {
    return {
      kind: 'pbr' as const,
      basecolor: tex,
      roughness,
      metallic: 0,
      normal: tex,
      detailBasecolor: tex,
      detailNormal: tex,
    };
  }

  renderer.setScene(makeScene(geom, pbrAt(0.5)));
  const base = snap(device);

  // 20 ticks of a slider drag. Same textures, same geometry, different
  // roughness scalar each time.
  for (let i = 0; i < 20; i++) {
    renderer.setScene(makeScene(geom, pbrAt(0.5 + i * 0.01)));
  }
  const after = snap(device);

  assert.equal(
    after.createdBuffers - base.createdBuffers,
    0,
    'slider scrub should not allocate any new buffers',
  );
  assert.equal(
    after.createdBindGroups - base.createdBindGroups,
    0,
    'slider scrub should not allocate any new bind groups',
  );
  assert.equal(
    after.destroyedBuffers - base.destroyedBuffers,
    0,
    'slider scrub should not destroy any buffers either',
  );
});

test('SceneRenderer: identical setScene calls allocate nothing — just two writeBuffer calls', () => {
  // A re-eval that produces the exact same scene should bottom out
  // at: 1 writeBuffer for instance data + 1 writeBuffer for the
  // material scalars. Both writes are tiny and unconditional —
  // skipping them would require a content fingerprint compare that
  // costs more than the writeBuffer itself.
  const device = createMockDevice();
  const renderer = createSceneRenderer(
    device as unknown as GPUDevice,
    'rgba8unorm',
  );
  const geom = externalGeometry(device);
  const pbr = makePbr(device, 0.5);
  renderer.setScene(makeScene(geom, pbr));
  const base = {
    createdBuffers: device.stats.createdBuffers,
    createdBindGroups: device.stats.createdBindGroups,
    writeBufferCalls: device.stats.writeBufferCalls,
  };
  renderer.setScene(makeScene(geom, pbr));
  const after = {
    createdBuffers: device.stats.createdBuffers,
    createdBindGroups: device.stats.createdBindGroups,
    writeBufferCalls: device.stats.writeBufferCalls,
  };

  assert.equal(after.createdBuffers, base.createdBuffers, 'no new buffers');
  assert.equal(after.createdBindGroups, base.createdBindGroups, 'no new bind groups');
  // 1 writeBuffer for the instance data (entities may have moved) +
  // 1 writeBuffer for the material scalars (always rewritten on
  // cache hit; cheap, and skipping the write would cost a string
  // comparison that's likely more expensive than the write itself).
  assert.equal(
    after.writeBufferCalls - base.writeBufferCalls,
    2,
    'setScene should issue exactly 2 writeBuffer calls per batch on cache hit (instance + scalars)',
  );
});

test('SceneRenderer: fresh GeometryValue wrapping the same GPU buffers still hits the instance-buffer cache', () => {
  // Regression test for a real bug: uploadMeshToGpu returns a NEW
  // GeometryValue object literal on every call, even when its inner
  // GPUBuffer handles are reused via reusableBuffer. The cache key
  // for instance buffer reuse must therefore key on the stable inner
  // buffer identity (positionBuffer), NOT on the outer GeometryValue
  // object reference. Without this, every eval rebuilds every batch's
  // instance buffer even when nothing about the geometry has changed.
  const device = createMockDevice();
  const renderer = createSceneRenderer(
    device as unknown as GPUDevice,
    'rgba8unorm',
  );
  // First scene: geometry "version 1" (one wrapper).
  const geomA = externalGeometry(device);
  const pbr = makePbr(device, 0.5);
  renderer.setScene(makeScene(geomA, pbr));
  const base = snap(device);

  // Re-wrap the same GPU buffers in a NEW GeometryValue literal —
  // exactly what uploadMeshToGpu produces when called twice.
  const geomB: GeometryValue = {
    positionBuffer: geomA.positionBuffer,
    normalBuffer: geomA.normalBuffer,
    uvBuffer: geomA.uvBuffer,
    indexBuffer: geomA.indexBuffer,
    indexCount: geomA.indexCount,
    indexFormat: geomA.indexFormat,
  };
  renderer.setScene(makeScene(geomB, pbr));
  const after = snap(device);

  assert.equal(after.createdBuffers - base.createdBuffers, 0,
    'fresh GeometryValue wrapping same GPU buffers should reuse instance buffer');
  assert.equal(after.createdBindGroups - base.createdBindGroups, 0,
    'same material should still hit the bind group cache');
});

test('SceneRenderer: changing only the texture handle rebuilds the bind group but not the param buffer dedup chain', () => {
  // Structural-key invalidation: swapping the basecolor texture should
  // miss the cache, build a fresh bind group + paramBuffer, and
  // destroy the previous material entry.
  const device = createMockDevice();
  const renderer = createSceneRenderer(
    device as unknown as GPUDevice,
    'rgba8unorm',
  );
  const geom = externalGeometry(device);

  renderer.setScene(makeScene(geom, makePbr(device, 0.5)));
  const base = snap(device);

  // Different basecolor texture each iteration → fresh structural key
  // → cache miss → new bind group + new paramBuffer. The previous
  // entry's paramBuffer is destroyed by setScene's purge step.
  for (let i = 0; i < 5; i++) {
    renderer.setScene(makeScene(geom, makePbr(device, 0.5)));
  }
  const after = snap(device);

  // Each iteration: 1 new bind group + 1 new paramBuffer.
  // Each iteration also destroys the previous param buffer (the
  // previous instance buffer is reused since geometry/structuralKey/
  // instanceCount actually MATCH — wait, they don't because
  // structuralKey changes with the texture). So instance buffer also
  // rebuilds. Total per iteration: 2 createBuffer + 2 destroyBuffer
  // + 1 createBindGroup.
  const buffersCreated = after.createdBuffers - base.createdBuffers;
  const buffersDestroyed = after.destroyedBuffers - base.destroyedBuffers;
  assert.equal(buffersCreated, buffersDestroyed,
    'texture-swap scrub should still balance creates against destroys');
  assert.ok(
    after.createdBindGroups - base.createdBindGroups >= 5,
    'each new texture handle should produce a new bind group',
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
