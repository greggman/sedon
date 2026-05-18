// Unit tests for the reusableBuffer helper. The 0-byte case is what
// caused the user's palm-disappears regression: an empty point cloud
// → empty mesh → `device.createBuffer({size: 0})`, which the WebGPU
// spec calls a validation error. The fix clamps the requested size to
// a min so the GPUBuffer handle is always valid; the surrounding
// indexCount=0 makes sure nothing actually reads from it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockDevice } from '../mock-gpu.js';
import { reusableBuffer } from '../../src/core/resources.js';

test('reusableBuffer never asks the device for a size=0 buffer', () => {
  const device = createMockDevice();
  const empty = new Float32Array(0);
  const buf = reusableBuffer(
    device as unknown as GPUDevice,
    undefined,
    empty as BufferSource,
    GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  );
  // Real WebGPU forbids size=0 (it's a validation error and the
  // returned buffer is invalid). The placeholder must be non-zero so
  // the pipeline can still bind it; nothing reads from it because
  // indexCount is also 0 in that code path.
  assert.ok((buf as unknown as { size: number }).size > 0, 'placeholder buffer has nonzero size');
  // No writeBuffer for empty data: writing 0 bytes is a no-op on real
  // hardware but the mock's counter tells us we skipped the call.
  assert.equal(device.stats.writeBufferCalls, 0, 'no writeBuffer for empty data');
});

test('reusableBuffer reuses the previous buffer when sizes match and writes the new data', () => {
  const device = createMockDevice();
  const data = new Float32Array([1, 2, 3, 4]);
  const buf1 = reusableBuffer(
    device as unknown as GPUDevice,
    undefined,
    data as BufferSource,
    GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  );
  const writesAfterFirst = device.stats.writeBufferCalls;
  const buf2 = reusableBuffer(
    device as unknown as GPUDevice,
    buf1,
    new Float32Array([5, 6, 7, 8]) as BufferSource,
    GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  );
  assert.equal(buf2, buf1, 'reused the same GPUBuffer handle');
  assert.equal(device.stats.writeBufferCalls, writesAfterFirst + 1, 'wrote the new contents');
});

test('reusableBuffer handles shrinking from N bytes to 0 bytes — the empty-point-cloud path', () => {
  // Exactly the regression: a scatter-on-points geometry shrinks to
  // zero when all points get filtered out. The previous buffer was
  // full-sized; the new data is empty. We must not call
  // createBuffer({size: 0}).
  const device = createMockDevice();
  const usage = GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST;
  const prev = reusableBuffer(
    device as unknown as GPUDevice,
    undefined,
    new Float32Array(64) as BufferSource,
    usage,
  );
  const writesBefore = device.stats.writeBufferCalls;
  const buf = reusableBuffer(
    device as unknown as GPUDevice,
    prev,
    new Float32Array(0) as BufferSource,
    usage,
  );
  assert.notEqual(buf, prev, 'shrinking to zero creates a new placeholder rather than reusing');
  assert.ok((buf as unknown as { size: number }).size > 0, 'new placeholder is valid in WebGPU terms (size>0)');
  assert.equal(device.stats.writeBufferCalls, writesBefore, 'no extra writeBuffer for the empty data');
});

test('reusableBuffer skips writeBuffer on the same-size path when data is empty', () => {
  // If a node ever ends up calling reusableBuffer with `previous`
  // already being a min-size placeholder AND new data also empty, the
  // sizes match (both at the min). We must still skip the writeBuffer
  // — writing 0 bytes is technically a no-op but the mock counts the
  // call, and on real hardware it'd just be busywork on the queue.
  const device = createMockDevice();
  const usage = GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST;
  const placeholder = reusableBuffer(
    device as unknown as GPUDevice,
    undefined,
    new Float32Array(0) as BufferSource,
    usage,
  );
  const writesBefore = device.stats.writeBufferCalls;
  const reused = reusableBuffer(
    device as unknown as GPUDevice,
    placeholder,
    new Float32Array(0) as BufferSource,
    usage,
  );
  assert.equal(reused, placeholder, 'same-size empty hits the reuse path');
  assert.equal(device.stats.writeBufferCalls, writesBefore, 'no writeBuffer call for empty data');
});
