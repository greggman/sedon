export interface GpuContext {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}

// Device + preferred canvas format. Shared across every canvas in the
// app — each canvas configures its own GPUCanvasContext from the same
// device. Splitting "acquire device" from "configure canvas" lets the
// preview pane add/remove tiles at runtime without re-requesting an
// adapter every time.
export interface GpuDevice {
  device: GPUDevice;
  format: GPUTextureFormat;
}

// Memoized so every consumer in the app shares the same GPUDevice. A
// second Preview pane (or a popped-out window) calling this would
// otherwise request a fresh adapter + device — each device owns its
// own pipelines/buffers, so resources created against one device can't
// render on canvases configured for another. WebGPU explicitly forbids
// the mix and silently produces no output if you try.
//
// The cache holds the in-flight Promise (not the resolved value) so
// concurrent calls during initial mount coalesce onto a single request
// instead of racing two requestAdapter() calls.
let cachedAcquire: Promise<GpuDevice> | null = null;

export function acquireGpuDevice(): Promise<GpuDevice> {
  if (cachedAcquire) return cachedAcquire;
  cachedAcquire = (async () => {
    if (!navigator.gpu) {
      throw new Error('WebGPU not supported in this browser. Try Chrome 113+ or Edge.');
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('No WebGPU adapter available.');
    }
    const device = await adapter.requestDevice();
    const format = navigator.gpu.getPreferredCanvasFormat();
    return { device, format };
  })().catch((e) => {
    // Failed acquisitions shouldn't poison the cache — let a later
    // caller retry (e.g. if the user reloads after granting permission).
    cachedAcquire = null;
    throw e;
  });
  return cachedAcquire;
}

export function configureCanvas(
  canvas: HTMLCanvasElement,
  gpu: GpuDevice,
): GPUCanvasContext {
  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new Error('Failed to get WebGPU context from canvas.');
  }
  context.configure({ device: gpu.device, format: gpu.format, alphaMode: 'premultiplied' });
  return context;
}

export async function initWebGPU(canvas: HTMLCanvasElement): Promise<GpuContext> {
  const gpu = await acquireGpuDevice();
  const context = configureCanvas(canvas, gpu);
  return { device: gpu.device, context, format: gpu.format };
}
