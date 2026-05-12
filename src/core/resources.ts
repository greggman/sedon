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

// Materials are a discriminated union of "kinds." Each kind ships its own
// shader module + bind-group layout in the renderer (see render/materials/),
// and the renderer dispatches the right pipeline per kind. Adding a new kind
// — water, atmospheric sky, toon-shaded — means a new variant here, a new
// kind module, and a new node that produces it. The rest of the engine
// (scene graph, instance buffer, lighting/fog uniforms, sampler) stays
// untouched.
export type MaterialValue = PbrMaterial | TerrainSplatMaterial;

/**
 * Standard PBR Cook-Torrance (the only kind until we shipped this refactor).
 * Single basecolor texture + scalar roughness/metallic + optional normal map.
 *
 * Optional "detail" channel adds a high-frequency overlay sampled at a
 * tighter UV scale to break the visible tile pattern of the base textures
 * at close range. detailBasecolor is treated as a 0.5-centered greyscale
 * multiplier on albedo; detailNormal is added in tangent space to the
 * base normal. Both are no-ops when wired to a 1×1 flat placeholder, so
 * leaving the inputs unwired produces identical output to a no-detail
 * material.
 */
export interface PbrMaterial {
  kind: 'pbr';
  basecolor: Texture2DValue;
  roughness: number;
  metallic: number;
  normal?: Texture2DValue;
  detailBasecolor?: Texture2DValue;
  detailNormal?: Texture2DValue;
  /** UV multiplier for the detail textures. Higher = tighter tiling. Default 4. */
  detailScale?: number;
  /** 0 = no detail effect, 1 = full strength. Default 1. */
  detailStrength?: number;
}

/**
 * Two-layer splat-painted terrain. Each layer is a basecolor + roughness;
 * the mask's red channel selects between them per pixel (0 = layer A,
 * 1 = layer B). This is the v1 form — multi-layer (4+) and per-layer
 * normals/triplanar/heightblend are the natural extensions but out of
 * scope for the initial seam.
 */
export interface TerrainSplatMaterial {
  kind: 'terrain-splat';
  layerA: Texture2DValue;
  layerB: Texture2DValue;
  mask: Texture2DValue;
  roughnessA: number;
  roughnessB: number;
  /**
   * UV tile rate for the two basecolor layers only — the mask samples at
   * un-tiled UVs so the splat pattern still follows terrain shape across
   * the whole mesh, while grass/rock textures tile densely for close-range
   * detail. Default [1,1] preserves pre-tile-scale behavior.
   */
  tileScale: [number, number];
  /**
   * Optional tangent-space normal maps per layer. When present, they
   * provide surface detail that geometric terrain alone can't — gravel
   * scatter, grass-blade shadows, rock striations. Sampled at the same
   * tiled UV as the basecolors and blended by the splat mask before
   * perturbing the geometric normal. Missing layers fall back to flat.
   */
  normalA?: Texture2DValue;
  normalB?: Texture2DValue;
}

// A renderable scene is a list of entities. Each entity carries a geometry +
// material reference and an instance transform (a column-major 4x4 matrix).
// Entities sharing the same (geometry, material) refs get batched by the
// renderer into a single instanced draw call — N trees of one species
// referencing the same trunk-mesh + bark-material become one drawIndexed with
// instanceCount=N, each instance reading its transform from a per-instance
// vertex attribute.
//
// Forest pattern: 1 terrain entity + 100 tree-trunk entities (sharing trunk
// mesh + bark material) + 100 leaf entities (sharing leaf mesh + leaf
// material) → 3 draw calls regardless of N.
export interface SceneEntity {
  geometry: GeometryValue;
  material: MaterialValue;
  /** Column-major 4x4 world transform. Length 16. */
  transform: Float32Array;
  /**
   * Per-entity color tint multiplied into the basecolor in the fragment
   * shader. Length 4: RGBA, with alpha currently unused (no transparent
   * pass yet — kept in the slot for forward compatibility). Default is
   * [1,1,1,1] (identity). Carried through the per-instance vertex buffer
   * so it doesn't fragment batching: entities sharing (geometry, material)
   * with different tints still draw in one instanced call.
   */
  tint: Float32Array;
}

export interface SceneValue {
  entities: SceneEntity[];
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

// Scene-level lighting params produced by core/output and consumed by the
// renderer's per-frame uniforms. World-space sun direction; RGB sun color
// pre-scaled by intensity; RGB ambient added to every fragment as a flat
// fill light. The sky itself is now generated by physical Rayleigh+Mie
// scattering in sky.wgsl, driven by `direction` (sun position) — no
// authored gradient colors anymore.
export interface LightingValue {
  /** Direction toward the sun in world space. Will be normalized in the shader. */
  direction: [number, number, number];
  /** RGB sun color premultiplied by intensity. e.g. [3, 3, 3] = white at intensity 3. */
  color: [number, number, number];
  /** RGB ambient fill multiplier on albedo. Replaces the previous hardcoded 0.15. */
  ambient: [number, number, number];
  /**
   * RGB color distant geometry fades into. The sky also blends toward
   * this near the horizon so distant geometry and sky meet at the same
   * color rather than producing a visible color seam.
   */
  fogColor: [number, number, number];
  /**
   * Fog density per world unit. 0 = no fog. Useful range ~0.02-0.2 for
   * scenes with ~10-50 unit extents; larger scenes want smaller values.
   */
  fogDensity: number;
  /**
   * Bloom intensity — how much of the multi-mip pyramid blur mixes back
   * into the scene. 0 disables bloom entirely; 0.1-0.2 reads as subtle
   * "real lights are bright"; 0.4+ is dramatic / stylized.
   */
  bloomIntensity: number;
  /**
   * Bloom threshold — minimum linear-HDR luminance that contributes to
   * bloom. 1.0 means "only true HDR pixels glow"; lower it (e.g. 0.5)
   * to make mid-bright surfaces bloom too.
   */
  bloomThreshold: number;
  /**
   * Bloom soft-knee width — fades contribution in/out smoothly around
   * the threshold. 0 = hard cutoff (banding-prone); higher values
   * widen the transition.
   */
  bloomSoftKnee: number;
}

/**
 * Default lighting: white sun at intensity 3 from (0.4, 0.8, 0.6) with
 * 0.15 grey ambient. Sky color is derived from sun direction by the
 * atmosphere shader; only fog params remain explicit here.
 */
export function defaultLighting(): LightingValue {
  return {
    direction: [0.4, 0.8, 0.6],
    color: [3, 3, 3],
    ambient: [0.15, 0.15, 0.15],
    fogColor: [0.78, 0.82, 0.78],
    fogDensity: 0,
    bloomIntensity: 0.15,
    bloomThreshold: 1.0,
    bloomSoftKnee: 0.5,
  };
}

export function requireDevice(ctx: { device?: GPUDevice }): GPUDevice {
  if (!ctx.device) {
    throw new Error('this node requires a GPU device in NodeContext');
  }
  return ctx.device;
}

/** Identity tint (RGBA = 1,1,1,1) — multiplied into basecolor → no change. */
export function identityTint(): Float32Array {
  return new Float32Array([1, 1, 1, 1]);
}
