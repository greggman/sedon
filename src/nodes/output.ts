import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { LightingValue } from '../core/resources.js';
import { deriveLighting, srgbToLinear } from '../render/sky-sample.js';

// Eval root. Takes a Scene (one or more renderable entities) plus scene-level
// lighting parameters. The preview renderer pulls scene + lighting off the
// eval result and feeds them to the WebGPU pass. Lighting is bundled into a
// single `lighting` output so the renderer can update its uniforms in one go.
//
// Sun direction is the one knob driving the whole light environment: it
// picks the sky colour (sampled at the zenith from the same atmosphere
// model as sky.wgsl), the ground bounce colour (sky-at-horizon × terrain
// tint), and the sun's atmospheric tint (transmittance along the sun ray
// → automatic sunset warming). The user's `light_color` is a multiplier on
// the derived sun colour; `terrain_tint` colours the ground bounce; and
// `ambient_intensity` scales the whole hemisphere term.
export const outputNode: NodeDef = {
  id: 'core/output',
  category: 'IO',
  inputs: [
    {
      name: 'scene',
      type: 'Scene',
      description: 'the renderable scene — entities + optional grass / terrain / waterLevel sidecars. Usually the output of [scene/merge](../../scene/merge), [water/plane](../../water/plane), or any single Scene-emitting node',
    },
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
      name: 'terrain_tint',
      type: 'Color',
      default: [0.35, 0.30, 0.22, 1],
      description: 'colour of the ground bounce that lights surfaces facing down (olive/dirt by default). The sky model picks the brightness; this only sets the tint',
    },
    {
      name: 'ambient_intensity',
      type: 'Float',
      default: 1.0,
      description: 'scales the whole hemisphere term. 1.0 = derived from the sky as-is. Raise this if shaded areas still feel too dark; lower it for more contrast',
    },
    {
      name: 'fog_color',
      type: 'Color',
      default: [0.78, 0.82, 0.78, 1],
      description: 'distant fog tint; the atmospheric sky also blends toward this near the horizon so distant geometry and sky meet at the same color',
    },
    {
      name: 'fog_density',
      type: 'Float',
      default: 0,
      description: 'fog per world unit; 0 = no fog. ~0.02-0.2 reads as atmospheric',
    },
    {
      name: 'bloom_intensity',
      type: 'Float',
      default: 0,
      description: '0 disables bloom; 0.1-0.2 reads as "real lights are bright"; 0.4+ is stylized',
    },
    {
      name: 'bloom_threshold',
      type: 'Float',
      default: 1.0,
      description: 'minimum linear-HDR luminance that contributes to bloom. Lower = more midtones glow',
    },
    {
      name: 'bloom_soft_knee',
      type: 'Float',
      default: 0.5,
      description: 'softens the bloom threshold transition; 0 = hard cutoff',
    },
  ],
  outputs: [
    {
      name: 'scene',
      type: 'Scene',
      description: 'the input scene, passed through unmodified. The preview renderer reads this and feeds it to the WebGPU draw pass',
    },
    {
      name: 'lighting',
      type: 'Lighting',
      description: 'derived lighting environment — sun colour with atmospheric tint, sky colour at zenith, ground bounce, fog, bloom. The renderer\'s lighting uniforms get one packed update from this',
    },
  ],
  doc: {
    summary: 'Eval root — Scene in, render-time lighting environment derived from a sun direction.',
    description: `
The terminal node of any graph that wants to draw something. Takes a
Scene plus the lighting parameters and emits two outputs: the Scene
itself (passed straight through) and a derived \`Lighting\` value that
bundles every uniform the renderer needs.

The whole light environment is keyed on \`light_direction\`. From it,
the node samples:
- **Sky colour at the zenith** — same atmosphere model as the editor's
  sky shader, so the preview's sky and the lit-surfaces hemisphere
  always match.
- **Ground bounce** — sky-at-horizon times \`terrain_tint\` times the
  0.4 bounce fraction. Lights surfaces facing DOWN with the colour the
  ground actually reflects.
- **Sun atmospheric tint** — transmittance along the sun ray gives you
  automatic sunset warming when the sun is low.

\`light_color\` and \`light_intensity\` multiply into the derived sun;
\`ambient_intensity\` scales the whole hemisphere term. The defaults
read as a clear midday with a hint of olive ground bounce.

Fog (\`fog_color\`, \`fog_density\`) and bloom (\`bloom_intensity\`,
\`bloom_threshold\`, \`bloom_soft_knee\`) round out the post-processing.
\`fog_density: 0\` and \`bloom_intensity: 0\` disable each pass.

Every other graph in the docs implicitly ends here — the docs preview
just doesn't show the output node itself because we route the preview
through whatever Scene-producing node makes the result visible
fastest. This sample wires a tiny scene end-to-end so you can see the
final composition: scene → output → live shaded preview with derived
sky + ground bounce.
`,
    sampleGraph: () => {
      const g = createGraph();
      // A minimal but complete render chain: textured sphere → entity
      // → output. The output's lighting derivation should produce a
      // shaded sphere with sky + ground colours visible in the
      // material.
      const sphere = addNode(g, 'geom/sphere', {
        id: 'sphere',
        position: { x: 0, y: 0 },
        inputValues: { radius: 1, segments: 32, rings: 16 },
      });
      const basecolor = addNode(g, 'tex/solid-color', {
        id: 'basecolor',
        position: { x: 0, y: 200 },
        inputValues: { color: [0.55, 0.5, 0.45, 1], resolution: 32 },
      });
      const material = addNode(g, 'material/pbr', {
        id: 'material',
        position: { x: 280, y: 200 },
        inputValues: { roughness: 0.5, metallic: 0 },
      });
      const entity = addNode(g, 'scene/entity', {
        id: 'entity',
        position: { x: 560, y: 100 },
        inputValues: {},
      });
      const output = addNode(g, 'core/output', {
        id: 'output',
        position: { x: 840, y: 100 },
        inputValues: {
          light_direction: [0.4, 0.8, 0.6],
          light_color: [1, 1, 1, 1],
          light_intensity: 3,
          terrain_tint: [0.35, 0.3, 0.22, 1],
          ambient_intensity: 1,
          fog_color: [0.78, 0.82, 0.78, 1],
          fog_density: 0,
          bloom_intensity: 0.15,
          bloom_threshold: 1,
          bloom_soft_knee: 0.5,
        },
      });
      addEdge(g, { node: basecolor.id, socket: 'texture' }, { node: material.id, socket: 'basecolor' });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
      addEdge(g, { node: material.id, socket: 'material' }, { node: entity.id, socket: 'material' });
      addEdge(g, { node: entity.id, socket: 'scene' }, { node: output.id, socket: 'scene' });
      // The Scene-producing branch is what the preview renders. Routing
      // the rootNodeId to `entity` instead of `output` means the docs
      // preview's ScenePreview ignores the output node's lighting bundle
      // (which uses its own defaults instead) — but that's fine because
      // ScenePreview supplies a default lighting environment via
      // `defaultLighting()` anyway. Reset by routing to `output` if you
      // ever wire a renderer that consumes the lighting output too.
      return { graph: g, rootNodeId: 'entity' };
    },
  },
  evaluate(_ctx, inputs) {
    const dir = inputs.light_direction as [number, number, number];
    const col = inputs.light_color as [number, number, number, number];
    const intensity = inputs.light_intensity as number;
    const tint = inputs.terrain_tint as [number, number, number, number];
    const ambIntensity = inputs.ambient_intensity as number;
    const fogC = inputs.fog_color as [number, number, number, number];
    const fogD = inputs.fog_density as number;
    const bloomI = inputs.bloom_intensity as number;
    const bloomT = inputs.bloom_threshold as number;
    const bloomK = inputs.bloom_soft_knee as number;

    // 0.4 = approximate fraction of sky irradiance that bounces back off
    // typical terrain (the rest is absorbed). Could be exposed if needed,
    // but in practice the terrain_tint colour already gives the artist
    // enough control over how dark the ground feels.
    const BOUNCE = 0.4;
    // Match the old shader's `srgb_to_linear(uniforms.lightColor)`
    // behaviour where intensity was authored as a *sRGB-encoded* scalar:
    // applying srgb→linear AFTER multiplying intensity in keeps existing
    // graphs (default intensity=3 → effective ~11.2 in linear) at the
    // same direct-sun brightness they were tuned at.
    const sunLinear: [number, number, number] = srgbToLinear([
      col[0] * intensity,
      col[1] * intensity,
      col[2] * intensity,
    ]);
    const tintLinear = srgbToLinear([tint[0], tint[1], tint[2]]);
    const derived = deriveLighting(dir, sunLinear, tintLinear, BOUNCE);
    const lighting: LightingValue = {
      direction: dir,
      color: derived.sun,
      skyColor: derived.sky,
      groundColor: derived.ground,
      ambientIntensity: ambIntensity,
      // Fog colour stays sRGB on the wire — pbr.wgsl/sky.wgsl already
      // linearize it on read; changing that would force a second shader
      // edit for no visible difference.
      fogColor: [fogC[0], fogC[1], fogC[2]],
      fogDensity: fogD,
      bloomIntensity: bloomI,
      bloomThreshold: bloomT,
      bloomSoftKnee: bloomK,
    };
    return { scene: inputs.scene, lighting };
  },
};
