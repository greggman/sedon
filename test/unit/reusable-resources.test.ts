// Tests for the GPU resource reuse helpers. These don't need a real
// WebGPU device — they just need a tiny mock that records what was
// asked of it, so we can assert "reused the previous buffer" vs
// "allocated a fresh one" without standing up a browser. We do need
// to stub `GPUBufferUsage` though, because `uploadMeshToGpu` reads
// those flag constants inside the function body.
const g = globalThis as unknown as {
  GPUBufferUsage: Record<string, number>;
  GPUTextureUsage: Record<string, number>;
};
g.GPUBufferUsage ??= { VERTEX: 1, INDEX: 2, COPY_DST: 4, UNIFORM: 8 };
g.GPUTextureUsage ??= { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4 };

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reusableBuffer, reusableTexture } from '../../src/core/resources.js';
import { uploadMeshToGpu, type CpuMesh } from '../../src/render/mesh.js';

interface MockBuffer {
  size: number;
  destroy(): void;
  destroyed: boolean;
}

interface MockTexture {
  width: number;
  height: number;
  format: GPUTextureFormat;
  destroy(): void;
  destroyed: boolean;
  createView(): unknown;
}

interface MockDevice {
  createBufferCalls: number;
  createTextureCalls: number;
  writeBufferCalls: Array<{ buffer: MockBuffer; data: BufferSource }>;
  createBuffer(desc: { size: number; usage: number }): MockBuffer;
  createTexture(desc: {
    size: [number, number];
    format: GPUTextureFormat;
    usage: number;
  }): MockTexture;
  queue: {
    writeBuffer(buffer: MockBuffer, _offset: number, data: BufferSource): void;
    writeTexture(...args: unknown[]): void;
  };
}

function makeDevice(): MockDevice {
  const dev: MockDevice = {
    createBufferCalls: 0,
    createTextureCalls: 0,
    writeBufferCalls: [],
    createBuffer(desc) {
      dev.createBufferCalls++;
      const buf: MockBuffer = {
        size: desc.size,
        destroyed: false,
        destroy() {
          buf.destroyed = true;
        },
      };
      return buf;
    },
    createTexture(desc) {
      dev.createTextureCalls++;
      const tex: MockTexture = {
        width: desc.size[0],
        height: desc.size[1],
        format: desc.format,
        destroyed: false,
        destroy() {
          tex.destroyed = true;
        },
        createView() {
          return {};
        },
      };
      return tex;
    },
    queue: {
      writeBuffer(buffer, _offset, data) {
        dev.writeBufferCalls.push({ buffer, data });
      },
      writeTexture() {},
    },
  };
  return dev;
}

test('reusableBuffer: no previous → allocates new + writes', () => {
  const d = makeDevice();
  const data = new Uint32Array([1, 2, 3]);
  const buf = reusableBuffer(
    d as unknown as GPUDevice,
    undefined,
    data as BufferSource,
    0,
  );
  assert.equal(d.createBufferCalls, 1);
  assert.equal(d.writeBufferCalls.length, 1);
  assert.equal((buf as unknown as MockBuffer).size, data.byteLength);
});

test('reusableBuffer: previous with matching size → reused, writeBuffer into it', () => {
  const d = makeDevice();
  const data = new Uint32Array([1, 2, 3]);
  const previous = d.createBuffer({ size: data.byteLength, usage: 0 });
  d.createBufferCalls = 0; // reset to count only the reuse call
  const buf = reusableBuffer(
    d as unknown as GPUDevice,
    previous as unknown as GPUBuffer,
    data as BufferSource,
    0,
  );
  assert.equal(d.createBufferCalls, 0, 'no new buffer allocated');
  assert.equal(d.writeBufferCalls.length, 1, 'wrote into the existing buffer');
  assert.equal(buf, previous as unknown as GPUBuffer, 'returned the same buffer');
  assert.equal(previous.destroyed, false, 'previous not destroyed');
});

test('reusableBuffer: previous with different size → fresh allocation, previous NOT destroyed here', () => {
  // Destroying the previous is the cache sweep's job, not the helper's —
  // doing it here would invalidate the still-live cache entry that
  // references the previous buffer.
  const d = makeDevice();
  const previous = d.createBuffer({ size: 12, usage: 0 });
  d.createBufferCalls = 0;
  const data = new Uint32Array([1, 2, 3, 4, 5]);
  const buf = reusableBuffer(
    d as unknown as GPUDevice,
    previous as unknown as GPUBuffer,
    data as BufferSource,
    0,
  );
  assert.equal(d.createBufferCalls, 1, 'new buffer allocated');
  assert.notEqual(buf, previous as unknown as GPUBuffer);
  assert.equal(previous.destroyed, false, 'previous buffer left intact for the cache sweep');
});

