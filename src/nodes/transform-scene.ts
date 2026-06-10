import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { SceneEntity, SceneValue } from '../core/resources.js';
import { multiply, rotationX, rotationY, rotationZ, translation, type Mat4 } from '../render/mat4.js';

// Compose a column-major mat4 from (scale, rotate, translate). Matches
// `geom/transform`'s convention: scale first, then rotate X / Y / Z,
// then translate. Returned matrix M transforms a point p as
// p' = T·Rx·Ry·Rz·S · p. There's no `scaling()` helper in mat4.ts so
// we build S inline (diagonal, column-major).
function composeTransform(
  translate: readonly [number, number, number],
  rotate: readonly [number, number, number],
  scale: readonly [number, number, number],
): Mat4 {
  const S = new Float32Array(16);
  S[0] = scale[0];
  S[5] = scale[1];
  S[10] = scale[2];
  S[15] = 1;
  const T = translation(translate[0], translate[1], translate[2]);
  const Rx = rotationX(rotate[0]);
  const Ry = rotationY(rotate[1]);
  const Rz = rotationZ(rotate[2]);
  return multiply(multiply(multiply(multiply(T, Rx), Ry), Rz), S as Mat4);
}

export const transformSceneNode: NodeDef = {
  id: 'scene/transform',
  category: 'Geometry/Modifiers',
  inputs: [
    {
      name: 'scene',
      type: 'Scene',
      description: 'input scene to transform. Every entity\'s world transform is left-multiplied by the composed (scale, rotate, translate) matrix so the whole scene moves / rotates / scales as one block',
    },
    {
      name: 'translate',
      type: 'Vec3',
      default: [0, 0, 0],
      description: 'world-space offset added to every entity. Applied LAST (after scale and rotate)',
    },
    {
      name: 'rotate',
      type: 'Vec3',
      default: [0, 0, 0],
      description: 'Euler rotation in radians (X, Y, Z order). Applied to every entity around the WORLD origin — to rotate a piece around its own centre, place that piece at the origin in its subgraph, rotate here, then translate to its final position',
    },
    {
      name: 'scale',
      type: 'Vec3',
      default: [1, 1, 1],
      description: 'per-axis scale factor. Applied FIRST (before rotate and translate), centred on the world origin. Non-uniform values stretch the scene',
    },
  ],
  outputs: [
    {
      name: 'scene',
      type: 'Scene',
      description: 'the input scene with the composed transform applied to every entity. Tints, provenance, terrain / grass / water side-bands all pass through unchanged',
    },
  ],
  doc: {
    summary: 'Translate / rotate / scale an entire Scene as one block.',
    description: `
The Scene counterpart of [geom/transform](../../geom/transform). Takes
a Scene (a list of {geometry, material, transform, tint} entities) and
left-multiplies every entity's existing world transform by a new
(scale → rotate → translate) matrix, so the whole scene moves /
rotates / scales as one rigid block. Rotation order is X then Y then
Z (radians), same as geom/transform.

Use to position a hero subgraph in a parent scene: a chair subgraph
emits a Scene with the chair centred at the origin, then
scene/transform with \`translate = [2, 0, 0]\` places that whole
chair at \`(2, 0, 0)\` in the showroom — no per-entity wiring, no
per-mesh vertex churn. This is FAR cheaper than chaining a per-vertex
[geom/transform](../../geom/transform) before the scene-entity step:
this composes matrices (O(entities)) instead of moving vertices
(O(triangles)).

Rotation is around the WORLD origin (not the scene's bounding box
centre). To rotate a piece around ITS centre, build that piece
centred on the origin inside its subgraph, rotate here, then
translate. This matches the way most procedural-modeling tools
(Houdini's Object-level xform, Blender's parent-empty pattern)
handle compose-then-place.

Terrain heightfield, grass entries, water level — anything carried
on the Scene's side bands — pass through unchanged. The transform
ONLY touches entity world matrices.
`,
    sampleGraph: () => {
      const g = createGraph();
      const cube = addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 0, y: 0 },
        inputValues: { size: 1 },
      });
      // Materials are required on scene-entity — without a basecolor
      // texture + material wire, the entity's standalone preview
      // would fall back to a flat-grey debug material and the sample
      // would visually lie about what transform-scene does. Solid
      // tan reads as plain wood and renders crisply at the docs
      // preview's framing.
      const basecolor = addNode(g, 'tex/solid-color', {
        id: 'basecolor',
        position: { x: 0, y: 200 },
        inputValues: { color: [0.65, 0.5, 0.35, 1], resolution: 4 },
      });
      const material = addNode(g, 'material/pbr', {
        id: 'material',
        position: { x: 280, y: 200 },
        inputValues: { roughness: 0.6, metallic: 0 },
      });
      const entity = addNode(g, 'scene/entity', {
        id: 'entity',
        position: { x: 280, y: 0 },
      });
      const tx = addNode(g, 'scene/transform', {
        id: 'transform-scene',
        position: { x: 560, y: 0 },
        inputValues: { translate: [0, 0, 0], rotate: [-0.5, 0.5, 0.7], scale: [1, 1.2, 1.5] },
      });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
      addEdge(g, { node: basecolor.id, socket: 'texture' }, { node: material.id, socket: 'basecolor' });
      addEdge(g, { node: material.id, socket: 'material' }, { node: entity.id, socket: 'material' });
      addEdge(g, { node: entity.id, socket: 'scene' }, { node: tx.id, socket: 'scene' });
      return { graph: g, rootNodeId: 'transform-scene' };
    },
  },
  evaluate(_ctx, inputs): { scene: SceneValue } {
    const input = inputs.scene as SceneValue;
    const M = composeTransform(
      inputs.translate as [number, number, number],
      inputs.rotate as [number, number, number],
      inputs.scale as [number, number, number],
    );
    const entities: SceneEntity[] = input.entities.map((e) => ({
      ...e,
      // Compose: newWorld = M * existingWorld. Length-16 column-major.
      transform: multiply(M, e.transform as Mat4),
    }));
    // Spread first so terrain / grass / water side bands pass through,
    // then overwrite `entities`. Avoids dropping any future side band
    // we forget to mention here.
    return {
      scene: { ...input, entities },
    };
  },
};
