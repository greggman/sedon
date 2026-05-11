import type { NodeDef, NodeOutputs } from '../core/node-def.js';
import type {
  GeometryValue,
  HeightfieldValue,
  MaterialValue,
  PbrMaterial,
  SceneValue,
  Texture2DValue,
} from '../core/resources.js';
import { identityTint } from '../core/resources.js';
import { identity } from '../render/mat4.js';
import { uploadMeshToGpu } from '../render/mesh.js';
import { generatePlane } from '../render/plane.js';
import { generateSphere } from '../render/sphere.js';

// Shared geometry + default material reused across every synthesized tile
// so we don't upload a new plane/sphere per output. Cached per device — a
// device replacement (rare) drops the old cache via the WeakMap so leftover
// GPU resources get GC'd along with the old device.
interface PreviewResources {
  plane: GeometryValue;
  sphere: GeometryValue;
  white: Texture2DValue;
  defaultMaterial: PbrMaterial;
}

const cache = new WeakMap<GPUDevice, PreviewResources>();

function getResources(device: GPUDevice): PreviewResources {
  const cached = cache.get(device);
  if (cached) return cached;

  const plane = uploadMeshToGpu(device, generatePlane(2, 2, 4, 4));
  const sphere = uploadMeshToGpu(device, generateSphere(1, 32, 16));

  const format: GPUTextureFormat = 'rgba8unorm';
  const texture = device.createTexture({
    size: [1, 1],
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    new Uint8Array([255, 255, 255, 255]) as BufferSource,
    { bytesPerRow: 4 },
    [1, 1],
  );
  const white: Texture2DValue = {
    texture,
    view: texture.createView(),
    format,
    width: 1,
    height: 1,
  };

  const defaultMaterial: PbrMaterial = {
    kind: 'pbr',
    basecolor: white,
    roughness: 0.5,
    metallic: 0,
  };

  const res = { plane, sphere, white, defaultMaterial };
  cache.set(device, res);
  return res;
}

export interface PreviewTileSpec {
  /** Output socket name — used as the tile's label. */
  name: string;
  /** Declared socket type, for diagnostics / tooltip. */
  type: string;
  /** Scene the renderer should draw for this tile. */
  scene: SceneValue;
}

// Turn the root node's outputs into a list of tiles, one per renderable
// output. Non-renderable types (Float, Lighting, etc.) are skipped — the
// caller treats "empty tile list" as "nothing to preview yet."
//
// Synthesis rules:
//   Scene      → use directly
//   Texture2D  → plane wearing PBR(basecolor=this)
//   Material   → sphere wearing this material
//   Geometry   → this geometry on a white default material
//   Heightfield→ plane wearing PBR(basecolor=hf.texture)
//                (treats the height map as a 2D preview; meshing the
//                heightfield would be nicer but is more invasive)
export function synthesizeTiles(
  device: GPUDevice,
  rootDef: NodeDef | undefined,
  rootOutputs: NodeOutputs,
): PreviewTileSpec[] {
  if (!rootDef) return [];
  const res = getResources(device);
  const tiles: PreviewTileSpec[] = [];
  for (const out of rootDef.outputs) {
    const value = rootOutputs[out.name];
    if (value === undefined) continue;
    const scene = synthesize(value, out.type, res);
    if (scene) tiles.push({ name: out.name, type: out.type, scene });
  }
  return tiles;
}

function synthesize(
  value: unknown,
  type: string,
  res: PreviewResources,
): SceneValue | null {
  switch (type) {
    case 'Scene':
      return value as SceneValue;
    case 'Texture2D':
      return planeWithBasecolor(value as Texture2DValue, res);
    case 'Heightfield':
      return planeWithBasecolor((value as HeightfieldValue).texture, res);
    case 'Material':
      return {
        entities: [
          {
            geometry: res.sphere,
            material: value as MaterialValue,
            transform: identity(),
            tint: identityTint(),
          },
        ],
      };
    case 'Geometry':
      return {
        entities: [
          {
            geometry: value as GeometryValue,
            material: res.defaultMaterial,
            transform: identity(),
            tint: identityTint(),
          },
        ],
      };
    default:
      return null;
  }
}

function planeWithBasecolor(
  basecolor: Texture2DValue,
  res: PreviewResources,
): SceneValue {
  const material: PbrMaterial = {
    kind: 'pbr',
    basecolor,
    roughness: 0.9,
    metallic: 0,
  };
  return {
    entities: [
      {
        geometry: res.plane,
        material,
        transform: identity(),
        tint: identityTint(),
      },
    ],
  };
}
