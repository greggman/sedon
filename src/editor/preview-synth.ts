import type { NodeDef, NodeOutputs } from '../core/node-def.js';
import type {
  GeometryValue,
  HeightfieldValue,
  LightingValue,
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

  // Default material for Geometry previews — surfaces show the shape
  // (which DOES want lighting so silhouettes read), so unlit stays
  // false here.
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
  /**
   * Lighting for this tile. For `Scene` outputs we pass the host
   * lighting through unchanged so the preview matches the rendered
   * scene; for synthesized previews (Texture2D / Material / Geometry /
   * Heightfield) we force bloom off so authoring a bright texture
   * doesn't get blown out by glow.
   */
  lighting: LightingValue;
  /**
   * Flat-preview mode for asset-inspection tiles (Texture2D /
   * Heightfield). When true the renderer draws a gray checkerboard
   * backdrop and skips tonemap so authored colors display unchanged.
   * Material / Geometry / Scene tiles keep this false — they want the
   * normal lit sky.
   */
  flatPreview: boolean;
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
  baseLighting: LightingValue,
): PreviewTileSpec[] {
  if (!rootDef) return [];
  const res = getResources(device);
  // Synthesized non-Scene previews disable bloom so HDR-bright authored
  // textures don't get smeared into a glow halo that hides their color.
  const dimLighting: LightingValue = { ...baseLighting, bloomIntensity: 0 };
  // Texture2D / Heightfield previews additionally use flat-preview mode:
  // checkerboard background + tonemap off, so authored values are
  // shown WYSIWYG. Material / Geometry previews want lighting (to read
  // roughness and shape) so they stay non-flat.
  const FLAT_TYPES = new Set(['Texture2D', 'Heightfield']);
  const tiles: PreviewTileSpec[] = [];
  for (const out of rootDef.outputs) {
    const value = rootOutputs[out.name];
    const isScene = out.type === 'Scene';
    const name = out.label ?? out.name;
    const flatPreview = FLAT_TYPES.has(out.type);
    // If the output has no value (input wasn't wired, or upstream
    // failed to evaluate), still emit a tile — but with an empty
    // scene. The preview just shows the flat-checkerboard background,
    // which is the visual cue that "this output isn't producing
    // anything." The alternative — silently dropping the tile —
    // makes it hard to tell whether the output exists at all when
    // authoring a partially-wired subgraph.
    const scene =
      value === undefined ? { entities: [] } : synthesize(value, out.type, res);
    if (scene === null) {
      // The value exists but its type isn't one we know how to
      // preview (Float, Vec3, Lighting, etc.). Skip the tile rather
      // than emit a confusing blank.
      continue;
    }
    tiles.push({
      // User-visible tile caption. For subgraph outputs this is the
      // display label the user typed; for core nodes it's the
      // human-readable name (label is unset, so the fallback wins).
      name,
      type: out.type,
      scene,
      lighting: isScene ? baseLighting : dimLighting,
      flatPreview,
    });
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
      // PBR materials are authored to be lit, so a "preview the
      // material" tile keeps lighting on — that's what shows roughness
      // / metallic differences. (For a totally flat material preview
      // we'd need a separate convention.)
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

// Texture2D / Heightfield previews want WYSIWYG — the user is
// authoring a noise / colorize chain and needs to see the actual
// pixel values, not the lit version. Flag the material `unlit` so
// the PBR shader skips lighting and writes the basecolor directly.
function planeWithBasecolor(
  basecolor: Texture2DValue,
  res: PreviewResources,
): SceneValue {
  const material: PbrMaterial = {
    kind: 'pbr',
    basecolor,
    roughness: 0.9,
    metallic: 0,
    unlit: true,
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
