import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type {
  GrassFieldValue,
  SceneValue,
  Texture2DValue,
} from '../core/resources.js';

// core/grass — produces a camera-relative grass FIELD (not baked
// entities). The graph supplies the maps + tuning; the renderer's
// grass subsystem generates blades around the camera each frame via a
// compute cull/populate pass + drawIndexedIndirect (see
// src/render/grass.ts). Output is a Scene carrying one GrassFieldValue
// so it merges with the terrain scene through core/scene-merge.
//
// Cards are variadic (one per grass TYPE): the first card is `card_0`;
// "+ Add card" appends `card_1`, `card_2`, … All cards must share the
// same resolution + format — the renderer packs them into one
// texture-2d-array and `typeMap` (R → type index) selects per blade.
export const grassNode: NodeDef = {
  id: 'core/grass',
  category: 'Scene',
  inputs: [
    {
      name: 'heightTexture',
      type: 'Texture2D',
      description: 'heightfield texture (R = world Y in metres). Blades sample their Y from this. Typically the same texture wired into [terrain/renderer](../../terrain/renderer)',
    },
    {
      name: 'worldSize',
      type: 'Vec2',
      default: [40, 40],
      description: 'terrain XZ footprint in metres — matches the worldSize on the terrain renderer the grass sits on',
    },
    {
      name: 'density',
      type: 'Texture2D',
      description: 'R channel 0..1 — grass probability per area. 0 = bare (roads, water); use [core/path-mask](../../core/path-mask) or [core/slope-from-height](../../core/slope-from-height) inverted as the source',
    },
    {
      name: 'typeMap',
      type: 'Texture2D',
      optional: true,
      description: 'R channel → which card (type) a blade uses. Unwired ⇒ all blades draw from card_0',
    },
    {
      name: 'card_0',
      type: 'Texture2D',
      description: 'Blade card art (RGB colour, A silhouette). Use [core/grass-blades](../../core/grass-blades) or any RGBA texture you author externally',
    },
    {
      name: 'maxDistance',
      type: 'Float',
      default: 40,
      description: 'draw distance from camera (m). Beyond this no blades render — keeps cost proportional to a disc, not the whole terrain',
    },
    {
      name: 'spacing',
      type: 'Float',
      default: 0.4,
      description: 'candidate spacing (m) within the draw disc. Smaller = more candidates considered per frame = denser grass = more compute',
    },
    {
      name: 'bladeWidth',
      type: 'Float',
      default: 0.3,
      description: 'world-space width of each blade quad',
    },
    {
      name: 'bladeHeight',
      type: 'Float',
      default: 0.6,
      description: 'world-space height of each blade quad',
    },
    {
      name: 'densityScale',
      type: 'Float',
      default: 1,
      description: 'global multiplier on the density map. 0 = no grass; 0.5 = half population; >1 = oversaturate the density map',
    },
    {
      name: 'maxSlope',
      type: 'Float',
      default: 0.6,
      description: '0 = flat only … 1 = any slope. Used to suppress grass on cliffs without needing a separate mask',
    },
    {
      name: 'windStrength',
      type: 'Float',
      default: 0.08,
      description: 'maximum horizontal sway of blade tips, in world units',
    },
    {
      name: 'windSpeed',
      type: 'Float',
      default: 2,
      description: 'wind oscillation frequency — higher = quicker shimmer',
    },
    {
      name: 'baseColor',
      type: 'Color',
      default: [0.15, 0.32, 0.1, 1],
      description: 'tint multiplied onto the base of each blade card. Set near-white to use the card\'s own colours unmodified',
    },
    {
      name: 'tipColor',
      type: 'Color',
      default: [0.45, 0.62, 0.22, 1],
      description: 'tint multiplied onto the tip of each blade card',
    },
    {
      name: 'colorVariation',
      type: 'Float',
      default: 0.25,
      description: 'per-blade colour jitter, 0 = uniform field, 1 = wildly varied',
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0,
      description: 'random seed; varies placement + per-blade jitter',
    },
  ],
  outputs: [
    {
      name: 'scene',
      type: 'Scene',
      description: 'a Scene carrying the grass field as a render-time recipe (empty entities; the renderer picks up the grass sidecar). Compose with terrain via [core/scene-merge](../../core/scene-merge) and [core/output](../../core/output)',
    },
  ],
  extraInputsSpec: {
    type: 'Texture2D',
    namePrefix: 'card',
    addLabel: '+ Add card',
  },
  doc: {
    summary: 'Camera-relative grass field — bills per frame, not baked into the project.',
    description: `
Produces a grass FIELD rather than a static entity. The graph supplies
the heightfield, density map, and one or more blade cards; the
renderer's grass subsystem generates blades AROUND THE CAMERA every
frame via a compute cull/populate pass + indirect draw.

That distinction is the whole point — a 200m terrain with grass
density 1 blade per 40cm² is ~2.5 million blades, way too many to
keep in memory. Drawing them as a camera-relative disc capped at
\`maxDistance\` keeps the cost proportional to a circle, not the
whole world, so density / draw-distance trade off independently of
terrain size.

Cards are variadic. The first one is \`card_0\`; click "+ Add card"
for \`card_1\`, \`card_2\`, …. All cards share one texture-2d-array on
the GPU, and the optional \`typeMap\` (R channel → card index) selects
per blade which one to sample. Use that to mix grass types — short
clover near paths, tall meadow grass on flats, dry straw on slopes.

The output Scene has empty entities; the grass field lives in the
Scene's \`grass\` sidecar, which composes through
[core/scene-merge](../../core/scene-merge) the same way terrain does.

For card art, [core/grass-blades](../../core/grass-blades) procedurally
generates a usable tapered-blade silhouette. Density usually comes
from inverting a slope-from-height + multiplying by a path-mask so
grass stays on the flats and off the roads.
`,
    sampleGraph: () => {
      const g = createGraph();
      // Heightfield + density mask (perlin) + a grass-blades card.
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
      const density = addNode(g, 'core/perlin', {
        id: 'density',
        position: { x: 0, y: 200 },
        inputValues: { scale: [4, 4], octaves: 3, lacunarity: 2, gain: 0.5, seed: 1, resolution: 256 },
      });
      const card = addNode(g, 'core/grass-blades', {
        id: 'card',
        position: { x: 0, y: 400 },
        inputValues: {
          bladeCount: 5,
          baseColor: [0.12, 0.3, 0.08, 1],
          tipColor: [0.55, 0.78, 0.32, 1],
          width: 1,
          lean: 0.15,
          seed: 0,
          resolution: 256,
        },
      });
      const grass = addNode(g, 'core/grass', {
        id: 'grass',
        position: { x: 840, y: 100 },
        inputValues: {
          worldSize: [40, 40],
          maxDistance: 40, spacing: 0.4,
          bladeWidth: 0.3, bladeHeight: 0.6,
          densityScale: 1, maxSlope: 0.6,
          windStrength: 0.08, windSpeed: 2,
          baseColor: [0.15, 0.32, 0.1, 1],
          tipColor: [0.45, 0.62, 0.22, 1],
          colorVariation: 0.25, seed: 0,
        },
      });
      addEdge(g, { node: noise.id, socket: 'texture' }, { node: toFloat.id, socket: 'texture' });
      addEdge(g, { node: toFloat.id, socket: 'texture' }, { node: heightTex.id, socket: 'texture' });
      addEdge(g, { node: heightTex.id, socket: 'texture' }, { node: grass.id, socket: 'heightTexture' });
      addEdge(g, { node: density.id, socket: 'texture' }, { node: grass.id, socket: 'density' });
      addEdge(g, { node: card.id, socket: 'texture' }, { node: grass.id, socket: 'card_0' });
      return { graph: g, rootNodeId: 'grass' };
    },
  },
  evaluate(_ctx, inputs): { scene: SceneValue } {
    const heightTexture = inputs.heightTexture as Texture2DValue | undefined;
    const density = inputs.density as Texture2DValue | undefined;
    // Gather card_0, card_1, … in numeric order. Skips gaps/unwired.
    const cards: Texture2DValue[] = [];
    const cardKeys = Object.keys(inputs)
      .filter((k) => /^card_\d+$/.test(k))
      .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
    for (const k of cardKeys) {
      const c = inputs[k] as Texture2DValue | undefined;
      if (c && c.texture) cards.push(c);
    }
    // Without the essential GPU inputs there's nothing to plant — emit
    // an empty scene so partial wiring during authoring doesn't crash.
    if (!heightTexture || !density || cards.length === 0) {
      return { scene: { entities: [] } };
    }

    const baseColor = inputs.baseColor as [number, number, number, number];
    const tipColor = inputs.tipColor as [number, number, number, number];
    const typeMap = inputs.typeMap as Texture2DValue | undefined;

    const field: GrassFieldValue = {
      cards,
      density,
      heightTexture,
      worldSize: inputs.worldSize as [number, number],
      maxDistance: inputs.maxDistance as number,
      spacing: inputs.spacing as number,
      bladeSize: [inputs.bladeWidth as number, inputs.bladeHeight as number],
      densityScale: inputs.densityScale as number,
      maxSlope: inputs.maxSlope as number,
      windStrength: inputs.windStrength as number,
      windSpeed: inputs.windSpeed as number,
      baseColor: [baseColor[0], baseColor[1], baseColor[2]],
      tipColor: [tipColor[0], tipColor[1], tipColor[2]],
      colorVariation: inputs.colorVariation as number,
      seed: inputs.seed as number,
    };
    if (typeMap && typeMap.texture) field.typeMap = typeMap;

    return { scene: { entities: [], grass: [field] } };
  },
};
