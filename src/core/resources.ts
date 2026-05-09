// Value types that flow on GPU-bearing sockets. These are the runtime shape of
// values for `Texture2D`, `Geometry`, and `Material`.
//
// Lifetime story: Phase 2 evaluates the graph once and holds the result for the
// program's lifetime. When re-eval lands (Phase 3) we'll add disposal hooks.

export interface Texture2DValue {
  texture: GPUTexture;
  view: GPUTextureView;
  format: GPUTextureFormat;
  width: number;
  height: number;
}

export interface GeometryValue {
  positionBuffer: GPUBuffer;
  normalBuffer: GPUBuffer;
  uvBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
}

export interface MaterialValue {
  basecolor: Texture2DValue;
  roughness: number;
  metallic: number;
  normal?: Texture2DValue;
}

export function requireDevice(ctx: { device?: GPUDevice }): GPUDevice {
  if (!ctx.device) {
    throw new Error('this node requires a GPU device in NodeContext');
  }
  return ctx.device;
}
