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

    const w = field.worldSize[0];
    const d = field.worldSize[1];
    // Single quad centred on the origin. The terrain renderer's
    // chunked path uses the same convention (world centred at 0),
    // so a non-translated water plane lines up over the terrain.
    const halfW = w / 2;
    const halfD = d / 2;
    const positions = new Float32Array([
      -halfW, waterLevel, -halfD,
       halfW, waterLevel, -halfD,
       halfW, waterLevel,  halfD,
      -halfW, waterLevel,  halfD,
    ]);
    const normals = new Float32Array([
      0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,
    ]);
    const uvs = new Float32Array([
      0, 0,  1, 0,  1, 1,  0, 1,
    ]);
    // Winding chosen so the face normal points up (+Y). For the quad
    //   3—2
    //   |/|
    //   0—1
    // triangle (0,3,2) gives edges (0→3)=+Z and (0→2)=+X+Z whose cross
    // is +Y. The mirror triangle (0,2,1) shares the +Y normal. Get
    // these backwards and the whole plane is back-face culled
    // (invisible) since the camera looks down.
    const indices = new Uint32Array([0, 3, 2,  0, 2, 1]);

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
    };
    return { scene };
  },
};
