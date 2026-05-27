import type { NodeDef } from '../core/node-def.js';
import type {
  HeightfieldValue,
  SceneValue,
  WaterMaterial,
} from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { uploadMeshToGpu } from '../render/mesh.js';

// Flat water plane sized to a heightfield's worldSize, sitting at a
// configurable Y. Emits a Scene with one entity that uses the
// `water` material kind — the renderer animates ripples + sun
// specular against the scene-time uniform.
//
// v1 is a simple horizontal plane (one quad). Future variants:
//   • per-vertex displacement for choppy seas (mesh subdivided)
//   • shoreline foam where the plane intersects terrain (sample
//     heightfield in the fragment, lerp toward white near zero
//     terrain–water height diff)
//   • water/from-path for ribbon-shaped rivers
export const waterPlaneNode: NodeDef = {
  id: 'water/plane',
  category: 'Water',
  inputs: [
    {
      name: 'heightfield',
      type: 'Heightfield',
      description: 'used for sizing — the water plane spans worldSize centred on the origin',
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
      name: 'foam_width',
      type: 'Float',
      default: 1.5,
      description: 'world-unit shoreline foam falloff. Water tints toward white within this distance of where the terrain pierces the surface',
    },
    {
      name: 'extent_scale',
      type: 'Float',
      default: 5,
      description: 'plane size as a multiple of the heightfield worldSize. Default 5 = water extends 5× past the terrain edge so you see open water to the horizon instead of a hard edge. Foam is automatically suppressed outside the heightfield bounds',
    },
    {
      name: 'subdivisions',
      type: 'Int',
      default: 64,
      description: 'minimum mesh tessellation per edge. The plane is auto-tessellated to ~2 vertices per wave wavelength so the displacement reads as waves rather than noise; this input is the floor — increase it for extra smoothness, decrease for cheaper renders',
    },
  ],
  outputs: [{ name: 'scene', type: 'Scene' }],
  evaluate(ctx, inputs): { scene: SceneValue } {
    const device = requireDevice(ctx);
    const field = inputs.heightfield as HeightfieldValue;
    const waterLevel = inputs.water_level as number;
    const color = inputs.color as [number, number, number, number];
    const waveStrength = inputs.wave_strength as number;
    const waveScale = inputs.wave_scale as number;
    const waveSpeed = inputs.wave_speed as number;
    const roughness = inputs.roughness as number;
    const foamWidth = inputs.foam_width as number;
    const extentScale = Math.max(1, inputs.extent_scale as number);
    const userSubdivisions = Math.max(1, Math.round(inputs.subdivisions as number));

    // Subdivided plane sized to extentScale × heightfield worldSize.
    // The terrain renderer centres the world on the origin; the water
    // plane is centred too, so its UV mapping shares the same world
    // axes. The extra extent gives "open water" beyond the terrain;
    // the shader detects out-of-terrain pixels via UV bounds and
    // skips foam there.
    const w = field.worldSize[0] * extentScale;
    const d = field.worldSize[1] * extentScale;
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

    const prev = ctx.previousOutput as { scene?: SceneValue } | undefined;
    const prevGeometry = prev?.scene?.entities?.[0]?.geometry;
    const geometry = uploadMeshToGpu(
      device,
      { positions, normals, uvs, indices },
      prevGeometry,
    );

    const material: WaterMaterial = {
      kind: 'water',
      color,
      waveStrength,
      waveScale,
      waveSpeed,
      roughness,
      heightfield: field,
      foamWidth,
    };

    const scene: SceneValue = {
      entities: [
        {
          geometry,
          material,
          // Identity transform — world positions baked into the
          // quad's vertices already account for water_level.
          transform: new Float32Array([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
          ]),
          tint: new Float32Array([1, 1, 1, 1]),
        },
      ],
      // Surface the water Y so the renderer can detect when the
      // camera dips below this plane and apply the underwater tint
      // in the composite pass.
      waterLevel,
    };
    return { scene };
  },
};
