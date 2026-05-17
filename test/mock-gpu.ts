// Minimal WebGPU mock — just enough surface for SceneRenderer + the
// material kinds + the gpu-cache helpers to run end-to-end in Node.
// Every `create*` increments a counter; every `destroy()` increments
// the matching destroyed counter and removes the object from a "live"
// set so tests can assert "no leaks" by comparing live sizes.
//
// Use:
//   const device = createMockDevice();
//   // ... wire it into createSceneRenderer(device as unknown as GPUDevice, 'rgba8unorm')
//   assert.equal(device.stats.createdBuffers - device.stats.destroyedBuffers,
//                expectedLiveBufferCount);
//
// Not a complete WebGPU implementation. We model just the methods our
// renderer actually calls; anything else throws (deliberately, so a
// silent expansion of the renderer surface fails loudly in tests).

// WebGPU usage flag constants exist on globalThis at runtime in a real
// browser. Node has none, so define enough of them to make code that
// reads `GPUBufferUsage.UNIFORM` etc. not crash. Values match the
// WebGPU spec but tests don't actually depend on the bit patterns.
const g = globalThis as unknown as {
  GPUBufferUsage: Record<string, number>;
  GPUTextureUsage: Record<string, number>;
  GPUShaderStage: Record<string, number>;
};
g.GPUBufferUsage ??= {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200,
};
g.GPUTextureUsage ??= {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
};
g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };

export interface MockGpuStats {
  createdTextures: number;
  destroyedTextures: number;
  createdBuffers: number;
  destroyedBuffers: number;
  createdSamplers: number;
  createdBindGroups: number;
  createdBindGroupLayouts: number;
  createdPipelineLayouts: number;
  createdRenderPipelines: number;
  createdShaderModules: number;
  createdCommandEncoders: number;
  writeBufferCalls: number;
  writeTextureCalls: number;
  submitCalls: number;
  /** Live (created but not destroyed) GPU resources. */
  liveTextures: Set<MockGPUTexture>;
  liveBuffers: Set<MockGPUBuffer>;
}

function freshStats(): MockGpuStats {
  return {
    createdTextures: 0,
    destroyedTextures: 0,
    createdBuffers: 0,
    destroyedBuffers: 0,
    createdSamplers: 0,
    createdBindGroups: 0,
    createdBindGroupLayouts: 0,
    createdPipelineLayouts: 0,
    createdRenderPipelines: 0,
    createdShaderModules: 0,
    createdCommandEncoders: 0,
    writeBufferCalls: 0,
    writeTextureCalls: 0,
    submitCalls: 0,
    liveTextures: new Set(),
    liveBuffers: new Set(),
  };
}

export class MockGPUTexture {
  destroyed = false;
  width: number;
  height: number;
  format: string;
  constructor(
    public descriptor: { size: number[] | { width: number; height?: number }; format: string },
    private device: MockGPUDevice,
  ) {
    const size = descriptor.size;
    if (Array.isArray(size)) {
      this.width = size[0] ?? 1;
      this.height = size[1] ?? 1;
    } else {
      this.width = size.width;
      this.height = size.height ?? 1;
    }
    this.format = descriptor.format;
    device.stats.liveTextures.add(this);
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.device.stats.liveTextures.delete(this);
    this.device.stats.destroyedTextures++;
  }
  // Some legacy paths still call .createView() — return a marker
  // object the rest of the mock surface accepts. Most code now passes
  // GPUTexture directly per the CLAUDE.md style.
  createView(): MockGPUTextureView {
    return new MockGPUTextureView(this);
  }
}

export class MockGPUTextureView {
  constructor(public texture: MockGPUTexture) {}
}

export class MockGPUBuffer {
  destroyed = false;
  size: number;
  usage: number;
  constructor(
    public descriptor: { size: number; usage: number },
    private device: MockGPUDevice,
  ) {
    this.size = descriptor.size;
    this.usage = descriptor.usage;
    device.stats.liveBuffers.add(this);
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.device.stats.liveBuffers.delete(this);
    this.device.stats.destroyedBuffers++;
  }
}

export class MockGPUSampler {
  constructor(public descriptor: unknown) {}
}