test('reusableTexture: matching dims+format → reuse same GPUTexture, fresh view', () => {
  const d = makeDevice();
  const previous: MockTexture = {
    width: 256,
    height: 256,
    format: 'rgba8unorm',
    destroyed: false,
    destroy() { previous.destroyed = true; },
    createView() { return { tag: 'fresh-view' }; },
  };
  const value = reusableTexture(
    d as unknown as GPUDevice,
    { texture: previous as unknown as GPUTexture, format: 'rgba8unorm', width: 256, height: 256 },
    { width: 256, height: 256, format: 'rgba8unorm', usage: 0 },
  );
  assert.equal(d.createTextureCalls, 0);
  assert.equal(value.texture as unknown as MockTexture, previous);
  assert.equal(value.width, 256);
  assert.equal(value.height, 256);
});

test('reusableTexture: mismatched dims → fresh texture, previous NOT destroyed', () => {
  const d = makeDevice();
  const previous: MockTexture = {
    width: 256,
    height: 256,
    format: 'rgba8unorm',
    destroyed: false,
    destroy() { previous.destroyed = true; },
    createView() { return {}; },
  };
  const value = reusableTexture(
    d as unknown as GPUDevice,
    { texture: previous as unknown as GPUTexture, format: 'rgba8unorm', width: 256, height: 256 },
    { width: 512, height: 512, format: 'rgba8unorm', usage: 0 },
  );
  assert.equal(d.createTextureCalls, 1);
  assert.notEqual(value.texture as unknown as MockTexture, previous);
  assert.equal(previous.destroyed, false);
});

test('reusableTexture: mismatched format → fresh allocation', () => {
  const d = makeDevice();
  const previous: MockTexture = {
    width: 256,
    height: 256,
    format: 'rgba8unorm',
    destroyed: false,
    destroy() { previous.destroyed = true; },
    createView() { return {}; },
  };
  const value = reusableTexture(
    d as unknown as GPUDevice,
    { texture: previous as unknown as GPUTexture, format: 'rgba8unorm', width: 256, height: 256 },
    { width: 256, height: 256, format: 'rgba16float', usage: 0 },
  );
  assert.equal(d.createTextureCalls, 1);
  assert.notEqual(value.texture as unknown as MockTexture, previous);
});

test('uploadMeshToGpu: with matching previous, reuses all four buffers', () => {
  const d = makeDevice();
  const mesh: CpuMesh = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  };
  const first = uploadMeshToGpu(d as unknown as GPUDevice, mesh);
  const allocsAfterFirst = d.createBufferCalls;
  assert.equal(allocsAfterFirst, 4, 'first upload allocates all four buffers');

  // Same shape mesh (different values, same byteLengths).
  const mesh2: CpuMesh = {
    positions: new Float32Array([9, 9, 9, 8, 8, 8, 7, 7, 7]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
    indices: new Uint32Array([0, 1, 2]),
  };
  const second = uploadMeshToGpu(d as unknown as GPUDevice, mesh2, first);
  assert.equal(
    d.createBufferCalls,
    allocsAfterFirst,
    'second upload reused buffers — no new allocations',
  );
  assert.equal(second.positionBuffer, first.positionBuffer);
  assert.equal(second.normalBuffer, first.normalBuffer);
  assert.equal(second.uvBuffer, first.uvBuffer);
  assert.equal(second.indexBuffer, first.indexBuffer);
});

test('uploadMeshToGpu: with mismatched-size previous, allocates fresh', () => {
  const d = makeDevice();
  const small: CpuMesh = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  };
  const first = uploadMeshToGpu(d as unknown as GPUDevice, small);
  d.createBufferCalls = 0;

  // Larger mesh — every buffer differs in size.
  const big: CpuMesh = {
    positions: new Float32Array(30),
    normals: new Float32Array(30),
    uvs: new Float32Array(20),
    indices: new Uint32Array(12),
  };
  const second = uploadMeshToGpu(d as unknown as GPUDevice, big, first);
  assert.equal(d.createBufferCalls, 4, 'all four buffers reallocated');
  assert.notEqual(second.positionBuffer, first.positionBuffer);
});

test('uploadMeshToGpu: per-buffer reuse — only the differently-sized buffer reallocates', () => {
  // Edge case worth pinning: imagine a mesh whose vertex count is
  // unchanged but whose index count changes (e.g. an LOD-style
  // reduction that keeps the vertex pool but emits different
  // triangles). Each buffer is checked independently.
  const d = makeDevice();
  const first = uploadMeshToGpu(d as unknown as GPUDevice, {
    positions: new Float32Array(9),
    normals: new Float32Array(9),
    uvs: new Float32Array(6),
    indices: new Uint32Array([0, 1, 2, 0, 1, 2]),
  });
  d.createBufferCalls = 0;

  const second = uploadMeshToGpu(
    d as unknown as GPUDevice,
    {
      positions: new Float32Array(9),
      normals: new Float32Array(9),
      uvs: new Float32Array(6),
      indices: new Uint32Array([0, 1, 2]), // half the size
    },
    first,
  );
  assert.equal(d.createBufferCalls, 1, 'only the index buffer reallocated');
  assert.equal(second.positionBuffer, first.positionBuffer);
  assert.equal(second.normalBuffer, first.normalBuffer);
  assert.equal(second.uvBuffer, first.uvBuffer);
  assert.notEqual(second.indexBuffer, first.indexBuffer);
});
