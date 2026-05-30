import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type {
  SceneValue,
  Texture2DValue,
  WaterMaterial,
} from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { uploadMeshToGpu } from '../render/mesh.js';

// Flat water plane sized to a heightfield's worldSize, sitting at a
// configurable Y. Takes an upstream Scene and APPENDS a water entity
// to it — that scene-in-scene-out shape lets the water node sit
// downstream of terrain/material/objects in the graph, and ensures
// the renderer's reflection pass sees every entity that should
// reflect in the water (not just the heightfield).
//
// Foam: the water plane samples the heightfield UV of the FIRST
// terrain field in the input scene (if any) to drive the shoreline
// fade. Scenes without a terrain field render with no foam.
export const waterPlaneNode: NodeDef = {
  id: 'water/plane',
  category: 'Water',
  inputs: [
    {
      name: 'scene',
      type: 'Scene',
      description: 'upstream scene to add the water to. The water entity is appended to the scene\'s entity list; reflection rendering sees every entity that came in through this socket',
    },
    {
      name: 'heightTexture',
      type: 'Texture2D',
      optional: true,
      description: 'optional heightfield texture (R = world Y in metres) used to drive shoreline foam (water samples terrain Y at each fragment and fades toward foam-white near the waterline). A direct wire takes precedence over any heightfield carried implicitly by an upstream `terrain/renderer` field; pass-throughs that don\'t go through terrain/renderer (e.g. texture-to-heightfield-mesh + scene-entity) need this wired explicitly. With nothing wired and no terrain field on the scene, foam is disabled',
    },
    {
      name: 'heightWorldSize',
      type: 'Vec2',
      optional: true,
      default: [40, 40],
      description: 'terrain XZ footprint in metres — paired with `heightTexture` so the water shader can map world XZ → terrain UVs. Defaulted but only consulted when `heightTexture` is wired',
    },
    {
      name: 'water_level',
      type: 'Float',
      default: 1.0,
      description: 'world-Y of the water surface. Terrain above this stays dry; terrain below gets submerged',
    },
    {
      name: 'color',
      type: 'Color',
      default: [0.1, 0.35, 0.45, 0.9],
      description: 'sRGB water colour. Alpha is currently ignored (water is rendered opaque)',
    },
    {
      name: 'wave_strength',
      type: 'Float',
      default: 0.4,
      description: 'amplitude of the procedural ripple normal; 0 = mirror flat',
    },
    {
      name: 'wave_scale',
      type: 'Float',
      default: 6,
      description: 'world-space wavelength scale. Larger = bigger swells',
    },
    {
      name: 'wave_speed',
      type: 'Float',
      default: 1.0,
      description: 'animation speed multiplier on the wave phase',
    },
    {
      name: 'roughness',
      type: 'Float',
      default: 0.05,
      description: 'specular roughness — small values give crisp sun glints',
    },
    {
      name: 'ripple_strength',
      type: 'Float',
      default: 0.15,
      description: 'amplitude of the per-fragment sub-mesh ripple layer. Adds fine surface texture and breaks up reflections; 0 disables. Independent from wave_strength because calm pools want small ripples even with no swell, and stormy seas want big swells without ripples adding noise on top',
    },
    {
      name: 'ripple_scale',
      type: 'Float',
      default: 1.0,
      description: 'world-space wavelength of the ripple layer. Typically much smaller than wave_scale — sub-metre ripples on top of metre-scale waves',
    },
    {
      name: 'ripple_speed',
      type: 'Float',
      default: 1.5,
      description: 'animation speed multiplier for the ripple layer. Usually faster than wave_speed so ripples sparkle while the main waves roll',
    },
    {
      name: 'absorption',
      type: 'Float',
      default: 0.15,
      description: 'per-world-unit Beer-Lambert absorption. Refraction attenuates toward `color` with depth — higher = water reads its tint colour in less depth. 0 disables depth tinting and refraction is just multiplied by `color` (old behaviour). Typical values: 0.05 (very clear lake), 0.15 (sea), 0.5 (murky pond)',
    },
    {
      name: 'ring_spacing',
      type: 'Float',
      default: 0.3,
      description: 'horizontal world-unit distance between successive shoreline ripple rings. With the default 0.3, rings are 30 cm apart — so you see ~3 rings packed into the first metre off shore. Smaller = denser rings; larger = a few well-separated bands. Rings hug the shoreline outline regardless of terrain slope (plateaus get no rings because slope → 0 pushes the rings into the decay tail)',
    },
    {
      name: 'ring_speed',
      type: 'Float',
      default: 0.5,
      description: 'outward expansion rate of shoreline ripple rings in world units / sec. 0 makes them static (stripes that never move). Default 0.5 = a slow ripple-like creep; bump to 2-3 for fast splash-style waves',
    },
    {
      name: 'ring_decay',
      type: 'Float',
      default: 3.0,
      description: 'how fast shoreline ripple rings fade with horizontal distance. Intensity = exp(-distance * ring_decay). Default 3.0 → 22%-intensity at 0.5 m from shore, 5% at 1 m, 1% at 1.5 m — rings tightly hug the shoreline. Lower (e.g. 1.0) lets rings carry several metres into open water; 0 disables the rings entirely',
    },
    {
      name: 'foam_width',
      type: 'Float',
      default: 1.5,
      description: 'world-unit shoreline foam falloff. Water tints toward white within this distance of where the terrain pierces the surface',
    },
    {
      name: 'foam_color',
      type: 'Color',
      default: [0.75, 0.80, 0.82, 1],
      description: 'tint + strength of the shoreline foam and animated ring ripples. RGB picks the colour (default near-white reads as sea foam; warmer = silty river edge; cooler/whiter = fresh snowmelt). ALPHA dials overall foam intensity: 1.0 = bold, 0.3 ≈ subtle suggestion, 0 = no foam at all',
    },
    {
      name: 'world_size',
      type: 'Vec2',
      default: [100, 100],
      description: 'base XZ size of the water plane in metres. If the upstream scene has a terrain field its heightfield.worldSize overrides this — that\'s the common case (water sized to match terrain). Used directly when the scene has no terrain (e.g. an object-only scene with a flat mirror)',
    },
    {
      name: 'extent_scale',
      type: 'Float',
      default: 5,
      description: 'plane size as a multiple of worldSize. Default 5 = water extends 5× past the visible terrain/object area so you see open water to the horizon instead of a hard edge. Foam is automatically suppressed outside the heightfield bounds',
    },
    {
      name: 'subdivisions',
      type: 'Int',
      default: 64,
      min: 1,
      description: 'minimum mesh tessellation per edge. The plane is auto-tessellated to ~2 vertices per wave wavelength so the displacement reads as waves rather than noise; this input is the floor — increase it for extra smoothness, decrease for cheaper renders',
    },
  ],
  outputs: [
    {
      name: 'scene',
      type: 'Scene',
      description: 'the upstream scene with a single water entity appended. waterLevel sidecar set to max(upstream, this) so the renderer\'s underwater post-process kicks in correctly when the camera dips below the surface',
    },
  ],
  doc: {
    summary: 'Append a flat water plane (with ripples, foam, refraction) to a Scene.',
    description: `
Takes a Scene in, appends one water entity, passes the scene out. The
scene-in / scene-out shape matters: it places the water DOWNSTREAM of
terrain / objects in the graph, so the renderer's reflection pass sees
every entity that should reflect in the water (not just the terrain).

The plane is auto-tessellated to roughly two vertices per
\`wave_scale\` wavelength along the longer axis, so wave displacement
actually reads as waves rather than aliasing into noise. \`subdivisions\`
acts as a floor on top of that auto-rate.

There are TWO ripple layers because real water has two too:

- **Waves** (\`wave_strength\`, \`wave_scale\`, \`wave_speed\`) — large
  swells driven by the vertex displacement, visible in silhouette.
- **Ripples** (\`ripple_strength\`, \`ripple_scale\`, \`ripple_speed\`) —
  small per-fragment normal perturbation. Independent because calm
  pools want ripples without swells, stormy seas want swells without
  ripple noise.

**Shoreline foam + rings** come from sampling the heightfield (either
the explicit \`heightfield\` input or the heightfield carried by an
upstream [terrain/renderer](../../terrain/renderer)). Where terrain
rises through the surface, water tints toward \`foam_color\` over
\`foam_width\` metres. Concentric rings expand outward at
\`ring_speed\` m/s with spacing \`ring_spacing\` and exp-decay
\`ring_decay\` — they hug the shoreline naturally because slope-to-zero
at plateaus puts the rings in the decay tail.

**Underwater absorption** uses Beer-Lambert: refraction tints by
\`color\` according to depth × \`absorption\`. 0.05 = clear lake, 0.15 = sea,
0.5 = murky pond. Setting \`absorption: 0\` reverts to flat multiply (the
pre-Beer-Lambert behaviour).

\`extent_scale\` makes the plane bigger than the terrain so you see
open water to the horizon instead of a hard rectangular edge — foam
is suppressed past the heightfield bounds automatically.
`,
    sampleGraph: () => {
      const g = createGraph();
      // Terrain → terrain/renderer scene → water plane appended on top.
      const noise = addNode(g, 'core/perlin', {
        id: 'noise',
        position: { x: 0, y: 0 },
        inputValues: { scale: [3, 3], octaves: 5, lacunarity: 2, gain: 0.5, seed: 0, resolution: 256 },
      });
      const toFloat = addNode(g, 'core/texture-convert', {
        id: 'toFloat',
        position: { x: 280, y: 0 },
        inputValues: { format: 1 },
      });
      const heightTex = addNode(g, 'core/texture-map-range', {
        id: 'heightTex',
        position: { x: 560, y: 0 },
        inputValues: { in_min: 0, in_max: 1, out_min: 0, out_max: 4, clamp: false },
      });
      const hfMesh = addNode(g, 'core/texture-to-heightfield-mesh', {
        id: 'hfMesh',
        position: { x: 840, y: 0 },
        inputValues: { worldSize: [40, 40], divisions: [64, 64], cpu_access: false },
      });
      const albedo = addNode(g, 'core/solid-color', {
        id: 'albedo',
        position: { x: 280, y: 200 },
        inputValues: { color: [0.42, 0.5, 0.35, 1], resolution: 32 },
      });
      const mat = addNode(g, 'core/material', {
        id: 'mat',
        position: { x: 560, y: 200 },
        inputValues: { roughness: 0.7, metallic: 0 },
      });
      const entity = addNode(g, 'core/scene-entity', {
        id: 'entity',
        position: { x: 840, y: 100 },
        inputValues: {},
      });
      const water = addNode(g, 'water/plane', {
        id: 'water',
        position: { x: 1400, y: 100 },
        inputValues: {
          water_level: 1.6,
          heightWorldSize: [40, 40],
          color: [0.1, 0.35, 0.45, 0.9],
          wave_strength: 0.4, wave_scale: 6, wave_speed: 1,
          roughness: 0.05,
          ripple_strength: 0.15, ripple_scale: 1, ripple_speed: 1.5,
          absorption: 0.15,
          ring_spacing: 0.3, ring_speed: 0.5, ring_decay: 3,
          foam_width: 1.5, foam_color: [0.75, 0.8, 0.82, 1],
          world_size: [40, 40], extent_scale: 5, subdivisions: 64,
        },
      });
      addEdge(g, { node: noise.id, socket: 'texture' }, { node: toFloat.id, socket: 'texture' });
      addEdge(g, { node: toFloat.id, socket: 'texture' }, { node: heightTex.id, socket: 'texture' });
      addEdge(g, { node: heightTex.id, socket: 'texture' }, { node: hfMesh.id, socket: 'texture' });
      addEdge(g, { node: albedo.id, socket: 'texture' }, { node: mat.id, socket: 'basecolor' });
      addEdge(g, { node: hfMesh.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
      addEdge(g, { node: mat.id, socket: 'material' }, { node: entity.id, socket: 'material' });
      addEdge(g, { node: entity.id, socket: 'scene' }, { node: water.id, socket: 'scene' });
      addEdge(g, { node: heightTex.id, socket: 'texture' }, { node: water.id, socket: 'heightTexture' });
      return { graph: g, rootNodeId: 'water' };
    },
  },
  evaluate(ctx, inputs): { scene: SceneValue } {
    const device = requireDevice(ctx);
    const inputScene = inputs.scene as SceneValue;
    const waterLevel = inputs.water_level as number;
    const color = inputs.color as [number, number, number, number];
    const waveStrength = inputs.wave_strength as number;
    const waveScale = inputs.wave_scale as number;
    const waveSpeed = inputs.wave_speed as number;
    const roughness = inputs.roughness as number;
    const rippleStrength = inputs.ripple_strength as number;
    const rippleScale = inputs.ripple_scale as number;
    const rippleSpeed = inputs.ripple_speed as number;
    const absorption = inputs.absorption as number;
    const ringSpacing = inputs.ring_spacing as number;
    const ringSpeed = inputs.ring_speed as number;
    const ringDecay = inputs.ring_decay as number;
    const foamWidth = inputs.foam_width as number;
    const foamColor = inputs.foam_color as [number, number, number, number];
    const worldSizeInput = inputs.world_size as [number, number];
    const extentScale = Math.max(1, inputs.extent_scale as number);
    const userSubdivisions = Math.max(1, Math.round(inputs.subdivisions as number));

    // Heightfield for shoreline foam + plane sizing. Resolution order:
    //   1. The `heightTexture` input socket if wired (covers the
    //      texture-to-heightfield-mesh + scene-entity pattern where the
    //      heightfield isn't carried on the scene).
    //   2. The first terrain field's heightTexture (terrain/renderer
    //      adds one to scene.terrain[]).
    //   3. None — foam is disabled and the plane sizes from
    //      `world_size`.
    const directHeightTex = inputs.heightTexture as Texture2DValue | undefined;
    const directHeightWorldSize = inputs.heightWorldSize as [number, number] | undefined;
    const terrainField = inputScene.terrain?.[0];
    const heightTexture = directHeightTex ?? terrainField?.heightTexture;
    const heightWorldSize = directHeightTex
      ? (directHeightWorldSize ?? worldSizeInput)
      : terrainField?.worldSize;
    const baseSize = heightWorldSize ?? worldSizeInput;

    // Subdivided plane sized to extentScale × baseSize. The terrain
    // (if any) is centred on the origin; the water plane is centred
    // too so its UV mapping shares the same world axes. The extra
    // extent gives "open water" beyond the terrain; the shader
    // detects out-of-terrain pixels via UV bounds and skips foam.
    const w = baseSize[0] * extentScale;
    const d = baseSize[1] * extentScale;
    // Auto-tessellate so wave displacement is actually visible.
    // Each wave wavelength is `waveScale` metres; we want at least
    // ~2 vertices per wavelength to avoid aliasing into noise. A
    // 1000 m plane with a 6 m wavelength therefore needs ≥333
    // verts/edge — at the original default of 64 you'd get 0.4
    // verts/wavelength and the surface reads as static even with
    // strong wind. The user-supplied `subdivisions` is treated as
    // a floor so explicit tuning still works.
    const wavelengthTarget = Math.ceil((Math.max(w, d) / Math.max(waveScale, 0.0001)) * 2);
    const subdivisions = Math.max(userSubdivisions, wavelengthTarget);
    const n = subdivisions + 1; // verts per edge
    const halfW = w / 2;
    const halfD = d / 2;
    const vertexCount = n * n;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    for (let zi = 0; zi < n; zi++) {
      for (let xi = 0; xi < n; xi++) {
        const idx = zi * n + xi;
        const u = xi / subdivisions;
        const v = zi / subdivisions;
        positions[idx * 3 + 0] = -halfW + u * w;
        positions[idx * 3 + 1] = waterLevel;
        positions[idx * 3 + 2] = -halfD + v * d;
        normals[idx * 3 + 0] = 0;
        normals[idx * 3 + 1] = 1;
        normals[idx * 3 + 2] = 0;
        uvs[idx * 2 + 0] = u;
        uvs[idx * 2 + 1] = v;
      }
    }
    // Winding: each quad's two triangles use (a, a+n, a+n+1) and
    // (a, a+n+1, a+1) where a = zi*n + xi. Cross of edges
    // (a→a+n) and (a→a+1) = +Y so culling drops the underside.
    const quadCount = subdivisions * subdivisions;
    const indices = new Uint32Array(quadCount * 6);
    let ix = 0;
    for (let zi = 0; zi < subdivisions; zi++) {
      for (let xi = 0; xi < subdivisions; xi++) {
        const a = zi * n + xi;
        indices[ix++] = a;
        indices[ix++] = a + n;
        indices[ix++] = a + n + 1;
        indices[ix++] = a;
        indices[ix++] = a + n + 1;
        indices[ix++] = a + 1;
      }
    }

    // Reuse the water mesh across re-evaluations. The water entity is
    // the LAST entry we appended last frame; find it (or fall back to
    // a fresh allocation).
    const prev = ctx.previousOutput as { scene?: SceneValue } | undefined;
    const prevWaterEntity = prev?.scene?.entities?.find(
      (e) => e.material?.kind === 'water',
    );
    const geometry = uploadMeshToGpu(
      device,
      { positions, normals, uvs, indices },
      prevWaterEntity?.geometry,
    );

    const material: WaterMaterial = {
      kind: 'water',
      color,
      waveStrength,
      waveScale,
      waveSpeed,
      roughness,
      rippleStrength,
      rippleScale,
      rippleSpeed,
      absorption,
      ringSpacing,
      ringSpeed,
      ringDecay,
      foamWidth,
      foamColor,
      ...(heightTexture && heightWorldSize
        ? { heightTexture, heightWorldSize }
        : {}),
    };

    const waterEntity = {
      geometry,
      material,
      // Identity transform — world positions baked into the quad's
      // vertices already account for water_level.
      transform: new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ]),
      tint: new Float32Array([1, 1, 1, 1]),
    };

    // Merge into the upstream scene. New waterLevel is the max of
    // the upstream's and this one's so two water planes at
    // different heights still trigger the underwater post-process
    // when the camera dips below the higher of them.
    const mergedWaterLevel = Math.max(
      inputScene.waterLevel ?? -Infinity,
      waterLevel,
    );
    const scene: SceneValue = {
      ...inputScene,
      entities: [...inputScene.entities, waterEntity],
      waterLevel: mergedWaterLevel,
    };
    return { scene };
  },
};