export class MockGPUBindGroupLayout {
  constructor(public descriptor: unknown) {}
}

export class MockGPUPipelineLayout {
  constructor(public descriptor: unknown) {}
}

export class MockGPUShaderModule {
  constructor(public descriptor: unknown) {}
}

export class MockGPURenderPipeline {
  constructor(
    public descriptor: unknown,
    private device: MockGPUDevice,
  ) {}
  // Auto-layout pipelines return a fresh layout per (slot, call). Our
  // code only ever calls this for slot 0; we return a stable layout
  // per slot so callers comparing references see consistency.
  private layoutCache = new Map<number, MockGPUBindGroupLayout>();
  getBindGroupLayout(index: number): MockGPUBindGroupLayout {
    let l = this.layoutCache.get(index);
    if (!l) {
      this.device.stats.createdBindGroupLayouts++;
      l = new MockGPUBindGroupLayout({ derived: true, index });
      this.layoutCache.set(index, l);
    }
    return l;
  }
}

export class MockGPUBindGroup {
  constructor(public descriptor: unknown) {}
}

export class MockGPURenderPassEncoder {
  ended = false;
  setPipeline(_p: unknown): void {}
  setBindGroup(_idx: number, _bg: unknown): void {}
  setVertexBuffer(_idx: number, _buf: unknown): void {}
  setIndexBuffer(_buf: unknown, _fmt?: unknown): void {}
  draw(_count: number, _instanceCount?: number): void {}
  drawIndexed(_count: number, _instanceCount?: number): void {}
  end(): void {
    this.ended = true;
  }
}

export class MockGPUCommandBuffer {}

export class MockGPUCommandEncoder {
  beginRenderPass(_desc: unknown): MockGPURenderPassEncoder {
    return new MockGPURenderPassEncoder();
  }
  finish(): MockGPUCommandBuffer {
    return new MockGPUCommandBuffer();
  }
}

export class MockGPUQueue {
  constructor(private device: MockGPUDevice) {}
  writeBuffer(_buf: unknown, _offset: number, _data: unknown): void {
    this.device.stats.writeBufferCalls++;
  }
  writeTexture(_dest: unknown, _data: unknown, _layout: unknown, _size: unknown): void {
    this.device.stats.writeTextureCalls++;
  }
  submit(_cmds: unknown[]): void {
    this.device.stats.submitCalls++;
  }
}

export class MockGPUDevice {
  stats: MockGpuStats = freshStats();
  queue = new MockGPUQueue(this);
  createTexture(desc: { size: number[] | { width: number; height?: number }; format: string }): MockGPUTexture {
    this.stats.createdTextures++;
    return new MockGPUTexture(desc, this);
  }
  createBuffer(desc: { size: number; usage: number }): MockGPUBuffer {
    this.stats.createdBuffers++;
    return new MockGPUBuffer(desc, this);
  }
  createSampler(desc: unknown): MockGPUSampler {
    this.stats.createdSamplers++;
    return new MockGPUSampler(desc);
  }
  createBindGroupLayout(desc: unknown): MockGPUBindGroupLayout {
    this.stats.createdBindGroupLayouts++;
    return new MockGPUBindGroupLayout(desc);
  }
  createPipelineLayout(desc: unknown): MockGPUPipelineLayout {
    this.stats.createdPipelineLayouts++;
    return new MockGPUPipelineLayout(desc);
  }
  createRenderPipeline(desc: unknown): MockGPURenderPipeline {
    this.stats.createdRenderPipelines++;
    return new MockGPURenderPipeline(desc, this);
  }
  createShaderModule(desc: unknown): MockGPUShaderModule {
    this.stats.createdShaderModules++;
    return new MockGPUShaderModule(desc);
  }
  createBindGroup(desc: unknown): MockGPUBindGroup {
    this.stats.createdBindGroups++;
    return new MockGPUBindGroup(desc);
  }
  createCommandEncoder(): MockGPUCommandEncoder {
    this.stats.createdCommandEncoders++;
    return new MockGPUCommandEncoder();
  }
}

export function createMockDevice(): MockGPUDevice {
  return new MockGPUDevice();
}
