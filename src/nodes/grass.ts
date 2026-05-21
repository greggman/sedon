import type { NodeDef } from '../core/node-def.js';
import type {
  GrassFieldValue,
  HeightfieldValue,
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
    { name: 'heightfield', type: 'Heightfield' },
    {
      name: 'density',
      type: 'Texture2D',
      description: 'R channel 0..1 — grass probability per area. 0 = bare (roads, water).',
    },
    {
      name: 'typeMap',
      type: 'Texture2D',
      optional: true,
      description: 'R channel → which card (type) a blade uses. Unwired ⇒ all type 0.',
    },
    { name: 'card_0', type: 'Texture2D', description: 'Blade card art (RGB colour, A silhouette).' },
    { name: 'maxDistance', type: 'Float', default: 40, description: 'Draw distance from camera (m).' },
    { name: 'spacing', type: 'Float', default: 0.4, description: 'Candidate spacing (m). Smaller = denser.' },
    { name: 'bladeWidth', type: 'Float', default: 0.3 },
    { name: 'bladeHeight', type: 'Float', default: 0.6 },
    { name: 'densityScale', type: 'Float', default: 1, description: 'Global multiplier on the density map.' },
    { name: 'maxSlope', type: 'Float', default: 0.6, description: '0 = flat only … 1 = any slope.' },
    { name: 'windStrength', type: 'Float', default: 0.08 },
    { name: 'windSpeed', type: 'Float', default: 2 },
    { name: 'baseColor', type: 'Color', default: [0.15, 0.32, 0.1, 1] },
    { name: 'tipColor', type: 'Color', default: [0.45, 0.62, 0.22, 1] },
    { name: 'colorVariation', type: 'Float', default: 0.25 },
    { name: 'seed', type: 'Float', default: 0 },
  ],
  outputs: [{ name: 'scene', type: 'Scene' }],
  extraInputsSpec: {
    type: 'Texture2D',
    namePrefix: 'card',
    addLabel: '+ Add card',
  },
  evaluate(_ctx, inputs): { scene: SceneValue } {
    const heightfield = inputs.heightfield as HeightfieldValue | undefined;
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
    if (!heightfield || !density || cards.length === 0) {
      return { scene: { entities: [] } };
    }

    const baseColor = inputs.baseColor as [number, number, number, number];
    const tipColor = inputs.tipColor as [number, number, number, number];
    const typeMap = inputs.typeMap as Texture2DValue | undefined;

    const field: GrassFieldValue = {
      cards,
      density,
      heightfield,
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
