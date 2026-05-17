// Content-addressed cache for GPU pipeline-shaped resources. Without
// this, every `createSceneRenderer` call (one per in-node preview / per
// Preview tile / per asset thumbnail) rebuilt a dozen shader modules
// and twice as many pipelines from scratch. With caching, identical
// descriptors hit the cache and existing GPU objects are returned.
//
// Strategy:
//   • Shader modules — keyed by WGSL source. Same code → same module.
//   • Bind-group layouts — keyed by the descriptor's JSON shape. The
//     descriptor is pure data (no GPU object refs) so JSON works
//     directly.
//   • Pipeline layouts — keyed by the bind-group-layout id list.
//   • Render pipelines — keyed by the full descriptor with GPU object
//     refs replaced by their assigned ids. Two pipelines built from
//     the same module + layout + state collapse to one cache entry.
//
// Cache is per-device (WeakMap), so a device GC drops everything it
// allocated. In practice the app has one device for its lifetime, so
// these caches grow monotonically — bounded by the set of distinct
// shader/pipeline descriptors the renderer actually uses, which is
// small (≈ a dozen total across all material kinds).

// Stable id table for GPU objects we want to use as keys. WeakMap so
// the entry vanishes if the GPU object itself is GC'd.
const gpuObjectIds = new WeakMap<object, number>();
let nextGpuId = 0;
function idFor(obj: object): number {
  let id = gpuObjectIds.get(obj);
  if (id === undefined) {
    id = ++nextGpuId;
    gpuObjectIds.set(obj, id);
  }
  return id;
}

/**
 * Process-wide stable id for any GPU object. Returns the same number
 * on every call for the same instance, and a fresh number for any
 * never-seen-before object. Used outside this module for content-
 * addressed caches keyed on (texture, …) tuples — e.g. material bind
 * group caches that want "do these two MaterialValues share the same
 * basecolor texture handle?" without walking every consumer.
 */
export function gpuObjectId(obj: object): number {
  return idFor(obj);
}

// "Is this a GPU resource handle vs a plain config dictionary?" — used
// while serializing descriptors. WebGPU resource instances have their
// own class prototype (GPUShaderModule, GPUBindGroupLayout, GPUSampler,
// etc.). Plain descriptor dictionaries inherit from Object.prototype.
function isGpuObject(value: unknown): value is object {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype
  );
}

// Replace GPU object refs with `__gpu__N` markers so structurally
// identical descriptors with the same module/layout refs produce the
// same string key.
function descriptorKey(desc: unknown): string {
  return JSON.stringify(desc, (_key, value) => {
    if (isGpuObject(value)) return `__gpu__${idFor(value)}`;
    return value;
  });
}

// Per-device caches.
const moduleCaches = new WeakMap<GPUDevice, Map<string, GPUShaderModule>>();
const bglCaches = new WeakMap<GPUDevice, Map<string, GPUBindGroupLayout>>();
const plCaches = new WeakMap<GPUDevice, Map<string, GPUPipelineLayout>>();
const rpCaches = new WeakMap<GPUDevice, Map<string, GPURenderPipeline>>();
const samplerCaches = new WeakMap<GPUDevice, Map<string, GPUSampler>>();

function getMap<K, V>(
  outer: WeakMap<GPUDevice, Map<K, V>>,
  device: GPUDevice,
): Map<K, V> {
  let inner = outer.get(device);
  if (!inner) {
    inner = new Map();
    outer.set(device, inner);
  }
  return inner;
}

export function getShaderModule(device: GPUDevice, code: string): GPUShaderModule {
  const cache = getMap(moduleCaches, device);
  let mod = cache.get(code);
  if (!mod) {
    mod = device.createShaderModule({ code });
    cache.set(code, mod);
  }
  return mod;
}

export function getBindGroupLayout(
  device: GPUDevice,
  descriptor: GPUBindGroupLayoutDescriptor,
): GPUBindGroupLayout {
  const cache = getMap(bglCaches, device);
  const key = descriptorKey(descriptor);
  let layout = cache.get(key);
  if (!layout) {
    layout = device.createBindGroupLayout(descriptor);
    cache.set(key, layout);
  }
  return layout;
}

export function getPipelineLayout(
  device: GPUDevice,
  descriptor: GPUPipelineLayoutDescriptor,
): GPUPipelineLayout {
  const cache = getMap(plCaches, device);
  const key = descriptorKey(descriptor);
  let layout = cache.get(key);
  if (!layout) {
    layout = device.createPipelineLayout(descriptor);
    cache.set(key, layout);
  }
  return layout;
}

export function getRenderPipeline(
  device: GPUDevice,
  descriptor: GPURenderPipelineDescriptor,
): GPURenderPipeline {
  const cache = getMap(rpCaches, device);
  const key = descriptorKey(descriptor);
  let pipeline = cache.get(key);
  if (!pipeline) {
    pipeline = device.createRenderPipeline(descriptor);
    cache.set(key, pipeline);
  }
  return pipeline;
}

// Samplers are stateless — two callers asking for the same filter/wrap
// config can share a single GPUSampler. The descriptor is pure data
// (filters, address modes, anisotropy, etc.) so JSON-stringify is a
// safe cache key.
export function getSampler(
  device: GPUDevice,
  descriptor: GPUSamplerDescriptor = {},
): GPUSampler {
  const cache = getMap(samplerCaches, device);
  const key = descriptorKey(descriptor);
  let sampler = cache.get(key);
  if (!sampler) {
    sampler = device.createSampler(descriptor);
    cache.set(key, sampler);
  }
  return sampler;
}
