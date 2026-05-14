import type { NodeDef } from '../core/node-def.js';
import type { MaterialValue, Texture2DValue } from '../core/resources.js';

export const materialNode: NodeDef = {
  id: 'core/material',
  category: 'Materials',
  inputs: [
    { name: 'basecolor', type: 'Texture2D' },
    { name: 'roughness', type: 'Float', default: 0.5 },
    { name: 'metallic', type: 'Float', default: 0 },
    { name: 'normal', type: 'Texture2D', optional: true },
    {
      name: 'detail_basecolor',
      type: 'Texture2D',
      optional: true,
      description: 'high-freq greyscale overlay multiplied onto albedo to break tile repetition at close range',
    },
    {
      name: 'detail_normal',
      type: 'Texture2D',
      optional: true,
      description: 'high-freq tangent-space normal added on top of the base normal',
    },
    {
      name: 'detail_scale',
      type: 'Float',
      default: 4,
      description: 'UV multiplier for detail samples — higher tiles tighter',
    },
    {
      name: 'detail_strength',
      type: 'Float',
      default: 1,
      description: '0 = detail off, 1 = full strength',
    },
    {
      name: 'alpha_cutoff',
      type: 'Float',
      default: 0,
      description:
        '>0 enables hard cutout — discards fragments with basecolor alpha below this threshold and renders two-sided. 0.5 is standard foliage. 0 = opaque, back-face-culled.',
    },
  ],
  outputs: [{ name: 'material', type: 'Material' }],
  evaluate(_ctx, inputs): { material: MaterialValue } {
    const normal = inputs.normal as Texture2DValue | undefined;
    const detailBasecolor = inputs.detail_basecolor as Texture2DValue | undefined;
    const detailNormal = inputs.detail_normal as Texture2DValue | undefined;
    const alphaCutoff = inputs.alpha_cutoff as number;
    const material: MaterialValue = {
      kind: 'pbr',
      basecolor: inputs.basecolor as Texture2DValue,
      roughness: inputs.roughness as number,
      metallic: inputs.metallic as number,
      detailScale: inputs.detail_scale as number,
      detailStrength: inputs.detail_strength as number,
    };
    if (normal) material.normal = normal;
    if (detailBasecolor) material.detailBasecolor = detailBasecolor;
    if (detailNormal) material.detailNormal = detailNormal;
    if (alphaCutoff > 0) material.alphaCutoff = alphaCutoff;
    return { material };
  },
};
