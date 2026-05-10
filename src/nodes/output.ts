import type { NodeDef } from '../core/node-def.js';
import type { LightingValue } from '../core/resources.js';

// Eval root. Takes a Scene (one or more renderable entities) plus scene-level
// lighting parameters. The preview renderer pulls scene + lighting off the
// eval result and feeds them to the WebGPU pass. Lighting is bundled into a
// single `lighting` output so the renderer can update its uniforms in one go.
//
// Defaults match the previously hardcoded shader values: white sun at
// intensity 3 from (0.4, 0.8, 0.6), 0.15 grey ambient. So existing graphs
// that don't author these inputs render identically.
export const outputNode: NodeDef = {
  id: 'core/output',
  category: 'IO',
  inputs: [
    { name: 'scene', type: 'Scene' },
    {
      name: 'light_direction',
      type: 'Vec3',
      default: [0.4, 0.8, 0.6],
      description: 'world-space direction the sun comes from (will be normalized)',
    },
    {
      name: 'light_color',
      type: 'Color',
      default: [1, 1, 1, 1],
      description: 'sun RGB; alpha unused',
    },
    {
      name: 'light_intensity',
      type: 'Float',
      default: 3,
      description: 'multiplier applied to light_color; values >1 are physically reasonable',
    },
    {
      name: 'ambient',
      type: 'Color',
      default: [0.15, 0.15, 0.15, 1],
      description: 'flat ambient term added to every fragment, multiplied by albedo',
    },
    {
      name: 'sky_top',
      type: 'Color',
      default: [0.42, 0.6, 0.85, 1],
      description: 'sky color at the top of the screen (zenith); alpha ignored',
    },
    {
      name: 'sky_bottom',
      type: 'Color',
      default: [0.78, 0.82, 0.78, 1],
      description: 'sky color at the bottom of the screen (horizon); alpha ignored',
    },
    {
      name: 'fog_color',
      type: 'Color',
      default: [0.78, 0.82, 0.78, 1],
      description: 'distant fog tint; usually matched to the horizon sky color',
    },
    {
      name: 'fog_density',
      type: 'Float',
      default: 0,
      description: 'fog per world unit; 0 = no fog. ~0.02-0.2 reads as atmospheric',
    },
  ],
  outputs: [
    { name: 'scene', type: 'Scene' },
    { name: 'lighting', type: 'Lighting' },
  ],
  evaluate(_ctx, inputs) {
    const dir = inputs.light_direction as [number, number, number];
    const col = inputs.light_color as [number, number, number, number];
    const intensity = inputs.light_intensity as number;
    const amb = inputs.ambient as [number, number, number, number];
    const skyT = inputs.sky_top as [number, number, number, number];
    const skyB = inputs.sky_bottom as [number, number, number, number];
    const fogC = inputs.fog_color as [number, number, number, number];
    const fogD = inputs.fog_density as number;
    const lighting: LightingValue = {
      direction: dir,
      color: [col[0] * intensity, col[1] * intensity, col[2] * intensity],
      ambient: [amb[0], amb[1], amb[2]],
      skyTop: [skyT[0], skyT[1], skyT[2]],
      skyBottom: [skyB[0], skyB[1], skyB[2]],
      fogColor: [fogC[0], fogC[1], fogC[2]],
      fogDensity: fogD,
    };
    return { scene: inputs.scene, lighting };
  },
};
