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
import { createSceneRenderer, flushUnusedPools } from '../../src/render/scene.js';

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

  // Each iteration:
  //   • Allocates 1 fresh paramBuffer in the module-level material
  //     cache (new structural key — different texture handle per
  //     iteration since `makePbr` builds a fresh externalTexture).
  //     Material entries' eviction stays DEFERRED to flushUnusedPools
  //     because materials are content-keyed and can legitimately be
  //     re-acquired by another renderer that happens to use the same
  //     texture handles.
  //   • Allocates 1 fresh instance buffer in the per-renderer-namespaced
  //     instance buffer pool (structural key differs ⇒ new pool key).
  //     Instance entries' eviction is IMMEDIATE because the key is
  //     renderer-scoped — once refs drop to 0, no other renderer can
  //     ever match it, so we don't have to wait for flushUnusedPools.
  //     That immediate destroy is what keeps slider scrubs from
  //     leaking arbitrarily many stale per-renderer entries.
  const created = after.createdBuffers - base.createdBuffers;
  const destroyed = after.destroyedBuffers - base.destroyedBuffers;
  assert.equal(created, 40, `expected 40 buffer allocations across 20 iterations (got ${created})`);
  // Instance buffers self-destroy on release: iteration N releases
  // N-1's, so we see 20 destroys across the loop. Material
  // paramBuffers stay live (deferred eviction).
  assert.equal(destroyed, 20, `each iteration's previous instance buffer self-destroys immediately on release (got ${destroyed})`);
});

