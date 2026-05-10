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
  // Optional CPU-side copy of the mesh data. Modifiers that need to read
  // vertices (Transform, future Subdivide, Distribute on Faces) require this
  // to be present. Compute-shader-generated geometry won't have it.
  mesh?: CpuMeshRef;
}

// Forward-declared to avoid a circular import: src/render/mesh.ts owns the
// canonical CpuMesh type. Resources only needs the shape for typing.
export interface CpuMeshRef {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

export interface MaterialValue {
  basecolor: Texture2DValue;
  roughness: number;
  metallic: number;
  normal?: Texture2DValue;
}

export interface PointCloudValue {
  positions: Float32Array; // 3 floats per point
  normals?: Float32Array;  // optional, surface normals at each point
  // Optional per-point tangents, perpendicular to the normal, in the same
  // space as positions and normals. When present, alignment-aware consumers
  // (instance-on-points) use them directly so the basis rotates with the
  // source mesh rather than anchoring to a world-up reference.
  tangents?: Float32Array;
  count: number;
}

// Per-point attributes paired with a PointCloud. `count` matches the
// PointCloud's count; `values` is row-major. Composition pattern: distribute
// produces a PointCloud, attribute generators (random-vec3-cloud,
// random-float-cloud, …) read its count and emit a parallel cloud of values,
// consumers (instance-on-points, future scatter density-mask, etc.) take
// both and pair them by index.
export interface Vec3CloudValue {
  count: number;
  values: Float32Array; // length = count * 3
}

export interface FloatCloudValue {
  count: number;
  values: Float32Array; // length = count
}

// Heightfield: a Texture2D wrapped with the world-space metadata that makes
// it a terrain primitive. The texture's R channel is unsigned height in
// [0, 1]; consumers remap to [heightRange.min, heightRange.max]. `worldSize`
// is the horizontal XZ extent (centered at origin). Modeling heightfields
// as Texture2D-plus-metadata means every Texture2D-producing node (Perlin,
// Worley, Blend, Warp, Colorize, etc.) flows naturally into terrain pipelines.
export interface HeightfieldValue {
  texture: Texture2DValue;
  worldSize: [number, number];   // (width X, depth Z)
  heightRange: [number, number]; // (min Y, max Y)
}

export function requireDevice(ctx: { device?: GPUDevice }): GPUDevice {
  if (!ctx.device) {
    throw new Error('this node requires a GPU device in NodeContext');
  }
  return ctx.device;
}
