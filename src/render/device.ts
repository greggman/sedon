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

export async function acquireGpuDevice(): Promise<GpuDevice> {
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
