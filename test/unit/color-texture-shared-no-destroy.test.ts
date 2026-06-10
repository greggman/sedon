// Regression: `getColorTexture` returns textures from a process-wide,
// content-keyed cache. Two consumers asking for the same RGBA share
// ONE GPUTexture handle (this is the renderer-batching invariant).
// The eval cache's sweep walks each evicted entry's GPU resources
// and destroys them — perfect for producer-owned textures
// (`tex/solid-color`, `tex/image`, …), CATASTROPHIC for these
// shared ones.
//
// Bug seen by the user: dragging a color picker fires one
// setInputValue per drag tick → fresh eval entries → previous entries
// evicted by sweep → its referenced color textures destroyed → next
// `getColorTexture(device, sameColor)` call returns the destroyed
// handle from the cache → WebGPU surfaces "Destroyed texture used in
// a submit". Intermittent because it only triggers if a colour
// recurs across eval rounds (e.g. drag back through a previously-
// visited shade).
//
// Fix: Texture2DValue.shared marks externally-owned textures.
// `walkGpuResources` skips them; the global cache stays the sole
// owner; consumers can safely keep references across eval rounds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkGpuResources } from '../../src/core/resources.js';
import type { Texture2DValue } from '../../src/core/resources.js';

function fakeTexture(): GPUTexture {
  // The walker only needs `.destroy` to exist on the texture handle.
  // We don't actually destroy anything — the test just asserts
  // whether the walker would have.
  return {
    destroy: () => { throw new Error('destroy should NOT be visited for shared textures'); },
  } as unknown as GPUTexture;
}

test('walkGpuResources visits the GPUTexture of a normal Texture2DValue', () => {
  let visited = false;
  const value: Texture2DValue = {
    texture: { destroy: () => { visited = true; } } as unknown as GPUTexture,
    format: 'rgba8unorm',
    width: 4,
    height: 4,
    revision: 0,
  };
  walkGpuResources(value, (r) => { r.destroy(); });
  assert.equal(visited, true, 'producer-owned textures must still be visited');
});

test('walkGpuResources SKIPS shared:true Texture2DValues — eval cache must not destroy them', () => {
  // The fakeTexture's destroy throws — if the walker visited it,
  // the throw would surface here. Silence means: skipped.
  const value: Texture2DValue = {
    texture: fakeTexture(),
    format: 'rgba8unorm',
    width: 1,
    height: 1,
    revision: 0,
    shared: true,
  };
  walkGpuResources(value, (r) => { r.destroy(); });
});

test('walkGpuResources also skips shared textures nested inside a MaterialValue', () => {
  // The realistic shape: a PBR material's basecolor is a shared
  // 1×1 colour texture from `getColorTexture`. Normal map etc. are
  // producer-owned. The walker must visit producer-owned textures
  // (so they get destroyed at eviction) and skip shared ones.
  const sharedBase: Texture2DValue = {
    texture: fakeTexture(),
    format: 'rgba8unorm',
    width: 1,
    height: 1,
    revision: 0,
    shared: true,
  };
  let producerNormalVisited = false;
  const producerNormal: Texture2DValue = {
    texture: { destroy: () => { producerNormalVisited = true; } } as unknown as GPUTexture,
    format: 'rgba8unorm',
    width: 256,
    height: 256,
    revision: 1,
  };
  const material = {
    kind: 'pbr' as const,
    basecolor: sharedBase,
    normal: producerNormal,
    roughness: 0.5,
    metallic: 0,
  };
  walkGpuResources(material, (r) => { r.destroy(); });
  assert.equal(producerNormalVisited, true, 'producer-owned normal map must still be destroyed');
  // sharedBase.texture.destroy would have thrown if visited.
});