test('SceneRenderer.destroy: repeated create/destroy cycles do not leak GPU resources', () => {
  // The most useful version of "destroy releases everything" is the
  // long-running invariant: a device that's gone through N renderer
  // create+destroy cycles holds the same number of live resources as
  // a device that's gone through ONE such cycle. (Some allocations —
  // the shadow map, samplers, flat-normal/half placeholders, the
  // device-shared materialCache entries — are device-scoped per
  // design and survive renderer destruction; they allocate on the
  // FIRST cycle only.)
  const device = createMockDevice();
  // External resources shared across cycles — mimics the real editor
  // where `reusableTexture` / `uploadMeshToGpu` reuse handles across
  // re-evals, so successive renderer mounts see the SAME texture
  // identities. Each cycle that uses these same handles will hit the
  // device-shared materialCache and allocate nothing per-material.
  const sharedGeom = externalGeometry(device);
  const sharedTexture = externalTexture(device);
  function sharedPbr(): { kind: 'pbr'; basecolor: typeof sharedTexture; roughness: number; metallic: number; normal: typeof sharedTexture; detailBasecolor: typeof sharedTexture; detailNormal: typeof sharedTexture } {
    return {
      kind: 'pbr',
      basecolor: sharedTexture,
      roughness: 0.5,
      metallic: 0,
      normal: sharedTexture,
      detailBasecolor: sharedTexture,
      detailNormal: sharedTexture,
    };
  }

  function cycle(): void {
    const r = createSceneRenderer(device as unknown as GPUDevice, 'rgba8unorm');
    r.setScene(makeScene(sharedGeom, sharedPbr()));
    r.destroy();
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

  // Each iteration produces a new structural key (new texture handle).
  // Material cache picks up a new paramBuffer + bind group (deferred
  // eviction — kept around for cross-renderer reuse). Instance buffer
  // pool picks up a new entry but immediately destroys the previous
  // one on release (per-renderer-namespaced keys mean no cross-
  // renderer reuse to wait for).
  const buffersCreated = after.createdBuffers - base.createdBuffers;
  const buffersDestroyed = after.destroyedBuffers - base.destroyedBuffers;
  assert.equal(buffersCreated, 5 * 2, `expected 10 buffer allocs across 5 texture swaps (got ${buffersCreated})`);
  assert.equal(
    buffersDestroyed,
    5,
    `instance buffers self-destroy on release; material paramBuffers stay live (got ${buffersDestroyed})`,
  );
  assert.ok(
    after.createdBindGroups - base.createdBindGroups >= 5,
    'each new texture handle should produce a new bind group',
  );
});

test('slider-scrub style geometry churn cleans up instance buffers immediately on release', () => {
  // Simulates a "sphere segments" slider drag: each tick generates a
  // new geometry (new positionBuffer handle) → new instance buffer
  // pool key. Because instance-buffer keys are renderer-namespaced,
  // releasing them when setScene's diff swaps them out destroys the
  // buffer immediately — no need to wait for flushUnusedPools, which
  // means a long scrub doesn't accumulate stale per-renderer entries.
  const device = createMockDevice();
  const renderer = createSceneRenderer(device as unknown as GPUDevice, 'rgba8unorm');
  const tex = externalTexture(device);
  function makeFreshGeometry(): GeometryValue {
    return externalGeometry(device);
  }
  function makeScene(geom: GeometryValue) {
    const pbr = {
      kind: 'pbr' as const,
      basecolor: tex, roughness: 0.5, metallic: 0,
      normal: tex, detailBasecolor: tex, detailNormal: tex,
    };
    return {
      entities: [{ geometry: geom, material: pbr, transform: identity(), tint: identityTint() }],
    };
  }
  renderer.setScene(makeScene(makeFreshGeometry()));
  const base = snap(device);

  // 10 more ticks, each with a brand-new geometry. Each tick swaps
  // in a new instance buffer and releases the previous one —
  // releaseInstanceBuffer destroys it on the spot, so the running
  // count of live instance buffers stays at exactly 1 throughout.
  for (let i = 0; i < 10; i++) {
    renderer.setScene(makeScene(makeFreshGeometry()));
  }
  const afterScrub = snap(device);
  assert.equal(
    afterScrub.destroyedBuffers - base.destroyedBuffers,
    10,
    `expected 10 instance buffers destroyed across the scrub (got ${afterScrub.destroyedBuffers - base.destroyedBuffers})`,
  );

  // The follow-up flush should be a no-op for instance buffers (all
  // already gone). Materials may have their own refs=0 entries that
  // flush picks up; the assertion below is just that we don't blow
  // up.
  flushUnusedPools();
  renderer.destroy();
});

test('renderer.destroy() reclaims its instance buffer immediately; material entries wait for flushUnusedPools', () => {
  const device = createMockDevice();
  const geom = externalGeometry(device);
  const pbr = makePbr(device, 0.5);
  const scene = makeScene(geom, pbr);
  const renderer = createSceneRenderer(device as unknown as GPUDevice, 'rgba8unorm');
  renderer.setScene(scene);
  const liveBuffersBefore = device.stats.liveBuffers.size;
  renderer.destroy();
  // destroy() releases the renderer's instance buffer key; because
  // instance-buffer keys are renderer-namespaced, releaseInstanceBuffer
  // destroys the buffer on the spot. The paramBuffer behind the
  // shared material cache is content-keyed and stays alive for a
  // future renderer to re-acquire.
  assert.equal(
    liveBuffersBefore - device.stats.liveBuffers.size,
    1,
    'destroy() reclaims the renderer-private instance buffer immediately',
  );
  const afterDestroy = device.stats.liveBuffers.size;
  flushUnusedPools();
  // flushUnusedPools picks up the now-orphaned material paramBuffer.
  assert.ok(
    device.stats.liveBuffers.size < afterDestroy,
    'flushUnusedPools after destroy reclaims the material paramBuffer',
  );
});

test('SceneRenderer: a fresh renderer on the same device reuses cached materials from a previous renderer', () => {
  // The scenario in the user's stack trace:
  //   GPUDevice.createBuffer (pbr-kind.ts:147, buildBindGroup)
  //   ← scene.ts:622 (setScene)
  //   ← scene-preview.tsx:95 (renderer.setScene(scene))
  //   ← React commitHookEffectListMount
  //
  // The setScene that runs is the FIRST one a freshly-mounted
  // ScenePreview makes — its renderer is brand-new, its (formerly
  // per-renderer) materialCache was empty, so the first setScene call
  // always allocated a paramBuffer + bind group for every material in
  // the scene.
  //
  // But the GPU resources backing that material's textures already
  // exist on the device — they were allocated by an earlier renderer
  // (the previous mount of this same ScenePreview, or a sibling
  // AssetThumbnail's renderer). DockView layout changes / React
  // StrictMode / scene-preview unmount-remount all throw away the
  // per-renderer materialCache even though nothing about the GPU state
  // changed.
  //
  // The fix: hoist the materialCache to a per-device shared store so
  // any renderer on a given device picks up entries already built by
  // earlier renderers. The per-renderer state that DOES legitimately
  // need to be rebuilt (scene/shadow/sky uniform buffers + the
  // per-batch instance buffer) is a separate concern.
  const device = createMockDevice();
  const geom = externalGeometry(device);
  const pbr = makePbr(device, 0.5);
  const scene = makeScene(geom, pbr);

  const r1 = createSceneRenderer(device as unknown as GPUDevice, 'rgba8unorm');
  r1.setScene(scene);
  // Snapshot AFTER r1's creation+setScene so the baseline reflects all
  // first-time allocations. From here on, no createBuffer or
  // createBindGroup should fire for an equivalent scene — every GPU
  // resource the renderer needs already exists somewhere in module-
  // scoped shared state.
  const baseline = {
    buffers: device.stats.createdBuffers,
    bindGroups: device.stats.createdBindGroups,
    textures: device.stats.createdTextures,
  };
  r1.destroy();

  // Mimics ScenePreview remounting: previous renderer destroyed, fresh
  // one created. Same scene (same texture handles).
  const r2 = createSceneRenderer(device as unknown as GPUDevice, 'rgba8unorm');
  r2.setScene(scene);

  const newBuffers = device.stats.createdBuffers - baseline.buffers;
  const newBindGroups = device.stats.createdBindGroups - baseline.bindGroups;
  const newTextures = device.stats.createdTextures - baseline.textures;

  // The fresh renderer reuses the shared material bind group + the
  // shared depth/HDR/bloom intermediates. The one thing it CANNOT
  // share is the instance buffer — those are renderer-namespaced
  // because their contents (per-entity transforms/tints) are scene-
  // specific and would be corrupted by another consumer writing the
  // same key with a different scene's data. So we expect exactly one
  // new buffer (the instance buffer) and zero new bind groups /
  // textures.
  assert.equal(
    newBuffers,
    1,
    `fresh renderer + setScene allocates only the renderer-private instance buffer (got ${newBuffers})`,
  );
  assert.equal(
    newBindGroups,
    0,
    `fresh renderer + setScene with already-cached scene should allocate ZERO bind groups, allocated ${newBindGroups}`,
  );
  assert.equal(
    newTextures,
    0,
    `fresh renderer + setScene with already-cached scene should allocate ZERO textures, allocated ${newTextures}`,
  );
  r2.destroy();
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
  // Resize: a never-before-seen (width, height) pair allocates a
  // fresh entry in the module-level intermediates cache. The
  // previous size's intermediates STAY ALIVE (pool never evicts) —
  // if the canvas resizes back, those entries get reused.
  renderer.render({ ...renderArgs, size: [512, 512] });
  const after3 = snap(device);
  assert.ok(
    after3.createdTextures - after2.createdTextures > 0,
    'a new (w,h) should allocate the size-bound intermediates',
  );
  assert.equal(
    after3.destroyedTextures - after2.destroyedTextures,
    0,
    'module-level intermediates pool should never destroy on resize',
  );
  // Resize BACK to the original size — the previous entries are
  // still in the pool, so this should allocate nothing.
  renderer.render(renderArgs);
  const after4 = snap(device);
  assert.equal(
    after4.createdTextures - after3.createdTextures,
    0,
    'returning to a previously-seen size should reuse cached intermediates',
  );
});

test('two SceneRenderers with the same (geometry, material) batch do NOT share an instance buffer', () => {
  // Regression for the "palm disappears" bug. Reproducer:
  //   1. Open Tree & Bush — main preview is rendering the full scene
  //      (a palm trunk at some scattered world position).
  //   2. Pin a second preview pane to the Branch Palm subgraph —
  //      that preview renders the palm at identity.
  //   3. Edit any param in the subgraph that forces both consumers
  //      to re-eval and re-setScene.
  //
  // Both renderers' setScene runs against the same shared module-
  // level pool. They share the same (positionBuffer id, material
  // structural key, instanceCount) because the trunk's geometry +
  // material are cached. With an un-namespaced pool key the second
  // setScene writes its own per-entity transforms over the first's
  // — the first renderer then draws its palm at the wrong world
  // position (off-screen for a tight subgraph preview camera) and
  // the user sees "the tree disappeared."
  //
  // The fix: include each renderer's id in the instance-buffer pool
  // key. Test invariant: setScene on a second renderer with a scene
  // that's structurally compatible with the first MUST allocate a
  // fresh instance buffer rather than reusing the first's.
  const device = createMockDevice();
  const geom = externalGeometry(device);
  const pbr = makePbr(device, 0.5);

  const r1 = createSceneRenderer(device as unknown as GPUDevice, 'rgba8unorm');
  const sceneA = {
    entities: [
      { geometry: geom, material: pbr, transform: identity(), tint: identityTint() },
    ],
  };
  r1.setScene(sceneA);

  const baseline = device.stats.createdBuffers;
  const r2 = createSceneRenderer(device as unknown as GPUDevice, 'rgba8unorm');
  // sceneB shares the same geometry + material as sceneA but uses a
  // translated transform — exactly the conflict that was silently
  // corrupting palm positions before the fix.
  const transformB = identity();
  transformB[12] = 100; // translate x = 100
  const sceneB = {
    entities: [
      { geometry: geom, material: pbr, transform: transformB, tint: identityTint() },
    ],
  };
  r2.setScene(sceneB);

  const newBuffers = device.stats.createdBuffers - baseline;
  // r2's setScene must allocate its own instance buffer (1 new
  // buffer). Materials are shared (they're content-keyed), so no
  // new bind group / paramBuffer. Geometry is external. → exactly 1.
  assert.equal(
    newBuffers,
    1,
    `r2 must allocate its own instance buffer (got ${newBuffers}); cross-renderer sharing here would corrupt r1's per-entity transform`,
  );

  r1.destroy();
  r2.destroy();
});
