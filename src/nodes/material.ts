import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { MaterialValue, Texture2DValue } from '../core/resources.js';

export const materialNode: NodeDef = {
  id: 'material/pbr',
  category: 'Materials',
  inputs: [
    {
      name: 'basecolor',
      type: 'Texture2D',
      // [r,g,b,a] default → evaluate.ts auto-promotes to a 1×1
      // texture. Unwired basecolor inputs show an inline color
      // picker (custom-node.tsx routes Texture2D-with-color-default
      // through ColorInput); wiring a Color edge or a real
      // Texture2D works as before. Saves the user a `tex/solid-color`
      // node for the "I just want a flat colour here" case.
      default: [1, 1, 1, 1],
      description: 'albedo texture. Unwired: shows a color picker (the colour becomes a 1×1 texture). Wire any Texture2D-producing chain for patterned surfaces',
    },
    {
      name: 'roughness',
      type: 'Float',
      default: 0.5,
      description: 'surface roughness, 0 = mirror smooth, 1 = fully matte',
    },
    {
      name: 'metallic',
      type: 'Float',
      default: 0,
      description: '0 = dielectric (plastic, wood, leaf, ceramic), 1 = metal. Intermediate values are physically odd but visually useful for tarnished or partially-metallic surfaces',
    },
    {
      name: 'normal',
      type: 'Texture2D',
      optional: true,
      description: 'tangent-space normal map. Wire a [tex/normal-from-height](../../tex/normal-from-height) here to add surface micro-detail without modelling geometry',
    },
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
      description: '>0 enables hard cutout — discards fragments with basecolor alpha below this threshold and renders two-sided. 0.5 is standard foliage. 0 = opaque, back-face-culled',
    },
    {
      name: 'emissive',
      type: 'Texture2D',
      // Unwired: black colour picker. Auto-promoted to a 1×1 texture
      // by evaluate.ts, same pattern as `basecolor`. Black contributes
      // nothing to the lit output, so leaving this unwired keeps the
      // material visually identical to a no-emissive material.
      default: [0, 0, 0, 1],
      description: 'self-illumination texture, added on top of the lit output (before fog). Unwired: shows a color picker, defaults to black (no emission). Wire a texture for window patterns, neon signs, etc.',
    },
    {
      name: 'emissive_intensity',
      type: 'Float',
      default: 1,
      description: 'multiplier on the emissive sample. >1 pushes the value into HDR so bloom picks it up (good for night windows, neon signs)',
    },
  ],
  outputs: [
    {
      name: 'material',
      type: 'Material',
      description: 'PBR Cook-Torrance material ready to feed into [scene/entity](../../scene/entity)',
    },
  ],
  doc: {
    summary: 'Standard PBR (Cook-Torrance) material — basecolor + roughness + metallic + optional normal/detail maps.',
    description: `
The workhorse material node. Bundles a basecolor texture, scalar
roughness, scalar metallic, and an optional normal map into a PBR
\`MaterialValue\` ready for [scene/entity](../../scene/entity).

The detail trio (\`detail_basecolor\`, \`detail_normal\`, \`detail_scale\`,
\`detail_strength\`) addresses tile repetition: a single grass texture
stretched over a 200m terrain reads as obvious tiling at close range.
Authoring a small high-frequency greyscale overlay (the detail
basecolor) and multiplying it on at \`detail_scale\` × the base UV rate
breaks the regularity. Same for normals.

Set \`alpha_cutoff\` above 0 for foliage / chain-link / lattice — the
material switches to two-sided rendering with hard-edge cutout. 0.5 is
the standard foliage threshold; 0 (the default) leaves the material
opaque and back-face-culled.
`,
    sampleGraph: () => {
      const g = createGraph();
      // A noise-driven albedo + height → normal chain gives the
      // preview enough visual interest to actually show the PBR shading
      // working (a flat colour ball reads as a uniform circle).
      const noise = addNode(g, 'tex/perlin', {
        id: 'noise',
        position: { x: 0, y: 0 },
        inputValues: { scale: [6, 6], octaves: 3, lacunarity: 2, gain: -0.75, seed: 0, resolution: 256 },
      });
      const ramp = addNode(g, 'tex/ramp', {
        id: 'ramp',
        position: { x: 0, y: 200 },
        inputValues: {
          gradient: [
            { position: 0, color: [0.0, 0.5, 1, 1] },
            { position: 1, color: [0.9, 0.55, 0.25, 1] },
          ],
          interpolation: 0,
          resolution: 64,
        },
      });
      const basecolor = addNode(g, 'tex/colorize', {
        id: 'basecolor',
        position: { x: 280, y: 100 },
        inputValues: { resolution: 256 },
      });
      const normalMap = addNode(g, 'tex/normal-from-height', {
        id: 'normal',
        position: { x: 280, y: 320 },
        inputValues: { strength: 3, resolution: 256 },
      });
      const sphere = addNode(g, 'geom/sphere', {
        id: 'sphere',
        position: { x: 560, y: -100 },
        inputValues: { radius: 1, segments: 48, rings: 24 },
      });
      const material = addNode(g, 'material/pbr', {
        id: 'material',
        position: { x: 560, y: 200 },
        inputValues: { roughness: 0.6, metallic: 0 },
      });
      const entity = addNode(g, 'scene/entity', {
        id: 'entity',
        position: { x: 840, y: 50 },
        inputValues: {},
      });
      addEdge(g, { node: noise.id, socket: 'texture' }, { node: basecolor.id, socket: 'factor' });
      addEdge(g, { node: ramp.id, socket: 'texture' }, { node: basecolor.id, socket: 'ramp' });
      addEdge(g, { node: noise.id, socket: 'texture' }, { node: normalMap.id, socket: 'height' });
      addEdge(g, { node: basecolor.id, socket: 'texture' }, { node: material.id, socket: 'basecolor' });
      addEdge(g, { node: normalMap.id, socket: 'texture' }, { node: material.id, socket: 'normal' });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
      addEdge(g, { node: material.id, socket: 'material' }, { node: entity.id, socket: 'material' });
      return { graph: g, rootNodeId: 'entity' };
    },
  },
  evaluate(_ctx, inputs): { material: MaterialValue } {
    const normal = inputs.normal as Texture2DValue | undefined;
    const detailBasecolor = inputs.detail_basecolor as Texture2DValue | undefined;
    const detailNormal = inputs.detail_normal as Texture2DValue | undefined;
    const alphaCutoff = inputs.alpha_cutoff as number;
    const emissive = inputs.emissive as Texture2DValue;
    const emissiveIntensity = inputs.emissive_intensity as number;
    const material: MaterialValue = {
      kind: 'pbr',
      basecolor: inputs.basecolor as Texture2DValue,
      roughness: inputs.roughness as number,
      metallic: inputs.metallic as number,
      detailScale: inputs.detail_scale as number,
      detailStrength: inputs.detail_strength as number,
      emissive,
      emissiveIntensity,
    };
    if (normal) material.normal = normal;
    if (detailBasecolor) material.detailBasecolor = detailBasecolor;
    if (detailNormal) material.detailNormal = detailNormal;
    if (alphaCutoff > 0) material.alphaCutoff = alphaCutoff;
    return { material };
  },
};
