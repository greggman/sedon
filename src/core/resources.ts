import { debug } from './debug.js';

// Value types that flow on GPU-bearing sockets. These are the runtime shape of
// values for `Texture2D`, `Geometry`, and `Material`.
//
// Lifetime story: Phase 2 evaluates the graph once and holds the result for the
// program's lifetime. When re-eval lands (Phase 3) we'll add disposal hooks.

export interface Texture2DValue {
  texture: GPUTexture;
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
export type MaterialValue = PbrMaterial | TerrainSplatMaterial | TerrainMultiLayerMaterial | WaterMaterial;

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
  /**
   * When >0, enables hard alpha cutout: fragments with basecolor alpha
   * below this threshold are discarded, and the material is rendered
   * two-sided (no back-face culling) since cards are typically authored
   * to be visible from either side. 0 disables cutout (default opaque,
   * back-face-culled). Typical foliage uses ~0.5.
   */
  alphaCutoff?: number;
  /**
   * When true, the shader outputs the basecolor (× tint × detail) directly,
   * skipping all lighting math (sun, ambient, fog, shadows). Used by the
   * preview pane's flat synthesized tiles so a user authoring a texture
   * sees the texture as-is, not the lit version. Defaults to false.
   */
  unlit?: boolean;
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

/**
 * One layer in a multi-layer terrain material. Every layer carries at least
 * a basecolor; the other channels (normal, height, roughness) are optional
 * and the renderer fills missing slots with neutral defaults (flat normal,
 * mid-height 0.5, mid-roughness 0.6) so a layer wired with just albedo
 * still renders sensibly. The height channel feeds the height-weighted
 * blend in the shader — when one layer's local height beats its neighbors
 * the blend snaps to that layer rather than cross-fading, which is what
 * makes layered terrain look painted rather than dissolved.
 */
export interface TerrainLayerValue {
  albedo: Texture2DValue;
  normal?: Texture2DValue;
  height?: Texture2DValue;
  roughness?: Texture2DValue;
}

/**
 * Multi-layer terrain material. Up to 4 layers in v1, weighted per pixel by
 * an RGBA splat texture (R = layer 0 weight, G = layer 1, B = layer 2, A =
 * layer 3). Chained splat textures for N > 4 are a planned extension; the
 * shader already unrolls 4 samples so the wider variant just needs another
 * splat input and the bind-group layout to take it.
 *
 * The renderer assembles each layer's textures into texture-2d-arrays at
 * bind-group build time. All input textures for a given channel must share
 * width/height/format; mismatched sizes throw at material build (we'll add
 * blit-resize when an actual project needs it).
 */
export interface TerrainMultiLayerMaterial {
  kind: 'terrain-multi-layer';
  /** 1..4 layers. Unused slots in the pipeline get neutral defaults. */
  layers: TerrainLayerValue[];
  /**
   * RGBA splat. R/G/B/A = weight for layers 0/1/2/3 respectively, in any
   * range — the shader normalises. Mask samples at un-tiled UVs so the
   * splat pattern follows terrain shape.
   */
  splat: Texture2DValue;
  /** UV multiplier for per-layer textures (not the splat). Default [1,1]. */
  tileScale: [number, number];
  /** Single global metallic (terrain is normally 0). */
  metallic: number;
  /**
   * Strength of the height-weighted blend: 0 = pure linear (splat-only)
   * blending; higher = the layer with the highest local height wins more
   * sharply. Typical good range 4..16. Default 4.
   */
  heightBlendSharpness: number;
}

/**
 * Animated water surface material. All-procedural: no textures, no
 * uniforms beyond colour + a few wave parameters. The fragment
 * shader builds a tangent-space normal by summing scrolling sine
 * waves driven by the scene-time uniform, then runs a tight-rough
 * specular highlight against the sun for crisp glints.
 *
 * Pair with a Geometry that's a flat XZ plane at the desired water
 * Y level — the `water/plane` node does this for a whole heightfield;
 * a future `water/from-path` could ribbon a stream along a river
 * spline.
 */
export interface WaterMaterial {
  kind: 'water';
  /** Linear RGBA water colour (sRGB authored). Default deep teal. */
  color: [number, number, number, number];
  /** Strength of the wave normal perturbation. 0 = mirror-flat. */
  waveStrength: number;
  /** World-space wavelength scale. Larger = bigger swells. */
  waveScale: number;
  /** Animation speed multiplier on the wave phase. */
  waveSpeed: number;
  /** Surface roughness for the specular highlight. ~0.05 = crisp sun glint. */
  roughness: number;
  /**
   * Optional heightfield reference. When present the shader samples
   * the underlying terrain Y at each fragment and tints toward white
   * within `foamWidth` of the shoreline (where water depth → 0).
   * Without it, foam is disabled.
   */
  heightfield?: HeightfieldValue;
  /**
   * World-unit shoreline-foam falloff distance. The water surface
   * fades from foam-white at depth 0 to its base colour at depth
   * `foamWidth`. Default 1.5 m gives a believable wet-sand ring.
   */
  foamWidth: number;
}

/**
 * Chunked-LOD terrain field. Render-time recipe (no CPU mesh, no GPU
 * vertex buffers in this value — the renderer pre-builds shared
 * unit-grid meshes per LOD level once per field, then per frame:
 *   1. compute pass selects an LOD per chunk from camera distance,
 *   2. one indirect-draw per LOD bucket reads its filtered
 *      chunk-instance buffer and writes vertices in the vertex shader
 *      by sampling the heightfield directly.
 *
 * Carried on {@link SceneValue.terrain} alongside the grass field
 * collection. Authored via the `terrain/renderer` node which packages
 * a heightfield + a multi-layer terrain material + chunk/LOD
 * parameters into one of these values.
 */
export interface TerrainFieldValue {
  /** Drives the chunk vertex displacement and per-chunk height bounds. */
  heightfield: HeightfieldValue;
  /**
   * Surface material. Bound via the existing terrain-multi-layer
   * material-kind impl so the same fragment shader serves both regular
   * scene entities and chunked terrain.
   */
  material: TerrainMultiLayerMaterial;
  /** Chunk grid resolution across X and Z. Tuple of positive ints. */
  chunkCount: [number, number];
  /**
   * Number of LOD levels. Vertex count per edge at LOD i =
   * baseDivisions / 2^i (with 2-edge floor). e.g. baseDivisions 32 +
   * lodLevels 4 → 32 / 16 / 8 / 4 verts per edge at LOD 0..3.
   */
  lodLevels: number;
  /** Vertex count per edge at LOD 0. */
  baseDivisions: number;
  /**
   * Camera distance (world units) at which each chunk drops one LOD.
   * Chunk-center distance / lodDistance, clamped to [0, lodLevels-1],
   * floored = chunk's LOD index.
   */
  lodDistance: number;
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
  /**
   * Back-pointer to the graph location that produced this entity. Used by
   * GPU picking to map "the pixel under the cursor" back to a node +
   * subgraph chain + (if scattered) a specific placement, so the editor
   * can offer "Frame Selected" and "View in Canvas → …" against the
   * right thing. Optional because hand-built entities in tests and
   * default fallbacks don't need it.
   */
  provenance?: SceneEntityProvenance;
}

/**
 * One step in a chain of subgraph wrapper instances. Each entry names the
 * SPECIFIC wrapper node in its parent graph (so two instances of the same
 * subgraph stay distinguishable) plus the subgraph's definition id (for
 * displaying the subgraph's user-facing name).
 */
export interface SubgraphPathEntry {
  /** Wrapper node's id in the PARENT graph (unique per wrapper instance). */
  wrapperNodeId: string;
  /** Subgraph definition id, e.g. "oak-tree" — what `View in Canvas →` shows. */
  subgraphId: string;
}

/**
 * One step in a chain of distribute/scatter operations. A leaf-level
 * geometry placed by `instance-scene-on-points` records one of these per
 * encounter; nested distributes append, so the deepest entry is the
 * innermost (most-recent) placement. `pointTransform` is the per-point
 * world transform BEFORE composition with the source entity's transform
 * — this is what frames "this specific tree", independent of whether
 * the tree happens to author trunk-vs-leaf offsets in its local space.
 */
export interface PlacementEntry {
  distributeNodeId: string;
  pointIndex: number;
  /** Column-major 4x4. Length 16. */
  pointTransform: Float32Array;
}

export interface SceneEntityProvenance {
  /** The node whose evaluate() emitted this entity (scene-entity, distribute, merge). */
  originNodeId: string;
  /** Subgraph wrapper chain from outermost (root) to innermost. Empty at top-level. */
  subgraphPath: SubgraphPathEntry[];
  /** Distribute/scatter placements, outermost first. Empty for non-scattered entities. */
  placements: PlacementEntry[];
}

// A camera-relative grass field. Unlike SceneEntity (a static, baked
// transform), grass is NOT placed at eval time — the node graph only
// produces the *inputs* (density map, the terrain to plant on, the
// blade card art, tuning). The renderer's grass subsystem generates
// the actual blade instances every frame in a region around the
// camera: a compute pass samples `density` + `heightfield` over a
// camera-centered candidate grid, frustum/distance-culls, and
// atomic-appends survivors into an instance buffer that a
// drawIndexedIndirect renders. So this value is a *recipe*, evaluated
// at draw time against the live camera — that's what makes it scale
// to AAA blade counts without baking millions of static entities.
export interface GrassFieldValue {
  /**
   * Blade card art, one per grass TYPE. RGB = blade colour, A =
   * silhouette (alpha-cut in the grass shader). A single card may hold
   * several blades; the mesh is a cross-quad so it reads 3D from any
   * orbit angle. All cards MUST share the same resolution + format —
   * the renderer assembles them into one texture-2d-array (one layer
   * per type) so the shader can pick a blade's card by its per-blade
   * `typeIndex` without per-type draw calls. `typeMap` selects which
   * layer each blade uses.
   */
  cards: Texture2DValue[];
  /**
   * Optional per-area type selector. The R channel, scaled to
   * `[0, cards.length)`, picks which card a blade at that world XZ
   * uses. Absent ⇒ every blade is type 0. Sampled at the same world
   * XZ→UV mapping as `density`.
   */
  typeMap?: Texture2DValue;
  /**
   * Per-area density in the R channel, 0..1. Sampled at each
   * candidate's world XZ (mapped through the heightfield's worldSize).
   * A blade survives a stochastic keep-test against this value ×
   * the global `densityScale` — so painting density to 0 (roads,
   * paths, water) leaves those areas bare, and a gradient thins grass
   * out naturally.
   */
  density: Texture2DValue;
  /**
   * The terrain the grass grows on. Gives the compute pass the world
   * Y (R-channel height remapped through heightRange) and the surface
   * slope at each candidate, plus the worldSize that maps world XZ ↔
   * density/height UVs. Grass is skipped where slope exceeds `maxSlope`.
   */
  heightfield: HeightfieldValue;
  /** Max draw distance from the camera, metres. Beyond it blades are culled; alpha fades toward it. */
  maxDistance: number;
  /** Candidate-grid spacing, metres. Smaller = denser (and more compute threads). */
  spacing: number;
  /** Blade card size [width, height], metres. */
  bladeSize: [number, number];
  /** Global multiplier on the density-map keep probability. */
  densityScale: number;
  /** Surface-normal·up below this (0..1) is too steep for grass — culled. */
  maxSlope: number;
  /** Wind sway amplitude (metres of tip displacement). */
  windStrength: number;
  /** Wind oscillation speed (radians/second). Driven by the renderer's time uniform; static when animation is paused. */
  windSpeed: number;
  /** Linear-RGB tint multiplied at the blade base and tip; blended up the blade height. */
  baseColor: [number, number, number];
  tipColor: [number, number, number];
  /** Per-blade hue/value jitter, 0..1, to break up uniformity. */
  colorVariation: number;
  /** Placement hash seed — same seed ⇒ same blade layout for a given camera cell. */
  seed: number;
}

export interface SceneValue {
  entities: SceneEntity[];
  /**
   * Optional camera-relative grass fields. Kept separate from
   * `entities` because grass isn't a baked transform — it's a
   * render-time recipe (see {@link GrassFieldValue}). Undefined/empty
   * for scenes without grass, so every existing `{ entities }`
   * constructor stays valid.
   */
  grass?: GrassFieldValue[];
  /**
   * Chunked-LOD terrain fields. Each field is a render-time recipe (see
   * {@link TerrainFieldValue}); the renderer's per-frame compute pass
   * picks an LOD per chunk from the camera distance and issues an
   * indirect-draw per LOD bucket. Like {@link grass}, this is an
   * optional add-on to a Scene: missing/empty for scenes without a
   * terrain renderer.
   */
  terrain?: TerrainFieldValue[];
  /**
   * Highest world-Y of any water plane in the scene. Used by the
   * renderer to detect when the camera dips below water and apply
   * the underwater post-process tint. With multiple water planes,
   * `water/plane` and `core/scene-merge` keep this as the max so
   * the camera "submerges" the moment it falls below the tallest
   * water surface (typically the only one).
   */
  waterLevel?: number;
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

/**
 * Authored polyline through world space — the foundation for roads,
 * rivers, and other linear features.
 *
 * `samples` is a pre-sampled polyline (XYZ triples, world units),
 * dense enough that consumers can treat consecutive entries as line
 * segments without visible faceting. Producers (`path/spline`) take
 * the user's control points and tessellate them into this polyline at
 * eval time; consumers (`path/carve-heightfield`, future
 * `path/extrude`, water shoreline) only ever see samples, so the
 * spline-vs-linear-vs-Bezier distinction never leaks downstream.
 *
 * `width` is the base full-width of the path in world units —
 * carving uses width/2 as the inner half-width and falls off over
 * the additional `falloff` extent declared by the consumer.
 *
 * `count` is samples.length / 3, kept for parity with other clouds /
 * branches that expose a `count` for convenient consumer code.
 */
export interface PathValue {
  /** Pre-sampled XYZ polyline; length = count * 3. */
  samples: Float32Array;
  /** Number of sample points (samples.length / 3). */
  count: number;
  /** Full-width of the path in world units. */
  width: number;
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
  /**
   * LINEAR HDR sun colour reaching the scene = user sun colour × intensity
   * × atmospheric transmittance along the sun ray (so sunsets warm
   * automatically). Note: everything in this struct is linear now — the
   * shaders no longer srgb-linearize the lighting uniforms.
   */
  color: [number, number, number];
  /**
   * LINEAR HDR sky colour at the zenith, sampled from the same atmospheric
   * model as sky.wgsl. Surfaces facing up read this through the hemisphere
   * ambient blend.
   */
  skyColor: [number, number, number];
  /**
   * LINEAR HDR ground colour — sky-at-horizon × terrain tint × bounce
   * factor, standing in for sky light that hit terrain and bounced. Surfaces
   * facing down read this through the hemisphere ambient blend.
   */
  groundColor: [number, number, number];
  /** Scalar multiplier on the whole hemisphere term. 1.0 = derived as-is. */
  ambientIntensity: number;
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
 * Defaults match the previously hardcoded values: white sun × intensity 3
 * from (0.4, 0.8, 0.6). Sky/ground colours are derived from the sun
 * direction by `output.ts` via the atmospheric model; this default is the
 * "no graph wired" fallback for things like preview-synth.
 */
export function defaultLighting(): LightingValue {
  return {
    direction: [0.4, 0.8, 0.6],
    // Values approximate what deriveLighting returns for a noon sun with
    // white × intensity 3 and an olive terrain tint — hand-picked here to
    // avoid pulling in the atmosphere model from every defaultLighting
    // call site (this fallback is only used by preview-synth tiles and
    // tests that don't run through core/output).
    color: [10.5, 9.7, 8.8],
    skyColor: [0.12, 0.21, 0.31],
    groundColor: [0.03, 0.03, 0.02],
    ambientIntensity: 1.0,
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

/**
 * Reuse a node's previous GPUBindGroup if the resources it references
 * are reference-equal to the previous eval. Cuts the per-edit bind
 * group allocation count from "one per node per edit" to "one per node
 * total" for typical slider-scrub scenarios — every node's evaluate
 * builds a bind group whose entries are stable handles (reused via
 * `reusableTexture` / `reusableBuffer` / `getSampler`), so the
 * bindGroup itself is reusable too.
 *
 * Usage:
 *   const refs = [uniformBuffer, factor.texture, sampler];
 *   const bg = reusableBindGroup(
 *     device, prev?.__bindGroup, pipeline.getBindGroupLayout(0), refs,
 *     () => [
 *       { binding: 0, resource: uniformBuffer },
 *       { binding: 1, resource: factor.texture },
 *       { binding: 2, resource: sampler },
 *     ],
 *   );
 *   pass.setBindGroup(0, bg.bindGroup);
 *   return { texture: out, __bindGroup: bg, ... };
 *
 * The `refs` array is identity-compared against the previous eval's
 * refs. Order MUST match between calls; mismatched length forces a
 * rebuild. Same-identity refs return the SAME `ReusableBindGroup`
 * object so the eval cache's previousOutput chain stays stable.
 */
export interface ReusableBindGroup {
  bindGroup: GPUBindGroup;
  /** Identity-tracked references the bindGroup was built against. */
  refs: ReadonlyArray<unknown>;
}

export function reusableBindGroup(
  device: GPUDevice,
  previous: ReusableBindGroup | undefined,
  layout: GPUBindGroupLayout,
  refs: ReadonlyArray<unknown>,
  buildEntries: () => GPUBindGroupEntry[],
): ReusableBindGroup {
  if (previous && previous.refs.length === refs.length) {
    let same = true;
    for (let i = 0; i < refs.length; i++) {
      if (previous.refs[i] !== refs[i]) {
        same = false;
        break;
      }
    }
    if (same) return previous;
  }
  return {
    bindGroup: device.createBindGroup({ layout, entries: buildEntries() }),
    refs,
  };
}

/**
 * Acquire a GPUBuffer that's safe to fill with `data`, reusing the
 * previous buffer when the byte size already matches. Mirrors
 * `reusableTexture` for GeometryValue's vertex/index buffers: when only
 * non-shape parameters change (e.g. heightfield-to-mesh recomputing
 * displacements at the same divisions, sphere recomputing positions at
 * the same segment count), the same GPUBuffer object stays put and we
 * just queue a writeBuffer instead of allocating + destroying.
 *
 * Safe to mutate because eval-cache fingerprints include nodeId, so the
 * passed-in `previous` is the same node's prior buffer — never shared
 * across nodes whose cached output could be corrupted by the write.
 */
export function reusableBuffer(
  device: GPUDevice,
  previous: GPUBuffer | undefined,
  data: BufferSource,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  // WebGPU forbids `createBuffer({size: 0})` — it's a validation error
  // that leaves the returned buffer invalid, and any subsequent submit
  // referencing it fails the whole queue. Upstreams hit this when
  // their data dries up (zero-point scatters, empty merges, freshly-
  // added but unwired sources). Clamp to a tiny placeholder size so
  // the pipeline always has a bindable handle. Callers' indexCount /
  // vertex counts will also be 0 in that case, so the draw is a no-op
  // and the placeholder's contents never get read.
  const size = Math.max(data.byteLength, 4);
  if (previous !== undefined && previous.size === size) {
    if (data.byteLength > 0) device.queue.writeBuffer(previous, 0, data);
    return previous;
  }
  const buffer = device.createBuffer({ size, usage });
  if (data.byteLength > 0) device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

/**
 * Acquire a Texture2DValue suitable for re-rendering into. Texture-
 * producing nodes (worley, perlin, ridged-noise, etc.) call this with
 * their `ctx.previousOutput` and the dimensions they need; if the prior
 * texture matches dims+format, the same GPUTexture is returned and the
 * caller just renders new contents into it. Otherwise a fresh texture
 * is allocated. Either way the returned value has a freshly-created
 * view (cheap, always valid), so callers can use it directly in a
 * render pass.
 *
 * Safe to use because the eval cache fingerprints include the nodeId,
 * so the previous output is guaranteed to belong to THIS same node —
 * no other node references its texture, so mutating it can't corrupt
 * another node's cached output.
 */
export function reusableTexture(
  device: GPUDevice,
  previous: unknown,
  desired: {
    width: number;
    height: number;
    format: GPUTextureFormat;
    usage: GPUTextureUsageFlags;
    /**
     * Optional human-readable label. Stamped on the underlying
     * GPUTexture so WebGPU validation errors (e.g. "Destroyed
     * texture used in submit") name the producing node directly
     * — "perlin-octaves" beats "unlabeled 512x512 px" when you're
     * trying to find which subgraph's eval is the source.
     */
    label?: string;
  },
): Texture2DValue {
  const prev = previous as Partial<Texture2DValue> | undefined;
  if (
    prev !== undefined &&
    prev.texture &&
    prev.width === desired.width &&
    prev.height === desired.height &&
    prev.format === desired.format
  ) {
    return {
      texture: prev.texture,
      format: desired.format,
      width: desired.width,
      height: desired.height,
    };
  }
  debug(() => `[reusableTexture ALLOC] ${desired.width}x${desired.height} ${desired.format} ${
    prev === undefined ? 'no-prev' : !prev.texture ? 'no-prev-texture' : `dim-mismatch(${prev.width}x${prev.height}/${prev.format})`}`,
  );
  const texture = device.createTexture({
    size: [desired.width, desired.height],
    format: desired.format,
    usage: desired.usage,
    ...(desired.label !== undefined ? { label: desired.label } : {}),
  });
  return {
    texture,
    format: desired.format,
    width: desired.width,
    height: desired.height,
  };
}

// Anything ownable by the eval cache that has a .destroy() method. WebGPU
// resources (texture, buffer) match this shape; we narrow to .destroy()
// rather than the WebGPU-specific types so test environments don't need
// the real WebGPU runtime to satisfy the type.
interface Destroyable {
  destroy(): void;
}

/**
 * Walk a value emitted by a node's evaluate() and call `visit` for every
 * GPU resource we hold a destroy() handle on (textures, buffers). The
 * eval cache uses this to figure out which resources to destroy when an
 * entry is evicted — and which to KEEP because a still-live entry holds
 * the same reference.
 *
 * Recurses into discriminated unions (MaterialValue), arrays of
 * entities (SceneValue), and Heightfield's nested Texture2D. Stops at
 * scalars / plain arrays / typed arrays — those don't own GPU resources.
 */
export function walkGpuResources(
  value: unknown,
  visit: (r: Destroyable) => void,
  seen: WeakSet<object> = new WeakSet(),
  _depth = 0,
): void {
  if (!value || typeof value !== 'object') return;
  // Cycle / DAG-revisit guard. Shared references (one GPUTexture
  // referenced by multiple materials in a scene, or BranchGraphValue
  // typed-array buffers reachable through several routes) only need
  // to be walked once anyway; a cycle would crash without this.
  if (seen.has(value as object)) return;
  seen.add(value as object);
  const v = value as Record<string, unknown>;

  // Texture2DValue: { texture, format, width, height }
  if ('texture' in v && 'format' in v && 'width' in v && 'height' in v) {
    const tex = v.texture as Destroyable | undefined;
    if (tex && typeof tex.destroy === 'function') visit(tex);
    return;
  }

  // GeometryValue: { positionBuffer, normalBuffer, uvBuffer, indexBuffer, ... }
  if (
    'positionBuffer' in v &&
    'normalBuffer' in v &&
    'uvBuffer' in v &&
    'indexBuffer' in v
  ) {
    for (const key of ['positionBuffer', 'normalBuffer', 'uvBuffer', 'indexBuffer']) {
      const buf = v[key] as Destroyable | undefined;
      if (buf && typeof buf.destroy === 'function') visit(buf);
    }
    return;
  }

  // SceneValue: { entities: [{ geometry, material, transform, tint }, ...],
  //               grass?: [{ card, density, heightfield, ... }, ...] }
  if (Array.isArray(v.entities)) {
    for (const ent of v.entities as Array<Record<string, unknown>>) {
      walkGpuResources(ent.geometry, visit, seen, _depth + 1);
      walkGpuResources(ent.material, visit, seen, _depth + 1);
    }
    // Grass fields hold Texture2D / Heightfield references produced by
    // upstream texture nodes. They must be walked so sweepCache keeps
    // them alive while the grass field is in a live cache entry —
    // otherwise the density/card/height textures get destroyed out
    // from under the per-frame grass compute pass.
    if (Array.isArray(v.grass)) {
      for (const field of v.grass as Array<Record<string, unknown>>) {
        if (Array.isArray(field.cards)) {
          for (const card of field.cards) walkGpuResources(card, visit, seen, _depth + 1);
        }
        walkGpuResources(field.typeMap, visit, seen, _depth + 1);
        walkGpuResources(field.density, visit, seen, _depth + 1);
        walkGpuResources(field.heightfield, visit, seen, _depth + 1);
      }
    }
    // Same story for terrain fields: they reference the input
    // heightfield + material textures via the field value, and the
    // renderer reaches for those on every frame's draw. Sweep needs
    // to keep them alive while a terrain field is in the cache.
    if (Array.isArray(v.terrain)) {
      for (const field of v.terrain as Array<Record<string, unknown>>) {
        walkGpuResources(field.heightfield, visit, seen, _depth + 1);
        walkGpuResources(field.material, visit, seen, _depth + 1);
      }
    }
    return;
  }

  // MaterialValue (discriminated union): every kind has texture-shaped
  // fields nested inside. Recurse on those.
  if (typeof v.kind === 'string') {
    if (v.kind === 'pbr') {
      walkGpuResources(v.basecolor, visit, seen, _depth + 1);
      walkGpuResources(v.normal, visit, seen, _depth + 1);
      walkGpuResources(v.detailBasecolor, visit, seen, _depth + 1);
      walkGpuResources(v.detailNormal, visit, seen, _depth + 1);
      return;
    }
    if (v.kind === 'terrain-splat') {
      walkGpuResources(v.layerA, visit, seen, _depth + 1);
      walkGpuResources(v.layerB, visit, seen, _depth + 1);
      walkGpuResources(v.mask, visit, seen, _depth + 1);
      walkGpuResources(v.normalA, visit, seen, _depth + 1);
      walkGpuResources(v.normalB, visit, seen, _depth + 1);
      return;
    }
    if (v.kind === 'water') {
      // Only the optional heightfield carries GPU resources; the
      // colour + wave params are scalars.
      walkGpuResources(v.heightfield, visit, seen, _depth + 1);
      return;
    }
    if (v.kind === 'terrain-multi-layer') {
      // Each layer is { albedo, normal?, height?, roughness? } and the
      // splat texture is shared across them. Recurse into each layer's
      // texture slots so the cache keeps source textures alive while
      // this material is referenced.
      if (Array.isArray(v.layers)) {
        for (const layer of v.layers as Array<Record<string, unknown>>) {
          walkGpuResources(layer.albedo, visit, seen, _depth + 1);
          walkGpuResources(layer.normal, visit, seen, _depth + 1);
          walkGpuResources(layer.height, visit, seen, _depth + 1);
          walkGpuResources(layer.roughness, visit, seen, _depth + 1);
        }
      }
      walkGpuResources(v.splat, visit, seen, _depth + 1);
      return;
    }
  }

  // HeightfieldValue: { texture: Texture2DValue, worldSize, heightRange }
  if ('texture' in v && 'worldSize' in v && 'heightRange' in v) {
    walkGpuResources(v.texture, visit, seen, _depth + 1);
    return;
  }

  // NodeOutputs is a plain Record<string, unknown> — when called with a
  // node's outputs map we recurse over each socket value. The shape
  // checks above stop the recursion as soon as we hit a known
  // value type, so we can't bottom out into wrapping logic.
  // Top-level recursion: try each property.
  for (const key of Object.keys(v)) {
    const child = v[key];
    if (child && typeof child === 'object') walkGpuResources(child, visit, seen, _depth + 1);
  }
}
